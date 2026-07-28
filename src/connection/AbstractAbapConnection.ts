import { randomUUID } from 'node:crypto';
import { Agent } from 'node:https';
import { type IAdtResponse, isNetworkError } from '@mcp-abap-adt/interfaces';
import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
} from 'axios';
import type { SapConfig } from '../config/sapConfig.js';
import type { ILogger } from '../logger.js';
import {
  ADT_SESSION_ERROR,
  type DrainResult,
  SessionLifecycle,
  sessionError,
  type WindowToken,
} from '../session/SessionLifecycle.js';
import { getCriticalSectionTimeout, getTimeout } from '../utils/timeouts.js';
import type { AbapConnection, AbapRequestOptions } from './AbapConnection.js';
import { CSRF_CONFIG, CSRF_ERROR_MESSAGES } from './csrfConfig.js';

/** What a teardown could not finish. `disconnect()` resolves with it, never throws. */
export interface TeardownReport {
  /** Labels of lock windows still open when the bounded wait gave up. */
  abandonedWindows: string[];
  /** A transport release did not complete and stays pending. */
  releasePending: boolean;
}

abstract class AbstractAbapConnection implements AbapConnection {
  /**
   * Owns session state, admission and teardown ordering. Composed rather than
   * inherited: RfcAbapConnection implements the interface directly, so the two
   * transports share this unit instead of a base class.
   */
  protected readonly lifecycle = new SessionLifecycle();

  private axiosInstance: AxiosInstance | null = null;
  private csrfToken: string | null = null;
  private cookies: string | null = null;
  private cookieStore: Map<string, string> = new Map();
  private baseUrl: string;
  private sessionId: string | null = null;
  private sessionMode: 'stateless' | 'stateful' = 'stateless';
  private skipSessionType: boolean;
  /**
   * When true, requests are treated as part of an uninterruptible critical
   * section (e.g. a lock → modify → unlock chain). In this state a short
   * per-request timeout must NOT abort the request mid-flight, because
   * aborting the socket drops the stateful ADT session and orphans the lock
   * handle (leaving the object locked and inactive). While set, makeAdtRequest
   * raises the effective timeout to CRITICAL_SECTION_TIMEOUT (a large ceiling)
   * so the request runs to completion instead of being interrupted.
   */
  private inCriticalSection = false;
  /** Reference count for nested beginCriticalSection()/endCriticalSection() pairs. */
  private criticalSectionDepth = 0;

  protected constructor(
    private readonly config: SapConfig,
    protected readonly logger: ILogger | null,
    sessionId?: string,
    options?: { skipSessionType?: boolean },
  ) {
    this.skipSessionType = options?.skipSessionType ?? false;
    // Generate sessionId (used for sap-adt-connection-id header)
    this.sessionId = sessionId || randomUUID();

    // Initialize baseUrl from config (required, will throw if invalid)
    try {
      const urlObj = new URL(config.url);
      this.baseUrl = urlObj.origin;
    } catch (error) {
      throw new Error(
        `Invalid URL in configuration: ${error instanceof Error ? error.message : error}`,
      );
    }

    this.logger?.debug(
      `AbstractAbapConnection - Session ID: ${this.sessionId.substring(0, 8)}...`,
    );
  }

  /**
   * Set session type (stateful or stateless)
   * Controls whether x-sap-adt-sessiontype: stateful header is added to requests
   * - stateful: SAP maintains session state between requests (locks, transactions)
   * - stateless: Each request is independent
   *
   * When skipSessionType is enabled (via constructor options), this is a no-op:
   * the x-sap-adt-sessiontype header will never be sent. This is needed for
   * older BASIS versions (e.g. 7.40) where the stateful header causes locks
   * to be stored in ABAP session memory instead of the global enqueue table,
   * resulting in HTTP 423 on subsequent PUT requests.
   */
  setSessionType(type: 'stateful' | 'stateless'): void {
    if (this.skipSessionType) {
      return;
    }
    this.sessionMode = type;
    this.logger?.debug(`Session type set to: ${type}`, {
      sessionId: this.sessionId?.substring(0, 8),
    });
  }

  /**
   * Get current session mode
   */
  getSessionMode(): 'stateless' | 'stateful' {
    return this.sessionMode;
  }

  /**
   * Enter an uninterruptible critical section.
   *
   * Call this BEFORE acquiring a lock (and pair it with endCriticalSection()
   * in a finally, AFTER unlocking). While in a critical section, a short
   * per-request timeout is not applied — makeAdtRequest uses a large ceiling
   * (CRITICAL_SECTION_TIMEOUT, env SAP_TIMEOUT_CRITICAL) instead — so a slow
   * PUT/activate/unlock is not aborted mid-flight. Aborting mid-flight tears
   * down the socket, which drops the stateful ADT session and orphans the
   * lock handle, leaving the object locked and inactive.
   *
   * Nesting is reference-counted so nested begin/end pairs are safe.
   */
  beginCriticalSection(): void {
    this.criticalSectionDepth++;
    this.inCriticalSection = true;
    this.logger?.debug(
      `Entered critical section (depth ${this.criticalSectionDepth})`,
    );
  }

