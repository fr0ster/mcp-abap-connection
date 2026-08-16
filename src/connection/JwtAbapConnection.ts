import { AsyncLocalStorage } from 'node:async_hooks';
import {
  ADT_SESSION_ERROR,
  type IAdtResponse,
  type ITokenRefresher,
} from '@mcp-abap-adt/interfaces';
import { AxiosError } from 'axios';
import type { SapConfig } from '../config/sapConfig.js';
import type { ILogger } from '../logger.js';
import { sessionError } from '../session/SessionLifecycle.js';
import type { AbapRequestOptions } from './AbapConnection.js';
import { AbstractAbapConnection } from './AbstractAbapConnection.js';
import { CSRF_CONFIG } from './csrfConfig.js';

/**
 * Is this worth refreshing a token for?
 *
 * 401 only. A 403 means the server authenticated the caller and refused the
 * action anyway — a new token is the same caller, so refreshing answers a
 * question nobody asked and, worse, used to end with the original error
 * replaced by "JWT token has expired". See issue #30.
 */
function isTokenExpiryCandidate(error: unknown): error is AxiosError {
  return error instanceof AxiosError && error.response?.status === 401;
}

/** What one caller-visible operation knows about the credential it started with. */
interface IRecoveryScope {
  /** `tokenGeneration` as it stood when this operation began. */
  readonly baseline: number;
  /** Cleared when the operation that opened this scope returns. */
  active: boolean;
}

/**
 * JWT Authentication connection for SAP BTP Cloud systems
 *
 * Supports automatic token refresh via ITokenRefresher injection:
 * - a **401** triggers a token refresh when a tokenRefresher is available;
 * - without one, or when the refresh does not help, the server's own error is
 *   thrown unchanged — status and body intact;
 * - a **403** is never a token problem. It propagates as it arrived, because a
 *   new token is the same caller and cannot change a permissions answer.
 */
export class JwtAbapConnection extends AbstractAbapConnection {
  private tokenRefresher?: ITokenRefresher;
  private currentToken: string;

  /** Bumped by any token refresh, token-only ones included. */
  private tokenGeneration = 0;

  /** Single-flight over the token fetch alone. Touches no session state. */
  private tokenRefreshInFlight?: Promise<boolean>;

  /**
   * The `tokenGeneration` a completed session recovery was built for. Only
   * `performRenewal` moves it, and only after `recoverSession` resolves.
   *
   * Separate from `tokenGeneration` because a token-only refresh — which
   * `fetchCsrfToken` does, from inside an establishment — bumps that counter
   * without rebuilding anything. Reading it as "the session is settled" made
   * the outer handler retry a request whose session was never rebuilt.
   */
  private recoveredGeneration = 0;

  /**
   * Single-flight over the whole credential renewal, session included.
   *
   * Sharing only the token fetch leaves the expensive half racing: `recover`
   * and `cleanup` never join (`SessionLifecycle.transition`), so two concurrent
   * renewals queue as cleanup A → recover A → cleanup B → recover B, and A's
   * retry meets a session B has just torn down.
   */
  private renewalInFlight?: Promise<boolean>;

  /**
   * Per connection, deliberately NOT static. `baseline` is compared against
   * `this.tokenGeneration`, which is instance state — a store shared between
   * instances would let one connection's operation hand its baseline to
   * another's, and the comparison would be between unrelated counters.
   */
  private readonly recoveryScope = new AsyncLocalStorage<IRecoveryScope>();

  constructor(
    config: SapConfig,
    logger?: ILogger | null,
    sessionId?: string,
    tokenRefresher?: ITokenRefresher,
  ) {
    JwtAbapConnection.validateConfig(config);
    super(config, logger || null, sessionId);
    this.tokenRefresher = tokenRefresher;
    if (!config.jwtToken) {
      throw new Error('jwtToken is required for JwtAbapConnection');
    }
    this.currentToken = config.jwtToken;
  }

  protected buildAuthorizationHeader(): string {
    // Use currentToken which may have been refreshed
    const tokenPreview = this.currentToken
      ? `${this.currentToken.substring(0, 10)}...${this.currentToken.substring(Math.max(0, this.currentToken.length - 4))}`
      : 'null';
    this.logger?.debug(
      `[DEBUG] JwtAbapConnection.buildAuthorizationHeader - Using token: ${tokenPreview}`,
    );
    return `Bearer ${this.currentToken}`;
  }

  /**
   * For the public entry point: this call is its own operation, always.
   *
   * A re-entrant `makeAdtRequest` — from a logger or a refresher callback the
   * connection itself invokes while a scope is live — is a new caller-visible
   * operation. Inheriting there would hand it a baseline from somebody else's
   * refresh, which reads as "already refreshed for me" and skips a refresh it
   * needs.
   */
  private inNewRecoveryScope<T>(fn: () => Promise<T>): Promise<T> {
    const scope: IRecoveryScope = {
      baseline: this.tokenGeneration,
      active: true,
    };
    return this.recoveryScope.run(scope, async () => {
      try {
        return await fn();
      } finally {
        scope.active = false;
      }
    });
  }

  /** For the inner levels: join the operation in progress, or start one. */
  private inRecoveryScope<T>(fn: () => Promise<T>): Promise<T> {
    const inherited = this.recoveryScope.getStore();
    // Only a scope that is still running. A store reached through an async
    // resource that outlived its operation is stale, and its baseline describes
    // a credential state that has since moved.
    if (inherited?.active) return fn();
    return this.inNewRecoveryScope(fn);
  }

  /**
   * The baseline this operation is reasoning from.
   *
   * The `active` check here and the one in `inRecoveryScope` OVERLAP: each
   * compensates for the other, and the stale-context test only fails when both
   * are removed. Kept as two because they answer different questions — "may I
   * join this scope" and "may I trust this baseline" — and a reader who finds
   * one redundant would be deleting half a guarantee.
   */
  private currentBaseline(): number {
    const scope = this.recoveryScope.getStore();
    // No live scope means a caller reached a handler by a path that does not
    // open one, or through a stale async context. Either way, treat it as its
    // own operation rather than trusting a baseline nobody is standing behind.
    return scope?.active ? scope.baseline : this.tokenGeneration;
  }

  /**
   * Fetch a new token, unless somebody already did for this operation.
   *
   * Single-flighted so two concurrent handlers — including two nested
   * `fetchCsrfToken` calls, which is a level `renewalInFlight` cannot reach —
   * share one network call instead of racing and leaving `currentToken` as
   * whichever settled last.
   *
   * @returns true when the caller may retry.
   */
  private refreshTokenOnce(baseline: number): Promise<boolean> {
    if (this.tokenGeneration > baseline) return Promise.resolve(true);
    if (this.tokenRefreshInFlight) return this.tokenRefreshInFlight;
    if (!this.tokenRefresher) {
      this.logger?.debug(
        `[DEBUG] JwtAbapConnection - No tokenRefresher available, cannot refresh token`,
      );
      return Promise.resolve(false);
    }

    // Identity-checked clear, as SessionLifecycle.transition does with its
    // tail: a joiner settling late must not clear a fetch somebody started
    // after it.
    const inFlight = this.performTokenRefresh().finally(() => {
      if (this.tokenRefreshInFlight === inFlight) {
        this.tokenRefreshInFlight = undefined;
      }
    });
    this.tokenRefreshInFlight = inFlight;
    return inFlight;
  }