  /**
   * Leave the uninterruptible critical section. See beginCriticalSection().
   * Safe to call more times than begin (clamped at 0). Normal per-request
   * timeouts resume once the outermost section ends.
   */
  endCriticalSection(): void {
    if (this.criticalSectionDepth > 0) {
      this.criticalSectionDepth--;
    }
    if (this.criticalSectionDepth === 0) {
      this.inCriticalSection = false;
    }
    this.logger?.debug(
      `Left critical section (depth ${this.criticalSectionDepth})`,
    );
  }

  /**
   * Whether requests are currently in an uninterruptible critical section.
   */
  isInCriticalSection(): boolean {
    return this.inCriticalSection;
  }

  /**
   * Set session ID
   * @deprecated Session ID is auto-generated, use setSessionType() to control session mode
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
    this.logger?.debug(`Session ID set to: ${sessionId.substring(0, 8)}...`);
  }

  /**
   * Get current session ID
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  getConfig(): SapConfig {
    return this.config;
  }

  /**
   * Establish the session for this auth type. Implementations do their own auth
   * preparation and fetch the CSRF token; connect() owns everything around it.
   */
  protected abstract establishSession(): Promise<void>;

  /**
   * Establishes the session, once, under the lifecycle.
   *
   * Idempotent, and concurrent callers share one establishment: the transition
   * joins the tail of its own kind. A teardown requested while establishment
   * was in flight means the caller asked to stop, so usability is NOT published
   * and what was established is released — otherwise a slow connect would hand
   * back a session someone had already discarded.
   */
  async connect(): Promise<void> {
    // Captured HERE, not inside the transition: the callback runs when this
    // reaches the front of the queue, by which time a teardown the caller
    // requested afterwards has already bumped the epoch — and comparing it
    // against itself would let the connect publish a session the caller had
    // asked to stop. The baseline is "when the caller asked to connect".
    const baselineEpoch = this.lifecycle.teardownEpoch;
    await this.lifecycle.transition('connect', async () => {
      if (this.lifecycle.connected) return;

      await this.establishAndCommit(baselineEpoch);
    });
  }

  /**
   * Tears the session down. Never throws: the report says what did not finish
   * rather than failing. Sends no ADT session-close — see the design's D2.
   */
  async disconnect(): Promise<TeardownReport> {
    this.lifecycle.beginTeardown({ origin: 'caller', sessionLost: false });
    // The report travels THROUGH the transition, so a joining caller gets the
    // same one. Building it outside would leave every caller but the first
    // reporting an empty teardown — the abandoned locks reported to nobody.
    return this.lifecycle.transition('disconnect', async () => {
      const drained: DrainResult = await this.lifecycle.drain();
      this.clearSessionState();
      this.lifecycle.markDisconnected();
      return {
        abandonedWindows: drained.abandonedWindows,
        releasePending: false,
      };
    });
  }

  isConnected(): boolean {
    return this.lifecycle.connected;
  }

  /** Fingerprint of the SAP-side session; null when nothing is tracked. */
  getSessionIdentity(): string | null {
    return this.lifecycle.identity;
  }

  /** Opens a lock window. See the design: a lock outlives its request. */
  beginWindow(label: string): WindowToken {
    return this.lifecycle.beginWindow(label);
  }

  endWindow(token: WindowToken): void {
    this.lifecycle.endWindow(token);
  }

  /**
   * Discards the session at a caller's request: cancels queued recoveries and
   * queues the cleanup rather than tearing down under a live request.
   */
  reset(): void {
    this.lifecycle.beginTeardown({ origin: 'caller', sessionLost: true });
    void this.lifecycle.transition('cleanup', async () => {
      await this.lifecycle.drain();
      this.clearSessionState();
      this.lifecycle.markDisconnected();
    });
  }

  /**
   * Re-establishes the session for a request that is recovering from a
   * credential renewal, then lets that request retry.
   *
   * Runs as its own `recover` transition, which never joins another: each
   * recovery carries the baseline of its own request. It yields to a caller's
   * teardown — if the epoch moved since `baselineEpoch`, someone asked to stop
   * while this was being prepared, and a retry must not resurrect a session
   * they discarded.
   *
   * The transition queues behind the cleanup that the renewal itself raised, so
   * it never re-establishes on top of stale transport state.
   */
  protected async recoverSession(baselineEpoch: number): Promise<void> {
    await this.lifecycle.transition('recover', async () => {
      await this.establishAndCommit(baselineEpoch);
    });
  }

  /**
   * Establishes a session and publishes it — but only if nobody asked to stop
   * meanwhile.
   *
   * The epoch is checked BEFORE, so a teardown already requested costs no round
   * trip, and AFTER, because establishment takes time and a caller can ask to
   * stop during it. Checking only before is the defect this exists to prevent:
   * markConnected() would then clear the teardown state and hand back a session
   * the caller had already discarded.
   *
   * Shared by connect() and recoverSession() rather than written twice —
   * the two drifted apart once already, and a third caller would drift again.
   */
  private async establishAndCommit(baselineEpoch: number): Promise<void> {
    if (this.lifecycle.teardownEpoch !== baselineEpoch) {
      throw sessionError(
        ADT_SESSION_ERROR.NOT_CONNECTED,
        'Establishment abandoned: a teardown was requested for this connection',
      );
    }

    await this.establishSession();

    if (this.lifecycle.teardownEpoch !== baselineEpoch) {
      // Abandon WITHOUT clearing: the teardown that bumped the epoch is already
      // queued, and it clears after draining. Clearing here would pull cookies,
      // the CSRF token and the axios instance out from under a request that is
      // still in flight — breaking the guarantee this whole change rests on,
      // from inside the guard meant to protect it.
      throw sessionError(
        ADT_SESSION_ERROR.NOT_CONNECTED,
        'Establishment abandoned: a teardown was requested while it was in flight',
      );
    }

    // establishSession() throws on failure, so reaching here means a session
    // exists. There is no third outcome: no "connected but unusable", no
    // resolved promise over an empty jar.
    this.lifecycle.markConnected(this.sessionFingerprint());
  }

  /** The teardown epoch, for a recovery to capture before it starts. */
  protected get teardownEpoch(): number {
    return this.lifecycle.teardownEpoch;
  }

  /**
   * Raises a session-lost teardown from inside request handling.
   *
   * There are exactly three things that can cost us the ABAP session, and they
   * were found one at a time precisely because they were written apart. They go
   * through here so a fourth joins the list instead of inventing its own
   * sequence:
   *
   *   - the credential was renewed (the injected auth says so);
   *   - the server says the session is gone (a dead-session response);
   *   - the tracked cookie changed under us while a lock was held.
   *
   * `internal` origin, so it does not cancel the recovery that raised it, and
   * `sessionLost`, so admission shuts at once and the identity is dropped
   * immediately — a later comparison must see the change, and on a dead session
   * the cookie is unchanged, so only the state can tell.
   *
   * Does not await: it is called from inside a request, and the queued cleanup
   * drains that very request.
   */
  protected raiseSessionLost(reason: string): void {
    this.logger?.warn(`Session lost: ${reason}`);
    this.lifecycle.beginTeardown({ origin: 'internal', sessionLost: true });
    void this.lifecycle.transition('cleanup', async () => {
      await this.lifecycle.drain();
      this.clearSessionState();
      this.lifecycle.markDisconnected();
    });
  }

  /** The credential-renewal raiser; see raiseSessionLost(). */
  protected discardSession(): void {
    this.raiseSessionLost('the credential backing it was renewed');
  }

  /**
   * Acts on what a response said about the session identity.
   *
   * A replacement is fatal only while a lock is held — and "a lock is held"
   * means an open window, not `sessionMode`: a mode flag cannot represent
   * windows, another handler can flip it back, and a batch never sets it.
   * With no lock held the same replacement is not a loss: nothing was being
   * held, so the new identity simply becomes the current one.
   */
  private applyIdentityPolicy(
    classification: 'unchanged' | 'established' | 'replaced',
  ): void {
    if (classification !== 'replaced') return;

    if (this.lifecycle.openWindows.length === 0) {
      this.logger?.debug(
        'Session identity changed with no lock held; continuing on the new one',
      );
      return;
    }

    this.raiseSessionLost('the session cookie changed while a lock was held');
    throw sessionError(
      ADT_SESSION_ERROR.SESSION_REPLACED,
      'The SAP session was replaced while a lock was held; the lock handle is dead',
    );
  }

  /**
   * Whether the server is telling us the session it was given no longer exists.
   *
   * The E19 shape was HTTP 400 with "Session not found", answered in ~60 ms
   * with the cookie present — which is why identity comparison cannot see this:
   * the cookie, and therefore the fingerprint, is completely unchanged. The
   * exact match is landscape-specific and is one of the live probes this design
   * still owes.
   */
  private isDeadSessionResponse(error: unknown): boolean {
    if (!(error instanceof AxiosError) || !error.response) return false;
    if (error.response.status !== 400) return false;

    const text = [
      error.response.statusText,
      typeof error.response.data === 'string' ? error.response.data : '',
    ]
      .join(' ')
      .toLowerCase();
    return text.includes('session not found');
  }

  /** Drops everything that described the session. Not a lifecycle transition. */
  private clearSessionState(): void {
    if (this.axiosInstance) {
      this.axiosInstance.interceptors.request.clear();
      this.axiosInstance.interceptors.response.clear();
      this.axiosInstance = null;
    }
    this.csrfToken = null;
    this.cookies = null;
    this.cookieStore.clear();
    // Note: baseUrl is not reset as it's derived from immutable config
  }

  /**
   * The session-bearing cookies, and only those.
   *
   * `sap-XSRF_*` is excluded deliberately: it changes on a token refresh WITHIN
   * the same session, so including it would report an ordinary refresh as a new
   * session and fail exactly where nothing is wrong. `sap-usercontext` is ours,
   * overwritten on every response.
   */
  protected sessionFingerprint(): Map<string, string> {
    const fingerprint = new Map<string, string>();
    for (const [name, value] of this.cookieStore) {
      if (name.startsWith('SAP_SESSIONID')) {
        fingerprint.set(name, value);
      }
    }
    return fingerprint;
  }