  private async performTokenRefresh(): Promise<boolean> {
    try {
      this.logger?.debug(
        `[DEBUG] JwtAbapConnection - Refreshing token via tokenRefresher...`,
      );
      // biome-ignore lint/style/noNonNullAssertion: refreshTokenOnce checks it
      this.currentToken = await this.tokenRefresher!.refreshToken();
      this.tokenGeneration += 1;
      this.logger?.debug(
        `[DEBUG] JwtAbapConnection - Token refreshed successfully`,
      );
      return true;
    } catch (error) {
      this.logger?.error(
        `[ERROR] JwtAbapConnection - Failed to refresh token: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * Renew the credential and the session it belongs to, once, shared.
   */
  private renewCredential(
    baselineEpoch: number,
    baseline: number,
  ): Promise<boolean> {
    if (this.renewalInFlight) return this.renewalInFlight;
    // Identity-checked clear, as SessionLifecycle.transition does with its
    // tail: a joiner settling late must not clear a renewal somebody started
    // after it.
    const inFlight = this.performRenewal(baselineEpoch, baseline).finally(
      () => {
        if (this.renewalInFlight === inFlight) this.renewalInFlight = undefined;
      },
    );
    this.renewalInFlight = inFlight;
    return inFlight;
  }

  private async performRenewal(
    baselineEpoch: number,
    baseline: number,
  ): Promise<boolean> {
    // Shared with the token-only path, and a no-op when the token is already
    // newer than the one that failed — then what is missing is the session, and
    // a second fetch answers a question nobody asked.
    if (!(await this.refreshTokenOnce(baseline))) return false;

    this.logger?.debug(
      `[DEBUG] JwtAbapConnection - Recovering session after token refresh...`,
    );
    // The renewed credential cannot keep the old ABAP session, so this is a
    // session-lost teardown — internal, or it would cancel the very recovery it
    // is setting up. reset() would be the caller-origin one.
    this.discardSession();
    // Re-establish before retrying: the retry goes through admission, and a
    // discarded session admits nothing.
    await this.recoverSession(baselineEpoch);
    // Only here: a session now exists that was built with this token.
    this.recoveredGeneration = this.tokenGeneration;
    return true;
  }

  /**
   * May this operation retry?
   *
   * The order of the checks is the design, not style.
   */
  private async ensureRecovered(baselineEpoch: number): Promise<boolean> {
    // 1. A renewal in flight is joined REGARDLESS of generation. A newer token
    //    is no use while the session it belongs to is still being rebuilt:
    //    retrying now is how a caller meets a closed admission door.
    //
    //    This overlaps check 2 as the counters stand — `recoveredGeneration`
    //    only moves after `recoverSession` resolves, so check 2 cannot report a
    //    rebuild that has not finished, and removing either guard alone leaves
    //    the concurrency test green. Both are kept on purpose: this one states
    //    the rule ("never decide anything while a renewal is running") without
    //    depending on when some other counter happens to move, and it is what
    //    keeps the invariant true if check 2's counter is ever changed.
    if (this.renewalInFlight) return this.renewalInFlight;

    const baseline = this.currentBaseline();

    // 2. A full renewal COMPLETED since this operation began — token, and the
    //    session built with it. Not `tokenGeneration`: that moves on a
    //    token-only refresh, which rebuilds nothing.
    if (this.recoveredGeneration > baseline) return true;

    // 3. Nobody has. Renew, and let everyone else join.
    return this.renewCredential(baselineEpoch, baseline);
  }

  /**
   * Establishes the session for this auth type. Called by
   * AbstractAbapConnection.connect(), which owns the lifecycle around it.
   */
  protected async establishSession(): Promise<void> {
    const baseUrl = await this.getBaseUrl();
    const discoveryUrl = `${baseUrl}/sap/bc/adt/discovery`;

    this.logger?.debug(
      `[DEBUG] JwtAbapConnection - Connecting to SAP system: ${discoveryUrl}`,
    );

    try {
      // Try to get CSRF token (this will also get cookies)
      const token = await this.fetchCsrfToken(discoveryUrl);
      this.setCsrfToken(token);

      this.logger?.debug('Successfully connected to SAP system', {
        hasCsrfToken: !!this.getCsrfToken(),
        hasCookies: !!this.getCookies(),
        cookieLength: this.getCookies()?.length || 0,
      });
    } catch (error) {
      if (isTokenExpiryCandidate(error)) {
        this.logger?.error(
          '[ERROR] JwtAbapConnection.establishSession - 401 while establishing; fetchCsrfToken has already refreshed and retried for this',
        );
      }
      throw error;
    }
  }

  /**
   * Override makeAdtRequest to handle JWT auth errors with automatic token refresh
   */
  async makeAdtRequest<T = any, D = any>(
    options: AbapRequestOptions,
  ): Promise<IAdtResponse<T, D>> {
    // A public call is its own operation, whatever scope it starts in.
    return this.inNewRecoveryScope(() => this.attemptRequest<T, D>(options));
  }

  private async attemptRequest<T, D>(
    options: AbapRequestOptions,
  ): Promise<IAdtResponse<T, D>> {
    // Captured before the attempt: a recovery asks "has the caller asked to
    // stop since this request began", not since some later bookkeeping step.
    const baselineEpoch = this.teardownEpoch;
    this.logger?.debug(
      `[DEBUG] JwtAbapConnection.makeAdtRequest - Starting request: ${options.method} ${options.url}`,
    );
    try {
      const response = await super.makeAdtRequest<T, D>(options);
      this.logger?.debug(
        `[DEBUG] JwtAbapConnection.makeAdtRequest - Request succeeded: ${response.status}`,
      );
      return response;
    } catch (error) {
      this.logger?.debug(
        `[DEBUG] JwtAbapConnection.makeAdtRequest - Request failed: ${error instanceof Error ? error.message : String(error)}`,
      );

      if (isTokenExpiryCandidate(error)) {
        this.logger?.debug(
          `[DEBUG] JwtAbapConnection.makeAdtRequest - Got 401, attempting token refresh...`,
        );

        if (await this.ensureRecovered(baselineEpoch)) {
          // A renewal this operation joined was fenced against the STARTER's
          // baseline, not this one's, and establishAndCommit's own epoch checks
          // belong to the establishment that ran. Between the last of them and
          // this retry there is a gap nothing else watches: the connection can
          // be torn down by its caller and made usable again, and a retry would
          // then go out on a session that caller discarded.
          if (this.teardownEpoch !== baselineEpoch) {
            throw sessionError(
              ADT_SESSION_ERROR.NOT_CONNECTED,
              'Retry abandoned: a teardown was requested for this connection',
            );
          }
          try {
            return await super.makeAdtRequest<T, D>(options);
          } catch (retryError) {
            // A 401 that survived a renewal is the case the deleted message
            // was about, and it only shows up here — the log below fires when
            // the renewal never happened, which is a different fact.
            if (isTokenExpiryCandidate(retryError)) {
              this.logger?.error(
                '[ERROR] JwtAbapConnection.makeAdtRequest - 401 persists after a credential renewal; the credential may need re-authentication',
              );
            }
            throw retryError;
          }
        }

        this.logger?.error(
          '[ERROR] JwtAbapConnection.makeAdtRequest - 401 persists and the token could not be refreshed; the credential may need re-authentication',
        );
      }

      throw error;
    }
  }

  /**
   * Override fetchCsrfToken to handle JWT auth errors with automatic token refresh
   */
  protected async fetchCsrfToken(
    url: string,
    retryCount: number = CSRF_CONFIG.RETRY_COUNT,
    retryDelay: number = CSRF_CONFIG.RETRY_DELAY,
    /** Fences the response effects; omitted during connect(), which has no lease. */
    generation?: number,
  ): Promise<string> {
    // An inner level: join the operation in progress, or start one when
    // reached directly — a bare connect() is still an operation with a
    // baseline.
    return this.inRecoveryScope(() =>
      this.attemptCsrfToken(url, retryCount, retryDelay, generation),
    );
  }

  private async attemptCsrfToken(
    url: string,
    retryCount: number,
    retryDelay: number,
    generation?: number,
  ): Promise<string> {
    try {
      // Try to fetch CSRF token using parent implementation
      return await super.fetchCsrfToken(
        url,
        retryCount,
        retryDelay,
        generation,
      );
    } catch (error) {
      // A 401 here may be an expired token; anything else is not ours to
      // interpret — a 403 least of all, since a new token is the same caller.
      if (isTokenExpiryCandidate(error)) {
        if (await this.refreshTokenOnce(this.currentBaseline())) {
          // Retry CSRF token fetch with new token
          this.logger?.debug(
            `[DEBUG] JwtAbapConnection.fetchCsrfToken - Retrying after token refresh...`,
          );
          try {
            return await super.fetchCsrfToken(
              url,
              retryCount,
              retryDelay,
              generation,
            );
          } catch (retryError) {
            if (isTokenExpiryCandidate(retryError)) {
              this.logger?.error(
                '[ERROR] JwtAbapConnection.fetchCsrfToken - 401 persists after a token refresh; the credential may need re-authentication',
              );
            }
            throw retryError;
          }
        }

        this.logger?.error(
          '[ERROR] JwtAbapConnection.fetchCsrfToken - 401 persists and the token could not be refreshed; the credential may need re-authentication',
        );
      }

      // Re-throw other errors
      throw error;
    }
  }

  private static validateConfig(config: SapConfig): void {
    if (config.authType !== 'jwt') {
      throw new Error(
        `JWT connection expects authType "jwt", got "${config.authType}"`,
      );
    }

    if (!config.jwtToken) {
      throw new Error(
        'JWT authentication requires SAP_JWT_TOKEN to be provided',
      );
    }
  }
}