  async getBaseUrl(): Promise<string> {
    return this.baseUrl;
  }

  async getAuthHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};

    if (this.config.client) {
      headers['X-SAP-Client'] = this.config.client;
    }

    const authorization = this.buildAuthorizationHeader();
    if (authorization) {
      headers.Authorization = authorization;
    }

    return headers;
  }

  async makeAdtRequest<T = any, D = any>(
    options: AbapRequestOptions,
  ): Promise<IAdtResponse<T, D>> {
    // Admission first, synchronously, before any await: the check and the
    // count must happen in one step, or a request could be admitted and still
    // be invisible to a teardown draining at that instant. Throws
    // NOT_CONNECTED when the caller never connected, or when a teardown has
    // shut the door.
    const lease = this.lifecycle.admitRequest();
    try {
      return await this.performRequest<T, D>(options);
    } finally {
      lease.release();
    }
  }

  private async performRequest<T = any, D = any>(
    options: AbapRequestOptions,
  ): Promise<IAdtResponse<T, D>> {
    const {
      url: endpoint,
      method,
      timeout,
      data,
      params,
      headers: customHeaders,
    } = options;
    const normalizedMethod = method.toUpperCase();

    // Build full URL: baseUrl + endpoint
    const requestUrl = `${this.baseUrl}${endpoint}`;

    // Try to ensure CSRF token is available for POST/PUT/DELETE, but don't fail if it can't be fetched
    // The retry logic will handle CSRF token errors automatically
    if (
      normalizedMethod === 'POST' ||
      normalizedMethod === 'PUT' ||
      normalizedMethod === 'DELETE'
    ) {
      if (!this.csrfToken) {
        try {
          await this.ensureFreshCsrfToken(requestUrl);
        } catch (error) {
          // If CSRF token can't be fetched upfront, continue anyway
          // The retry logic will handle CSRF token errors automatically
          this.logger?.debug(
            `[DEBUG] BaseAbapConnection - Could not fetch CSRF token upfront, will retry on error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    // Start with default Accept header
    const requestHeaders: Record<string, string> = {};
    if (!customHeaders || !customHeaders.Accept) {
      requestHeaders.Accept =
        'application/xml, application/json, text/plain, */*';
    }

    // Add custom headers (but they won't override auth/cookies)
    if (customHeaders) {
      Object.assign(requestHeaders, customHeaders);
    }

    // ALWAYS add sap-adt-connection-id header (connectionId is sent for ALL session types)
    if (this.sessionId) {
      requestHeaders['sap-adt-connection-id'] = this.sessionId;
    }

    // Add stateful session headers if stateful mode is enabled
    if (this.sessionMode === 'stateful') {
      requestHeaders['x-sap-adt-sessiontype'] = 'stateful';
      requestHeaders['sap-adt-request-id'] = randomUUID().replace(/-/g, '');
      requestHeaders['X-sap-adt-profiling'] = 'server-time';
    }

    // Add auth headers (these MUST NOT be overridden)
    Object.assign(requestHeaders, await this.getAuthHeaders());

    if (
      (normalizedMethod === 'POST' ||
        normalizedMethod === 'PUT' ||
        normalizedMethod === 'DELETE') &&
      this.csrfToken
    ) {
      requestHeaders['x-csrf-token'] = this.csrfToken;
    }

    // Add cookies LAST (MUST NOT be overridden by custom headers)
    if (this.cookies) {
      requestHeaders.Cookie = this.cookies;
      this.logger?.debug(
        `[DEBUG] BaseAbapConnection - Adding cookies to request (first 100 chars): ${this.cookies.substring(0, 100)}...`,
      );
    } else {
      this.logger?.debug(
        `[DEBUG] BaseAbapConnection - NO COOKIES available for this request to ${requestUrl}`,
      );
    }

    if ((normalizedMethod === 'POST' || normalizedMethod === 'PUT') && data) {
      if (typeof data === 'string' && !requestHeaders['Content-Type']) {
        if (
          requestUrl.includes('/usageReferences') &&
          data.includes('usageReferenceRequest')
        ) {
          requestHeaders['Content-Type'] =
            'application/vnd.sap.adt.repository.usagereferences.request.v1+xml';
          requestHeaders.Accept =
            'application/vnd.sap.adt.repository.usagereferences.result.v1+xml';
        } else {
          requestHeaders['Content-Type'] = 'text/plain; charset=utf-8';
        }
      }
    }

    // Inside an uninterruptible critical section (lock → modify → unlock), a
    // short per-request timeout must not abort the request mid-flight — that
    // would drop the stateful session and orphan the lock. Raise the effective
    // timeout to the large critical-section ceiling for the whole request
    // (also honoured on the retry paths below, which reuse requestConfig).
    const effectiveTimeout = this.inCriticalSection
      ? Math.max(timeout ?? 0, getCriticalSectionTimeout())
      : timeout;

    const requestConfig: AxiosRequestConfig = {
      method: normalizedMethod,
      url: requestUrl,
      headers: requestHeaders,
      timeout: effectiveTimeout,
      params,
    };

    if (data !== undefined) {
      requestConfig.data = data;
    }

    this.logger?.debug(
      `Executing ${normalizedMethod} request to: ${requestUrl}`,
      {
        type: 'REQUEST_INFO',
        url: requestUrl,
        method: normalizedMethod,
      },
    );

    try {
      const response = await this.getAxiosInstance()(requestConfig);
      // Observe first, act second: the classification is computed while the
      // state updates, and the policy runs before the response is handed back.
      this.applyIdentityPolicy(
        this.updateCookiesFromResponse(response.headers),
      );

      this.logger?.debug(`Request succeeded with status ${response.status}`, {
        type: 'REQUEST_SUCCESS',
        status: response.status,
        url: requestUrl,
        method: normalizedMethod,
      });

      return response as unknown as IAdtResponse<T, D>;
    } catch (error) {
      const errorDetails: {
        type: string;
        message: string;
        url: string;
        method: string;
        status?: number;
        data?: string;
      } = {
        type: 'REQUEST_ERROR',
        message: error instanceof Error ? error.message : String(error),
        url: requestUrl,
        method: normalizedMethod,
        status:
          error instanceof AxiosError ? error.response?.status : undefined,
        data: undefined,
      };

      if (error instanceof AxiosError && error.response) {
        errorDetails.data =
          typeof error.response.data === 'string'
            ? error.response.data.slice(0, 200)
            : JSON.stringify(error.response.data).slice(0, 200);

        this.updateCookiesFromResponse(error.response.headers);
      }

      // The server telling us the session is gone is invisible to the identity
      // comparison: the cookie, and therefore the fingerprint, is unchanged.
      // Only the state can see it, and it must say so at once — otherwise a
      // later unlockAll() finds a match and unlocks over a dead session.
      if (this.isDeadSessionResponse(error)) {
        this.raiseSessionLost(
          'the server reports the session no longer exists',
        );
        // No internal retry: a blind retry here is what produced further locks
        // in the field. The caller decides.
        throw sessionError(
          ADT_SESSION_ERROR.SESSION_REPLACED,
          'The SAP session no longer exists; any lock handle from it is dead',
        );
      }

      // Check if this is a network error (connection refused, timeout, DNS, etc.)
      // Don't retry for network errors - these indicate infrastructure/VPN issues
      const networkError = isNetworkError(error);

      if (networkError) {
        this.logger?.error(
          `Network error - cannot connect to SAP system: ${errorDetails.message}`,
          errorDetails,
        );
        throw error;
      }

      // Log 404 as debug (common for existence checks), other errors as error
      if (errorDetails.status === 404) {
        this.logger?.debug(errorDetails.message, errorDetails);
      } else {
        this.logger?.error(errorDetails.message, errorDetails);
      }

      // Detect the "login-form 401" pattern: SAP returned 401 for a mutation while
      // we have a cached CSRF token. The token and its bound SAP session must be
      // discarded before the retry. Basic auth only — JWT/SAML lifecycles are
      // managed elsewhere.
      const isCachedTokenStale =
        error instanceof AxiosError &&
        this.config.authType === 'basic' &&
        (normalizedMethod === 'POST' ||
          normalizedMethod === 'PUT' ||
          normalizedMethod === 'DELETE') &&
        error.response?.status === 401 &&
        this.getCsrfToken() !== null;

      // Retry logic for CSRF token errors (403 with CSRF message) and the
      // login-form 401 pattern.
      if (this.shouldRetryCsrf(error) || isCachedTokenStale) {
        this.logger?.debug(
          isCachedTokenStale
            ? 'Stale CSRF token / SAP session — invalidating and retrying'
            : 'CSRF token validation failed, fetching new token and retrying request',
          {
            url: requestUrl,
            method: normalizedMethod,
          },
        );

        if (isCachedTokenStale) {
          this.invalidateSession();
          delete requestHeaders.Cookie;
          delete requestHeaders.cookie;
        }

        try {
          this.setCsrfToken(await this.fetchCsrfToken(requestUrl, 5, 2000));
          const refreshedToken = this.getCsrfToken();
          if (refreshedToken) {
            requestHeaders['x-csrf-token'] = refreshedToken;
          }
          const refreshedCookies = this.getCookies();
          if (refreshedCookies) {
            requestHeaders.Cookie = refreshedCookies;
          }

          const retryResponse = await this.getAxiosInstance()(requestConfig);
          this.updateCookiesFromResponse(retryResponse.headers);

          return retryResponse as unknown as IAdtResponse<T, D>;
        } catch (retryError) {
          this.logger?.debug(
            `CSRF retry failed; rethrowing original error: ${
              retryError instanceof Error
                ? retryError.message
                : String(retryError)
            }`,
          );
          throw error;
        }
      }

      // Retry logic for 401 errors on GET requests (authentication issue - need cookies)
      // Only for basic auth - JWT auth will be handled by refresh logic below
      if (
        error instanceof AxiosError &&
        error.response?.status === 401 &&
        normalizedMethod === 'GET' &&
        this.config.authType === 'basic' // Only for basic auth
      ) {
        // If we already have cookies from error response, retry immediately
        if (this.cookies) {
          this.logger?.debug(
            `[DEBUG] BaseAbapConnection - 401 on GET request, retrying with cookies from error response`,
          );
          requestHeaders.Cookie = this.cookies;

          const retryResponse = await this.getAxiosInstance()(requestConfig);
          this.updateCookiesFromResponse(retryResponse.headers);

          return retryResponse as unknown as IAdtResponse<T, D>;
        }

        // If no cookies, try to get them via CSRF token fetch
        this.logger?.debug(
          `[DEBUG] BaseAbapConnection - 401 on GET request, attempting to get cookies via CSRF token fetch`,
        );
        try {
          // Try to get CSRF token (this will also get cookies)
          this.csrfToken = await this.fetchCsrfToken(requestUrl, 3, 1000);
          if (this.cookies) {
            requestHeaders.Cookie = this.cookies;
            this.logger?.debug(
              `[DEBUG] BaseAbapConnection - Retrying GET request with cookies from CSRF fetch`,
            );

            const retryResponse = await this.getAxiosInstance()(requestConfig);
            this.updateCookiesFromResponse(retryResponse.headers);

            return retryResponse as unknown as IAdtResponse<T, D>;
          }
        } catch (csrfError) {
          this.logger?.debug(
            `[DEBUG] BaseAbapConnection - Failed to get CSRF token for 401 retry: ${csrfError instanceof Error ? csrfError.message : String(csrfError)}`,
          );
          // Fall through to throw original error
        }
      }

      throw error;
    }
  }

  protected abstract buildAuthorizationHeader(): string;

  /**
   * Fetch CSRF token from SAP system
   * Protected method for use by concrete implementations in their connect() method
   */
  protected async fetchCsrfToken(
    url: string,
    retryCount: number = CSRF_CONFIG.RETRY_COUNT,
    retryDelay: number = CSRF_CONFIG.RETRY_DELAY,
  ): Promise<string> {
    // Try primary endpoint first, then fallback for older systems
    const baseUrl = url.includes('/sap/bc/adt/')
      ? url.split('/sap/bc/adt')[0]
      : url.endsWith('/')
        ? url.slice(0, -1)
        : url;

    let endpoints: string[];

    // If the URL already contains a specific endpoint, use only that
    if (url.includes(CSRF_CONFIG.ENDPOINT)) {
      endpoints = [url];
    } else if (url.includes(CSRF_CONFIG.FALLBACK_ENDPOINT)) {
      endpoints = [url];
    } else {
      endpoints = [
        `${baseUrl}${CSRF_CONFIG.ENDPOINT}`,
        `${baseUrl}${CSRF_CONFIG.FALLBACK_ENDPOINT}`,
      ];
    }

    let lastError: Error | undefined;

    for (const csrfUrl of endpoints) {
      try {
        return await this.fetchCsrfTokenFromEndpoint(
          csrfUrl,
          retryCount,
          retryDelay,
        );
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger?.debug(
          `CSRF token not available from ${csrfUrl}, trying next endpoint...`,
        );
      }
    }

    // All endpoints exhausted
    throw lastError ?? new Error('CSRF token fetch failed unexpectedly');
  }

  /**
   * Fetch CSRF token from a specific endpoint with retries
   */
  private async fetchCsrfTokenFromEndpoint(
    csrfUrl: string,
    retryCount: number,
    retryDelay: number,
  ): Promise<string> {
    this.logger?.debug(`Fetching CSRF token from: ${csrfUrl}`);

    for (let attempt = 0; attempt <= retryCount; attempt++) {
      try {
        if (attempt > 0) {
          this.logger?.debug(
            `Retry attempt ${attempt}/${retryCount} for CSRF token`,
          );
        }

        const authHeaders = await this.getAuthHeaders();
        const headers: Record<string, string> = {
          ...authHeaders,
          ...CSRF_CONFIG.REQUIRED_HEADERS,
        };

        // The token fetch belongs to the same ADT conversation as every other
        // request this connection makes. Without the connection id the server
        // sees a caller that merely happens to present our cookies, so a fetch
        // issued while a lock is held reads as a stranger reaching into the
        // session. makeAdtRequest sends this header for all session types; this
        // path must not be the exception.
        if (this.sessionId) {
          headers['sap-adt-connection-id'] = this.sessionId;
        }

        // Always add cookies if available - they are needed for session continuity
        // Even on first attempt, if we have cookies from previous session or error response, use them
        if (this.cookies) {
          headers.Cookie = this.cookies;
          this.logger?.debug(
            `[DEBUG] BaseAbapConnection - Adding cookies to CSRF token request (attempt ${attempt + 1}, first 100 chars): ${this.cookies.substring(0, 100)}...`,
          );
        } else {
          this.logger?.debug(
            `[DEBUG] BaseAbapConnection - No cookies available for CSRF token request (will get fresh cookies from response)`,
          );
        }

        // Log request details for debugging (only if debug logging is enabled)
        this.logger?.debug(
          `[DEBUG] CSRF Token Request: url=${csrfUrl}, method=GET, hasAuth=${!!authHeaders.Authorization}, hasClient=${!!authHeaders['X-SAP-Client']}, hasCookies=${!!headers.Cookie}, attempt=${attempt + 1}`,
        );

        const response = await this.getAxiosInstance()({
          method: 'GET',
          url: csrfUrl,
          headers,
          timeout: getTimeout('csrf'),
        });

        this.updateCookiesFromResponse(response.headers);

        const token = response.headers['x-csrf-token'] as string | undefined;
        if (!token) {
          this.logger?.error('No CSRF token in response headers', {
            headers: response.headers,
            status: response.status,
          });

          if (attempt < retryCount) {
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
            continue;
          }
          throw new Error(CSRF_ERROR_MESSAGES.NOT_IN_HEADERS);
        }

        if (response.headers['set-cookie']) {
          this.updateCookiesFromResponse(response.headers);
          if (this.cookies) {
            this.logger?.debug(
              `[DEBUG] BaseAbapConnection - Cookies received from CSRF response (first 100 chars): ${this.cookies.substring(0, 100)}...`,
            );
            this.logger?.debug('Cookies extracted from response', {
              cookieLength: this.cookies.length,
            });
          }
        }

        this.logger?.debug('CSRF token successfully obtained');
        return token;
      } catch (error) {
        if (error instanceof AxiosError) {
          // Always try to extract cookies from error response, even on 401
          // This ensures cookies are available for subsequent requests
          if (error.response?.headers) {
            this.updateCookiesFromResponse(error.response.headers);
            if (this.cookies) {
              this.logger?.debug('Cookies extracted from error response', {
                status: error.response.status,
                cookieLength: this.cookies.length,
              });
            }
          }

          this.logger?.error(`CSRF token error: ${error.message}`, {
            url: csrfUrl,
            status: error.response?.status,
            attempt: attempt + 1,
            maxAttempts: retryCount + 1,
          });

          if (
            error.response?.status === 405 &&
            error.response?.headers['x-csrf-token']
          ) {
            this.logger?.debug(
              'CSRF: SAP returned 405 (Method Not Allowed) — not critical, token found in header',
            );

            const token = error.response.headers['x-csrf-token'] as string;
            if (token) {
              this.updateCookiesFromResponse(error.response.headers);
              return token;
            }
          }

          if (error.response?.headers['x-csrf-token']) {
            this.logger?.debug(
              `Got CSRF token despite error (status: ${error.response?.status})`,
            );

            const token = error.response.headers['x-csrf-token'] as string;
            this.updateCookiesFromResponse(error.response.headers);
            return token;
          }

          if (error.response) {
            this.logger?.error('CSRF error details', {
              status: error.response.status,
              statusText: error.response.statusText,
              headers: Object.keys(error.response.headers),
              data:
                typeof error.response.data === 'string'
                  ? error.response.data.slice(0, 200)
                  : JSON.stringify(error.response.data).slice(0, 200),
            });
          } else if (error.request) {
            this.logger?.error('CSRF request error - no response received', {
              request: error.request.path,
            });
          }
        } else {
          this.logger?.error('CSRF non-axios error', {
            error: error instanceof Error ? error.message : String(error),
          });
        }

        if (attempt < retryCount) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
          continue;
        }

        // Preserve original error information, especially AxiosError with response
        if (error instanceof AxiosError && error.response) {
          // Re-throw the original AxiosError to preserve response information
          throw error;
        }

        throw new Error(
          CSRF_ERROR_MESSAGES.FETCH_FAILED(
            retryCount + 1,
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }

    throw new Error('CSRF token fetch failed unexpectedly');
  }

  /**
   * Get CSRF token (protected for use by subclasses)
   */
  protected getCsrfToken(): string | null {
    return this.csrfToken;
  }

  /**
   * Set CSRF token (protected for use by subclasses)
   */
  protected setCsrfToken(token: string | null): void {
    this.csrfToken = token;
  }

  /**
   * Get cookies (protected for use by subclasses)
   */
  protected getCookies(): string | null {
    return this.cookies;
  }

  protected setInitialCookies(cookies: string): void {
    this.cookies = cookies;
  }

  /**
   * Folds a response's cookies into the jar and classifies what that means for
   * the session identity. Returns the classification rather than acting on it:
   * cookie parsing stays free of policy, and no exception fires in the middle
   * of a state update. The caller decides.
   */
  private updateCookiesFromResponse(
    headers?: Record<string, unknown>,
  ): 'unchanged' | 'established' | 'replaced' {
    if (!headers) {
      return 'unchanged';
    }

    const setCookie = headers['set-cookie'] as string[] | string | undefined;
    if (!setCookie) {
      return 'unchanged';
    }

    const cookiesArray = Array.isArray(setCookie) ? setCookie : [setCookie];

    for (const entry of cookiesArray) {
      if (typeof entry !== 'string') {
        continue;
      }

      const [nameValue] = entry.split(';');
      if (!nameValue) {
        continue;
      }

      const [name, ...rest] = nameValue.split('=');
      if (!name) {
        continue;
      }

      const trimmedName = name.trim();
      const trimmedValue = rest.join('=').trim();

      if (!trimmedName) {
        continue;
      }

      this.cookieStore.set(trimmedName, trimmedValue);
    }

    // Enforce configured SAP client in sap-usercontext cookie.
    // SAP may return sap-usercontext=sap-client=<default_client> based on system
    // default rather than the X-SAP-Client header value, causing requests to be
    // routed to the wrong client (e.g. a read-only client → 403 on write operations).
    if (this.config.client) {
      this.cookieStore.set(
        'sap-usercontext',
        `sap-client=${this.config.client}`,
      );
    }

    if (this.cookieStore.size === 0) {
      return 'unchanged';
    }

    const combined = Array.from(this.cookieStore.entries())
      .map(([name, value]) => (value ? `${name}=${value}` : name))
      .join('; ');

    if (!combined) {
      return 'unchanged';
    }

    this.cookies = combined;
    this.logger?.debug(
      `[DEBUG] BaseAbapConnection - Updated cookies from response (first 100 chars): ${this.cookies.substring(0, 100)}...`,
    );
    return this.lifecycle.observe(this.sessionFingerprint());
  }

  /**
   * Subclasses override to inject extra https.Agent options (e.g. mTLS cert/key/pfx).
   * The returned options are merged with the base options (rejectUnauthorized).
   */
  protected getHttpsAgentOptions(): import('node:https').AgentOptions {
    return {};
  }

  private getAxiosInstance(): AxiosInstance {
    if (!this.axiosInstance) {
      const rejectUnauthorized =
        process.env.NODE_TLS_REJECT_UNAUTHORIZED === '1' ||
        (process.env.TLS_REJECT_UNAUTHORIZED === '1' &&
          process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0');

      this.logger?.debug(
        `TLS configuration: rejectUnauthorized=${rejectUnauthorized}`,
      );

      this.axiosInstance = axios.create({
        httpsAgent: new Agent({
          rejectUnauthorized,
          ...this.getHttpsAgentOptions(),
        }),
      });
    }

    return this.axiosInstance;
  }

  private async ensureFreshCsrfToken(requestUrl: string): Promise<void> {
    // If we already have a CSRF token, reuse it to keep the same SAP session
    // SAP ties the lock handle to the HTTP session (SAP_SESSIONID cookie)
    if (this.csrfToken) {
      this.logger?.debug(
        `[DEBUG] BaseAbapConnection - Reusing existing CSRF token to maintain session`,
      );
      return;
    }

    try {
      this.logger?.debug(
        `[DEBUG] BaseAbapConnection - Fetching NEW CSRF token (will create new SAP session)`,
      );
      this.csrfToken = await this.fetchCsrfToken(requestUrl);
    } catch (error) {
      // fetchCsrfToken handles auth errors
      // Just re-throw the error with minimal logging to avoid duplicate error messages
      const errorMsg =
        error instanceof Error
          ? error.message
          : CSRF_ERROR_MESSAGES.REQUIRED_FOR_MUTATION;

      // Only log at DEBUG level to avoid duplicate error messages
      // (fetchCsrfToken already logged the error at ERROR level if auth failed)
      this.logger?.debug(
        `[DEBUG] BaseAbapConnection - ensureFreshCsrfToken failed: ${errorMsg}`,
      );

      throw error;
    }
  }

  /**
   * Clear SAP-side session state when SAP rejects the cached CSRF token + session
   * cookies (HTTP 401 on a mutation while a cached token exists). This forces the
   * next request path to fetch a fresh token and a fresh SAP_SESSIONID cookie.
   *
   * Distinct from reset(): this leaves the axios instance and interceptors in place.
   */
  private invalidateSession(): void {
    this.setCsrfToken(null);
    this.cookies = null;
    this.cookieStore.clear();
  }

  private shouldRetryCsrf(error: unknown): boolean {
    if (!(error instanceof AxiosError)) {
      return false;
    }

    const responseData = error.response?.data;
    const responseText =
      typeof responseData === 'string'
        ? responseData
        : JSON.stringify(responseData || '');

    // Don't retry for JWT auth - refresh logic will handle it
    if (this.config.authType === 'jwt') {
      return false;
    }

    // Retry on 403 with CSRF message, or if response mentions CSRF token
    // Also retry on 401 for POST/PUT/DELETE if we don't have CSRF token yet (might need to get cookies first)
    const method = error.config?.method?.toUpperCase();
    const isPostPutDelete =
      method && ['POST', 'PUT', 'DELETE'].includes(method);
    const needsCsrfToken = !!isPostPutDelete && !this.csrfToken;

    return (
      (!!error.response &&
        error.response.status === 403 &&
        responseText.includes('CSRF')) ||
      responseText.includes('CSRF token') ||
      (needsCsrfToken && error.response?.status === 401)
    );
  }
}

// Export only for internal use by BaseAbapConnection and JwtAbapConnection
export { AbstractAbapConnection };
