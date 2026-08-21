import { randomUUID } from 'node:crypto';
import { Agent } from 'node:https';
import {
  ADT_SESSION_ERROR,
  type IAdtResponse,
  type ISessionLifecycleAware,
  isNetworkError,
} from '@mcp-abap-adt/interfaces';
import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
} from 'axios';
import type { SapConfig } from '../config/sapConfig.js';
import type { ILogger } from '../logger.js';
import { IcfSessionStrategy } from '../session/IcfSessionStrategy.js';
import {
  type RequestLease,
  SessionLifecycle,
  sessionError,
} from '../session/SessionLifecycle.js';
import type {
  ISessionTransport,
  SessionStrategy,
} from '../session/SessionStrategy.js';
import { mergeCookieHeaders } from '../utils/cookies.js';
import {
  getCriticalSectionTimeout,
  getReleaseDeadline,
  getTimeout,
} from '../utils/timeouts.js';
import type { AbapConnection, AbapRequestOptions } from './AbapConnection.js';
import { adaptTransport } from './adaptTransport.js';
import { CSRF_CONFIG, CSRF_ERROR_MESSAGES } from './csrfConfig.js';
import type { IAdtTransport } from './IAdtTransport.js';

/**
 * The configured default release deadline, refused at construction if it is not
 * a number. `parseInt` alone would not do: it answers `NaN` for `"abc"` and `5`
 * for `"5s"`, and both used to travel all the way to a teardown — the first as
 * a throw from every `disconnect()` in the process, the second as a silently
 * wrong bound nobody asked for.
 */
function readReleaseDeadline(): number {
  const raw = process.env.SAP_RELEASE_DEADLINE_MS;
  if (raw === undefined || raw.trim() === '') {
    return getReleaseDeadline();
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `SAP_RELEASE_DEADLINE_MS must be a finite, non-negative number of milliseconds, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

/**
 * Declares the capabilities explicitly rather than satisfying them by accident.
 * `AbapConnection` is the base contract every transport honours; these two are
 * the HTTP session's own, and naming them means a signature that drifts from
 * the published contract fails to compile here instead of at the consumer.
 *
 * **This gives the consumer instruments; it does not decide for it.** `connect()`
 * opens one session and `disconnect()` closes it. How many connections to hold,
 * how long to hold them and when to let go stays with the caller — there are no
 * thresholds here, no pooling and no eviction, because none of that is knowable
 * from inside a single connection. A session this one did not open is not its
 * business: the session limit is per user and the pool is shared, so a SAP GUI
 * logon of the same user sits in the same list.
 *
 * **Nothing the server decides is treated as something to count on.** Whether it
 * issues a session cookie, whether it still holds a session it issued, how many
 * it will tolerate, how fast it answers a logoff — all of that is its own and
 * may differ by system and release. So each is observed and reported, never
 * relied upon: the logoff is best effort under a bound the caller sets, a
 * missing session cookie is a warning rather than a rule, and no code here
 * counts sessions or predicts the next answer from the last one.
 */
abstract class AbstractAbapConnection
  implements AbapConnection, ISessionLifecycleAware
{
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
  /** The default release deadline, validated once at construction. */
  private readonly releaseDeadlineMs: number;
  /** What carries a request, when the caller named one. */
  private readonly adtTransport: IAdtTransport | undefined;
  /**
   * The logoff for the session this connection last held, while it is on its
   * way. One, because a connection holds one session: `connect()` opens it and
   * `disconnect()` closes it, and how many connections to run is the caller's
   * business, not something to be tracked here.
   *
   * Carries the session id, not just the promise, so a release still in flight
   * for an EARLIER session is recognised as not being this one's — reusing it
   * was what left the second session of a reconnect never released at all.
   *
   * The id is the `SAP_SESSIONID` value — the ABAP session, the one locks are
   * bound to — never the cookie header: that header also carries `sap-XSRF_*`,
   * which rotates within one and the same session, so comparing headers made a
   * session stop recognising itself after a token refresh.
   */
  /**
   * How this server opens and gives back a session, decided by asking it rather
   * than by guessing which system it is. Set at establishment; until then the
   * on-prem mechanism, which is the one that needs no resource.
   */
  /**
   * The application server this session lives on, as the server named it.
   *
   * A session belongs to ONE application server. On a multi-node system a
   * request that lands on another gets another session — and a lock held on the
   * first is then dead through nobody's fault and no inactivity. Eclipse pins
   * itself with these headers; without them every request is a fresh throw of
   * the dice.
   *
   * Learned from `sap-adt-saplb` on a response, sent back as `saplb`. Cleared
   * with the rest of the session state: it names a server for a session that no
   * longer exists.
   */
  private appServer: string | null = null;
  /**
   * Whether the preflight opened a session of its own.
   *
   * Distinct from "there are cookies": a failed establishment often leaves a
   * cookie from the 401 that rejected it, and that is debris, not a session.
   * Only a preflight answered with a session address opened one, and only that
   * is worth saying goodbye to when establishment then fails.
   */
  private preflightOpenedSession = false;
  private sessionStrategy: SessionStrategy = new IcfSessionStrategy(null);
  private pendingRelease: { id: string; inFlight: Promise<void> } | null = null;

  protected constructor(
    private readonly config: SapConfig,
    protected readonly logger: ILogger | null,
    sessionId?: string,
    options?: { skipSessionType?: boolean; transport?: IAdtTransport },
  ) {
    // Read and checked HERE, once, because the only other place it could be
    // checked is disconnect() — and disconnect() belongs in a `finally`, where
    // throwing replaces the error that sent the caller there. A misconfigured
    // environment is a startup fault: it is the same on every call, it is not
    // the caller's argument, and it is worth refusing a connection over rather
    // than discovering at teardown.
    this.releaseDeadlineMs = readReleaseDeadline();

    this.skipSessionType = options?.skipSessionType ?? false;
    // Said by the caller. A connection never works out what it is travelling
    // over — the deployment knows, and trying one to see if it answers is the
    // guess this design exists to refuse.
    this.adtTransport = options?.transport;
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
   * Gets the credential ready before anything is sent.
   *
   * A no-op for the auth types whose credential is already in hand — basic
   * builds a header from the configuration, JWT carries a token it was given.
   * It exists for the ones that have to fetch or load theirs, because the
   * preflight now runs BEFORE `establishSession()` and needs a credential to
   * go out with: a certificate connection reads its material there, and
   * without this the preflight throws `certificate material not loaded` while
   * assembling the transport — before a single request is made, on every
   * system, cloud or on-prem.
   *
   * Must be idempotent: `establishSession()` may prepare the same credential
   * again, and does.
   *
   * Kerberos deliberately does NOT implement it. Minting the SPNEGO token this
   * early changes when the exchange happens, and that connection is not
   * production-tested — its preflight fails the way it already did, is caught
   * inside the strategy, and the connection falls back to ICF as before.
   */
  protected async prepareCredential(): Promise<void> {}

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

      // A transport that owns a wire opens it first — an RFC conversation has
      // to exist before anything can be sent over it. HTTP has no such phase
      // and omits the member.
      await this.adtTransport?.open?.();

      await this.establishAndCommit(baselineEpoch);
    });
  }

  /**
   * Tears the session down. Never throws, and always settles.
   *
   * Tells the server the session is no longer needed, then clears the local
   * state. **When the server actually reclaims it is the server's business** —
   * possibly not until the next connect asks it for one — and nothing here
   * waits for that or depends on it. What matters is that the session stops
   * being counted against the user, which dropping the cookie alone does not
   * achieve: the server keeps it until its own timeout, so a process that
   * connects repeatedly leaves one behind every time. Measured on S/4HANA on-prem, 25 connects in a row: with the logoff,
   * 24-25 of them were given a session; without it, 2. A connection that gets
   * no session still answers `200` to a LOCK and hands back a handle the next
   * request cannot use, so the leak surfaces as a half-written object rather
   * than as anything about sessions.
   *
   * **The logoff is the only thing waited for**, under `deadlineMs`, and
   * deciding that bound is the caller's — see the parameter. Nothing else is
   * waited for: finishing chains and releasing locks stay the caller's to do
   * before calling, and waiting here on a request whose caller chose no timeout
   * is what made a teardown unbounded, which blocks every later transition on
   * the serialized tail.
   *
   * **Requests already in flight are not waited for, and the logoff ends the
   * session they are running on** — so they will start failing against a
   * session that no longer exists. That is the caller having asked to
   * disconnect, not a race, and it is a change from the version that only
   * dropped the cookie. Generation fencing (see `SessionLifecycle.isCurrent`)
   * keeps their results from reaching this connection either way.
   *
   * @param options.deadlineMs How long to spend telling the server, measured
   *   from this call and including time spent queued behind another transition.
   *   **Defaults to `SAP_RELEASE_DEADLINE_MS`, which is `0` — do not wait.**
   *   Waiting is for steps whose successor needs the server to have caught up;
   *   a teardown has none. The logoff is still sent at `0`, because saying so
   *   is not conditional on caring when it lands; its outcome is logged when it
   *   arrives rather than awaited. Pass a positive value to bound a wait you
   *   have chosen to take. Anything that is not a finite, non-negative number
   *   is reported and the default used instead — this method is called from a
   *   `finally`, where throwing would replace the error that sent the caller
   *   there. The configured default is checked once, at construction, so a
   *   misconfigured `SAP_RELEASE_DEADLINE_MS` fails before a connection exists
   *   rather than at every teardown.
   */
  async disconnect(options?: { deadlineMs?: number }): Promise<void> {
    // Nothing here throws, including on a bad argument. This method's place is
    // a `finally` — a connection that was connected must be disconnected — and
    // an exception raised there replaces the error that sent the caller into it.
    // A nonsense deadline is reported and the configured default used instead,
    // because refusing to release the session is a worse answer to a bad number
    // than releasing it on the default schedule.
    const requested = options?.deadlineMs;
    const valid =
      requested === undefined || (Number.isFinite(requested) && requested >= 0);
    if (!valid) {
      this.logger?.warn(
        `disconnect(): ignoring deadlineMs=${requested}, which is not a finite, non-negative number; using ${this.releaseDeadlineMs}`,
      );
    }
    const deadlineMs =
      valid && requested !== undefined ? requested : this.releaseDeadlineMs;
    // Started HERE, because the contract measures the deadline from the call
    // and the transition below may sit in a queue first. A budget that started
    // when the callback ran would give a queued teardown its full allowance
    // again, which is the one thing the caller was bounding.
    const startedAt = Date.now();

    // Synchronous, at the call: admission shuts and the generation moves before
    // anything is queued, so a caller who has asked to disconnect cannot have
    // requests still going through while this waits its turn.
    this.lifecycle.beginTeardown({ origin: 'caller', sessionLost: false });

    // Captured before the transition and before anything is cleared: a
    // concurrent disconnect JOINS the transition and its callback is never run
    // for the joiner, so a joiner would otherwise learn nothing about what it
    // asked to release.
    const session = this.getSessionIdentity();

    await this.lifecycle.transition('disconnect', async () => {
      await this.releaseServerSession();
      // Its own wire, given back. Never throws by contract, which is what lets
      // it sit here rather than behind another try.
      await this.adtTransport?.close?.();
      this.clearSessionState();
      this.lifecycle.markDisconnected();
    });

    // Its own release, and only that. Never another session's: an earlier one
    // may never answer — the logoff carries no request timeout by design — and
    // waiting on it would spend this caller's whole budget on a request nobody
    // can finish.
    const mine =
      session && this.pendingRelease?.id === session
        ? this.pendingRelease.inFlight
        : null;

    await this.awaitReleaseWithin(
      Math.max(0, deadlineMs - (Date.now() - startedAt)),
      mine,
    );
  }

  /**
   * Tells the server this session is no longer needed. Best effort, and the
   * answer is not depended on: whether and when the server frees it is its own
   * affair, and this connection does not check afterwards.
   *
   * ICF rather than ADT because ADT publishes no such endpoint: its discovery
   * document lists none on any reachable system — on-prem, cloud, or legacy —
   * and the ADT logon is the discovery call itself. `/sap/public/bc/icf/logoff`
   * is the platform's own, and answers `200` while expiring the session cookie.
   *
   * **One session, this connection's own.** A repeat `connect()` opens a NEW
   * one, with a new `SAP_SESSIONID`, so an earlier session is not this
   * connection's business any more: its logoff is already on the wire, or the
   * system will time it out. Nothing here retries, counts, or keeps a list —
   * how many connections to run and how carefully stays with the caller.
   *
   * **It ends the session, not this object's use of it.** The cookies are the
   * only thing tying anyone to a session, so a second connection given the same
   * cookies works in the same ABAP session and can use the locks taken in it —
   * and this logoff closes that session for all of them at once. Whoever hands
   * the cookies around owns that decision; this method cannot see the copies.
   *
   * Never throws. `disconnect()` must always settle, and a session we could not
   * close is better than a teardown that does not finish; the local state is
   * cleared either way.
   */
  private async releaseServerSession(): Promise<void> {
    const id = this.getSessionIdentity();
    const cookies = this.cookies;
    if (!id || !cookies) {
      // No session, or no cookie to prove it is ours. Holding the cookie is the
      // whole permission to close it.
      return;
    }

    // No critical-section guard here, deliberately. `beginTeardown()` above has
    // already shut admission, so the unlock of a chain in flight is refused
    // whether or not the server is told — skipping the goodbye does not rescue
    // the chain, it only leaves the session open. And the depth is decremented
    // by `endCriticalSection()` alone, so one caller forgetting its `finally`
    // would silence every release on this connection for good: a caller's bug
    // turned into the leak this whole change exists to stop. Not disconnecting
    // mid-chain is the caller's to get right.

    // Already on its way for THIS session: a second would tell the server the
    // same thing twice.
    if (this.pendingRelease?.id === id) {
      return;
    }

    // Which mechanism this system publishes was settled at establishment: a
    // session resource to DELETE on ABAP Cloud, the platform's ICF logoff on
    // on-prem. Both say the same thing — we have finished with this session —
    // and neither is asked what the server then did about it.
    // Assembling it can throw before anything is sent — `sessionTransport()`
    // builds the client, and a certificate connection whose material is not
    // loaded throws there. `disconnect()` promises never to throw, and it is
    // called from a `finally`, where an exception would replace the error that
    // sent the caller into it.
    let send: Promise<void>;
    try {
      send = this.sessionStrategy.closeSession(this.sessionTransport());
    } catch (error) {
      this.logger?.debug(
        `Could not tell the server the session is finished: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    // Reported when it lands, waited for or not: "nobody is waiting on it" is
    // not "nobody wants to know". A rejection handler even though `closeSession`
    // is meant never to throw: that is an invariant of another unit, and an
    // unhandled rejection here would crash a process over a teardown the caller
    // declined to wait for.
    const settled = send.then(
      () => {
        if (this.pendingRelease?.id === id) {
          this.pendingRelease = null;
        }
      },
      (error: unknown) => {
        if (this.pendingRelease?.id === id) {
          this.pendingRelease = null;
        }
        this.logger?.debug(
          `Could not tell the server the session is finished: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );

    this.pendingRelease = { id, inFlight: settled };
  }

  /**
   * Waits up to `budgetMs` for a release already on its way, then detaches.
   *
   * Detaching, not cancelling: when the budget runs out this stops waiting and
   * the request carries on to the server. Each caller of `disconnect()` gets
   * its own, so one caller's patience is never charged to another's.
   */
  private async awaitReleaseWithin(
    budgetMs: number,
    release: Promise<void> | null,
  ): Promise<void> {
    if (!release || budgetMs === 0) {
      return;
    }

    // Detaching, not cancelling: when the budget runs out this stops waiting and
    // the request carries on to the server. `unref` so a process that is
    // otherwise done does not stay alive for the timer, and cleared when the
    // release wins the race.
    let expire: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      expire = setTimeout(resolve, budgetMs);
      expire.unref?.();
    });

    // `release` never rejects — its handlers are attached at dispatch — so this
    // needs no catch to keep "never throws" true.
    await Promise.race([release, deadline]);
    if (expire) {
      clearTimeout(expire);
    }
  }

  isConnected(): boolean {
    return this.lifecycle.connected;
  }

  /**
   * Fingerprint of the SAP-side session, or null when none is known.
   *
   * `null` is NOT a statement about the connection. Two situations produce it:
   * no session exists, or the connection is live over a server that issued no
   * session cookie. Use {@link isConnected} for connection state.
   *
   * It follows that null → non-null is not a replacement but an identity being
   * learned; only a CHANGED value means the session we had is gone.
   */
  getSessionIdentity(): string | null {
    return this.lifecycle.identity;
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
  /**
   * What a session strategy is given: enough to make one request and to prove
   * the session is ours, and nothing else. It cannot reach session state, so a
   * strategy can neither mark this connection connected nor tear it down.
   */
  protected sessionTransport(): ISessionTransport {
    // A SNAPSHOT, not a view. The close is dispatched without being awaited —
    // a teardown does not wait for it — so `clearSessionState()` runs while the
    // strategy is still suspended on its first `await`. Reading the connection
    // then would find the axios instance already dropped and the cookies gone,
    // and the request would go out through a freshly built client with no
    // session on it, or not at all. Taken here, while they are still true.
    const instance = this.getAxiosInstance();
    const cookies = this.cookies;
    const csrfToken = this.csrfToken;
    return {
      baseUrl: this.baseUrl,
      // The affinity headers ride along with auth: the open must be answered by
      // the server that will hold the session, and the close must reach the one
      // that holds it.
      authHeaders: async () => ({
        ...(await this.getAuthHeaders()),
        ...this.affinityHeaders(),
      }),
      cookies: () => cookies,
      csrfToken: () => csrfToken,
      send: async (request) => {
        const response = await instance({
          method: request.method,
          url: request.url,
          headers: request.headers,
          ...(request.timeoutMs !== undefined
            ? { timeout: request.timeoutMs }
            : {}),
          // A 404 is an answer — "this system has no session resource" — and a
          // 403 on a close is the server declining a message. Both belong to
          // the strategy to read, not to axios to throw over.
          validateStatus: () => true,
        });
        // Only the open: its cookies ARE the session — SAP_SESSIONID arrives
        // there — and they go through the same path every other response uses.
        // No generation, because like the establishing CSRF fetch this is what
        // creates the session a generation would be compared against. A close
        // is deliberately not observed: its cookies would read as the session
        // having been replaced under a connection that is being torn down.
        if (request.adoptCookies) {
          // Cookies adopted, verdict NOT asked for. The identity policy answers
          // "did the server move us to a different session while we were
          // working" — and this request is us opening one, with the
          // establishing call still to come. Two requests we make ourselves,
          // back to back, are one establishment; policing between them would
          // read our own second call as somebody replacing our first.
          const headers = response.headers as
            | Record<string, unknown>
            | undefined;
          // The open is the first answer that can name the application server,
          // and every request after it should already be pinned there.
          this.rememberAppServer(headers);
          this.updateCookiesFromResponse(headers);
        }
        return {
          status: response.status,
          headers: response.headers,
          data: response.data,
        };
      },
    };
  }

  /**
   * Ask the server to open a session before the establishing call needs one.
   *
   * The strategy is chosen by what the server publishes, not by which system we
   * believe it to be: ABAP Cloud offers a session resource and issues
   * `SAP_SESSIONID` to whoever asks for one — with `x-sap-security-session:
   * create` — while on-prem has no such resource and its session arrives with
   * the establishing request. Believing cloud simply "issues no SAP_SESSIONID"
   * is what happens when nobody asks.
   */
  /**
   * Which session management this system uses — decided by the connection, not
   * discovered by asking.
   *
   * On-prem and cloud do not manage sessions the same way, and the two
   * implementations exist for that reason. On-prem the session arrives with the
   * establishing request and the platform's ICF logoff gives it back, exactly as
   * it always has. Cloud opens a session resource and takes it back by DELETE on
   * the address the server published.
   *
   * Probing was tried and is wrong: `/sap/bc/adt/core/http/sessions` answers on
   * on-prem too — measured on S/4HANA, which publishes both the session resource
   * and the ICF logoff in the same document — so a probe does not tell the two
   * systems apart. It only tells whether an endpoint exists, and both have it.
   */
  protected createSessionStrategy(): SessionStrategy {
    return new IcfSessionStrategy(this.logger);
  }

  private async openServerSession(): Promise<void> {
    this.sessionStrategy = this.createSessionStrategy();
    this.preflightOpenedSession = await this.sessionStrategy.openSession(
      this.sessionTransport(),
    );
    this.logger?.debug(`Session strategy: ${this.sessionStrategy.kind}`);
  }

  private async establishAndCommit(baselineEpoch: number): Promise<void> {
    if (this.lifecycle.teardownEpoch !== baselineEpoch) {
      throw sessionError(
        ADT_SESSION_ERROR.NOT_CONNECTED,
        'Establishment abandoned: a teardown was requested for this connection',
      );
    }

    // Whatever session arrives from here is one we are deliberately
    // establishing, so it must not read as a replacement: the identity policy
    // treats a changed fingerprint as fatal, and it cannot tell our own
    // re-establishment from a session taken out from under us. Forgetting first
    // makes the new fingerprint `established`, which is what it is.
    this.lifecycle.forgetIdentity();
    try {
      // First, because the preflight below has to be able to authenticate: the
      // credential of a certificate or Kerberos connection is not in hand until
      // it is loaded or minted, and assembling a request without it throws.
      await this.prepareCredential();
      // Before the establishing call, because on a system that has one this is
      // what creates the session the rest of the connection runs in — and the
      // cookies it sets are the ones the establishing call must carry.
      await this.openServerSession();
      // Forgotten again, because the open was OURS. Establishment is now two
      // requests where it used to be one, and the identity policy answers "did
      // the server move us to a different session while we were working" — a
      // question that has no meaning between two calls we make ourselves to set
      // this session up. The identity that counts is taken at the end, from the
      // cookies we finish with.
      this.lifecycle.forgetIdentity();
      await this.establishSession();
    } catch (error) {
      // A failed establishment leaves debris that poisons the next attempt: the
      // 401 that rejected us may still have carried a Set-Cookie, and every
      // subclass treats a cookie as proof that auth is already settled —
      // buildAuthorizationHeader() returns '' once one exists. So the next
      // connect() would go out with NO credentials at all, and be rejected for
      // a reason that has nothing to do with why the first one failed.
      //
      // Safe to clear here, unlike the abandonment path below: establishSession()
      // threw, so no session was published, and admission requires a connected
      // lifecycle — nothing can be in flight over what this drops.
      //
      // But say goodbye FIRST. The preflight may already have opened a session
      // — on cloud it does, and the SAP_SESSIONID is in the cookies about to be
      // dropped — and establishing can still fail after it, on a credential the
      // preflight never used. Clearing without telling the server would leak
      // exactly the session this release exists to stop leaking, and leave it
      // unreachable: the connection is not connected, so disconnect() sends
      // nothing, and the cookie that was the only permission to close it is
      // gone. The transport is a snapshot, so this survives the clearing that
      // follows it.
      // Only when the preflight opened one. A cookie left by the 401 that
      // rejected us is debris, not a session, and telling the server we are
      // finished with something we never had sends a request nobody asked for
      // — into the middle of an authentication exchange, in the case that found
      // this.
      const goodbye = this.preflightOpenedSession
        ? this.sessionStrategy.closeSession(this.sessionTransport())
        : Promise.resolve();
      this.invalidateSession();
      // And the identity with it. The rejecting response was still observed, so
      // its cookie was recorded as a session that had just been established —
      // leaving getSessionIdentity() naming a session that never existed while
      // isConnected() says false. Two answers to one question is worse than
      // either.
      this.lifecycle.markDisconnected();
      // Not awaited, for the same reason a teardown does not wait: the caller
      // is owed the establishment error now, not after a round trip nobody is
      // waiting on. closeSession never throws, so nothing here can go unhandled.
      void goodbye;
      throw error;
    }

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

    // The session IS the SAP_SESSIONID the server issued; our own session id is
    // a conversation label we generate and says nothing about what exists on
    // the other side. An empty fingerprint therefore means the server opened no
    // session — on-prem it answers with `sap-XSRF_*` instead once enough
    // sessions are already open for the user — and such a connection still gets
    // `200` for a LOCK and hands back a handle the next request cannot use.
    //
    // SAP_SESSIONID names the ABAP session — the one locks are bound to. Its
    // absence is therefore not a transport problem: the HTTP side is fine, the
    // cookies are here, and stateless requests will work. What is missing is any
    // ABAP session known to this connection, so there is nothing a lock could be
    // bound to and every lock taken over it is dead the moment it is issued.
    //
    // Checked rather than assumed: a connection that got no cookie was held open
    // against an on-prem system and the session list showed nothing for it,
    // while one that got a cookie appeared there.
    //
    // Which is why this refuses to connect rather than warning. There is no
    // count to plan around — the same system allowed 21 sessions one day and
    // refused an eleventh the next — so a caller cannot avoid the condition by
    // being frugal, and the only reliable signal is whether THIS connect got a
    // session. Reported with its cause; recovering is the caller's call, and
    // nothing here retries on anyone's behalf.
    //
    // Reported, not decided on. A session that was not opened is a condition on
    // the server, and what to do about it — wait, retry, release sessions this
    // user still holds, carry on read-only over a fresh connection — depends on
    // things only the caller knows. So it is raised where the caller can catch
    // it, with enough in the message to act on, and nothing is retried here.
    //
    // Every transport, not only basic: splitting by authentication type would
    // encode a guess about cloud ABAP, whose ADT endpoint would not answer the
    // bearer obtainable here, so the question stayed open. If a cloud system
    // turns out to hold sessions without issuing this cookie, this is the rule
    // to revisit — and it will say so loudly rather than fail quietly.
    const fingerprint = this.sessionFingerprint();
    if (fingerprint.size === 0 && !this.skipSessionType) {
      // Goodbye first, for the same reason the catch above does it: the
      // preflight may have opened a session — on cloud it does — and this path
      // is about to drop the cookies that are the only permission to close it.
      // Refusing to connect must not leak the session the refusal is about.
      if (this.preflightOpenedSession) {
        try {
          void this.sessionStrategy.closeSession(this.sessionTransport());
        } catch (error) {
          this.logger?.debug(
            `Could not tell the server the session is finished: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      this.invalidateSession();
      this.lifecycle.forgetIdentity();
      this.lifecycle.markDisconnected();
      throw sessionError(
        ADT_SESSION_ERROR.NOT_CONNECTED,
        'The server authenticated the request but opened no ABAP session: no SAP_SESSIONID cookie came back, so there is no session for a lock to be bound to. The HTTP side is fine — the cookies are here — which is why this is not a transport failure and does not look like one. ' +
          'Stateless reads would still work over it, but a lock, and any write under that lock, is dead the moment it is issued. ' +
          'The usual cause is the system declining to open another session for this user: they are limited per user, shared with every other tool logged on as them, and released either by disconnecting or by their own idle timeout. ' +
          'Whether to wait, retry, or release sessions this user still holds is yours to decide — this library does not retry on your behalf.',
      );
    }

    this.lifecycle.markConnected(fingerprint);
  }

  /** The teardown epoch, for a recovery to capture before it starts. */
  protected get teardownEpoch(): number {
    return this.lifecycle.teardownEpoch;
  }

  /**
   * Which session the connection is on now.
   *
   * Moves whenever the session does. A response that comes back carrying an
   * older one belongs to a session that has already been replaced, and must not
   * be acted on as if it said something about the current one.
   */
  protected get sessionGeneration(): number {
    return this.lifecycle.sessionGeneration;
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
   * Does not await: it is called from inside a request, and the cleanup must not
   * wait for the very request that raised it.
   */
  protected raiseSessionLost(reason: string): void {
    this.logger?.warn(`Session lost: ${reason}`);
    this.lifecycle.beginTeardown({ origin: 'internal', sessionLost: true });
    void this.lifecycle.transition('cleanup', async () => {
      this.clearSessionState();
      this.lifecycle.markDisconnected();
    });
  }

  /** The credential-renewal raiser; see raiseSessionLost(). */
  protected discardSession(): void {
    this.raiseSessionLost('the credential backing it was renewed');
  }

  /**
   * Whether an error is this connection's own verdict about the session rather
   * than something the server said about a request.
   *
   * A retry path that swallows one of these and rethrows the original error
   * turns "your lock is dead" back into "your request 403'd", which is the very
   * information the caller needs and the only one it cannot recover itself.
   */
  private isSessionVerdict(error: unknown): boolean {
    const code = (error as { code?: unknown } | null)?.code;
    return (
      code === ADT_SESSION_ERROR.SESSION_REPLACED ||
      code === ADT_SESSION_ERROR.NOT_CONNECTED ||
      code === ADT_SESSION_ERROR.RELEASE_PENDING
    );
  }

  /**
   * Folds a response into the session state AND acts on what it means, in one
   * step.
   *
   * Never call updateCookiesFromResponse() directly: it MUTATES the fingerprint,
   * so discarding its classification absorbs a replacement silently and every
   * later check reads `unchanged`. That is one call site forgetting, and it
   * happened — on the error path and on every retry response.
   */
  private observeResponse(
    headers?: Record<string, unknown>,
    generation?: number,
  ): void {
    // Fenced by SESSION GENERATION, not by the teardown epoch. Only a
    // caller-initiated teardown moves the epoch — a recovery deliberately does
    // not — so after a session loss and a successful recovery, a request from
    // the dead session carries the same epoch as the new one and would sail
    // straight through. The generation moves whenever the current session does.
    //
    // `undefined` means "not issued against a session": the CSRF fetch during
    // connect() has no lease and must apply, since it is establishing the very
    // session this would compare against.
    if (
      generation !== undefined &&
      generation !== this.lifecycle.sessionGeneration
    ) {
      this.logger?.debug(
        'Ignoring a response from a previous session: its effects are fenced',
      );
      return;
    }
    this.rememberAppServer(headers);
    this.applyIdentityPolicy(this.updateCookiesFromResponse(headers));
  }

  /**
   * Take the application server's name from a response, if it named one.
   *
   * Only ever set from the server's own answer — never guessed, and never kept
   * across a teardown.
   */
  private rememberAppServer(headers?: Record<string, unknown>): void {
    if (!headers) return;
    const key = Object.keys(headers).find(
      (k) => k.toLowerCase() === 'sap-adt-saplb',
    );
    const value = key ? headers[key] : undefined;
    if (typeof value === 'string' && value && value !== this.appServer) {
      this.appServer = value;
      this.logger?.debug(`Session is on application server ${value}`);
    }
  }

  /**
   * Headers that keep this connection on the server its session lives on.
   *
   * `sap-adt-saplb: fetch` asks the server to name itself — it answers on every
   * request, so the binding survives a restart that moves us. `saplb` is that
   * name sent back. `REDISPATCH_ON_SHUTDOWN` is what Eclipse asks for: if the
   * server is going down, send us elsewhere rather than fail.
   */
  private affinityHeaders(): Record<string, string> {
    return {
      'sap-adt-saplb': 'fetch',
      ...(this.appServer
        ? { saplb: this.appServer, 'saplb-options': 'REDISPATCH_ON_SHUTDOWN' }
        : {}),
    };
  }

  /**
   * Acts on what a response said about the session identity.
   *
   * A replacement is always fatal, and that is a narrowing: an earlier version
   * tolerated it "when no lock is held", deciding from the connection's own
   * lock windows. Those are gone, and rightly — this layer does not know that a
   * lock exists, what object it covers or what would release it. Locks are
   * tracked a layer up, per object, by the code that took them.
   *
   * So the rule is written from what this layer CAN know: the ABAP session we
   * were speaking to is not the one we are speaking to now. Anything the caller
   * held against the old one is dead, and continuing quietly would hand them a
   * session they never opened — the failure this whole design exists to prevent.
   * Being wrong in this direction costs a reconnect; being wrong the other way
   * costs a lock nobody can find.
   */
  private applyIdentityPolicy(
    classification: 'unchanged' | 'established' | 'replaced',
  ): void {
    if (classification !== 'replaced') return;

    this.raiseSessionLost('the session cookie changed under us');
    throw sessionError(
      ADT_SESSION_ERROR.SESSION_REPLACED,
      'The SAP session this connection was using is gone and the requests are now on a different one; anything held against the old session — a lock and any write under it — is dead. ' +
        'The server does not swap sessions on a whim: the usual causes are the session idling out (the timeout is idle-based, so a quiet connection loses it while a busy one does not) or a request landing on a different application server. ' +
        'What to do about it is yours: re-establish and redo the work, or fail the operation. Nothing is retried here.',
    );
  }

  /**
   * Whether the server is telling us the session it was given no longer exists.
   *
   * One on-prem system answered HTTP 400 with "Session not found", answered in ~60 ms
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
    // Names a server for a session that no longer exists.
    this.appServer = null;
    this.preflightOpenedSession = false;
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
      return await this.performRequest<T, D>(options, lease);
    } finally {
      lease.release();
    }
  }

  private async performRequest<T = any, D = any>(
    options: AbapRequestOptions,
    lease: Pick<RequestLease, 'generation'>,
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

    // Keep this request on the server the session lives on. A session belongs
    // to one application server, so a request that lands elsewhere gets a
    // different session — and any lock held on the first one dies, with no
    // inactivity and nobody at fault.
    Object.assign(requestHeaders, this.affinityHeaders());

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

    // Add cookies LAST (MUST NOT be overridden by custom headers), MERGED with
    // whatever the auth headers already put there — see mergeCookieHeaders.
    if (this.cookies) {
      requestHeaders.Cookie = mergeCookieHeaders(
        requestHeaders.Cookie,
        this.cookies,
      );
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
      this.observeResponse(response.headers, lease.generation);

      this.logger?.debug(`Request succeeded with status ${response.status}`, {
        type: 'REQUEST_SUCCESS',
        status: response.status,
        url: requestUrl,
        method: normalizedMethod,
      });

      return response as unknown as IAdtResponse<T, D>;
    } catch (error) {
      // FENCE FIRST, before anything reads or writes shared state.
      //
      // Fencing observeResponse() alone was not enough, and the gap was wide:
      // everything below acts on this connection, not on the request. A late
      // 400 "session not found" would call raiseSessionLost() and tear down the
      // healthy session established since; a late 401/403 would call
      // invalidateSession(), write a fresh CSRF token, and RETRY — replaying a
      // mutation from a dead session inside the live one.
      //
      // A stale request gets its error back and nothing else happens.
      if (!this.lifecycle.isCurrent(lease)) {
        this.logger?.debug(
          'A request from a previous session failed; its recovery is fenced',
        );
        throw error;
      }

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

        this.observeResponse(error.response.headers, lease.generation);
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
          this.setCsrfToken(
            await this.fetchCsrfToken(requestUrl, 5, 2000, lease.generation),
          );
          const refreshedToken = this.getCsrfToken();
          if (refreshedToken) {
            requestHeaders['x-csrf-token'] = refreshedToken;
          }
          const refreshedCookies = this.getCookies();
          if (refreshedCookies) {
            requestHeaders.Cookie = refreshedCookies;
          }

          const retryResponse = await this.getAxiosInstance()(requestConfig);
          this.observeResponse(retryResponse.headers, lease.generation);

          return retryResponse as unknown as IAdtResponse<T, D>;
        } catch (retryError) {
          // A session verdict outranks the error that started the retry: the
          // caller can retry a 403 itself, but it cannot discover that its lock
          // handle is dead from a 403.
          if (this.isSessionVerdict(retryError)) {
            throw retryError;
          }
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
          this.observeResponse(retryResponse.headers, lease.generation);

          return retryResponse as unknown as IAdtResponse<T, D>;
        }

        // If no cookies, try to get them via CSRF token fetch
        this.logger?.debug(
          `[DEBUG] BaseAbapConnection - 401 on GET request, attempting to get cookies via CSRF token fetch`,
        );
        try {
          // Try to get CSRF token (this will also get cookies)
          this.csrfToken = await this.fetchCsrfToken(
            requestUrl,
            3,
            1000,
            lease.generation,
          );
          if (this.cookies) {
            requestHeaders.Cookie = this.cookies;
            this.logger?.debug(
              `[DEBUG] BaseAbapConnection - Retrying GET request with cookies from CSRF fetch`,
            );

            const retryResponse = await this.getAxiosInstance()(requestConfig);
            this.observeResponse(retryResponse.headers, lease.generation);

            return retryResponse as unknown as IAdtResponse<T, D>;
          }
        } catch (csrfError) {
          if (this.isSessionVerdict(csrfError)) {
            throw csrfError;
          }
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
    /** Fences the response effects; omitted during connect(), which has no lease. */
    generation?: number,
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
          generation,
        );
      } catch (error) {
        // Third layer with a catch on this path, and the last one that could
        // bury a verdict: falling through to the fallback endpoint would open
        // ANOTHER session, and by then the teardown has cleared the fingerprint
        // so the new one reads as `established` and the loss disappears.
        if (this.isSessionVerdict(error)) {
          throw error;
        }
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
    generation?: number,
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

        // Same reason as every other request: a token fetched from another
        // application server belongs to another session.
        Object.assign(headers, this.affinityHeaders());

        // Always add cookies if available - they are needed for session continuity
        // Even on first attempt, if we have cookies from previous session or error response, use them
        if (this.cookies) {
          headers.Cookie = mergeCookieHeaders(headers.Cookie, this.cookies);
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

        this.observeResponse(response.headers, generation);

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
          this.observeResponse(response.headers, generation);
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
        // A session verdict is not a failed token fetch and must not be
        // retried into silence: the retry would observe the SAME new session,
        // read it as `unchanged`, and the replacement this raised would be gone
        // for good. It leaves immediately, past the loop and past the caller's
        // recovery.
        if (this.isSessionVerdict(error)) {
          throw error;
        }

        if (error instanceof AxiosError) {
          // Always try to extract cookies from error response, even on 401
          // This ensures cookies are available for subsequent requests
          if (error.response?.headers) {
            this.observeResponse(error.response.headers, generation);
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
              this.observeResponse(error.response.headers, generation);
              return token;
            }
          }

          if (error.response?.headers['x-csrf-token']) {
            this.logger?.debug(
              `Got CSRF token despite error (status: ${error.response?.status})`,
            );

            const token = error.response.headers['x-csrf-token'] as string;
            this.observeResponse(error.response.headers, generation);
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
      // A transport that was said, not sniffed. Dressed in the axios shape the
      // six send sites are written against; see adaptTransport().
      if (this.adtTransport) {
        this.logger?.debug(`Transport: ${this.adtTransport.kind}`);
        const adapted = adaptTransport(this.adtTransport);
        this.axiosInstance = adapted;
        return adapted;
      }

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
   * Distinct from disconnect(): this leaves the axios instance and interceptors
   * in place, and tells the server nothing — it is a request-level repair, not a
   * teardown.
   */
  private invalidateSession(): void {
    this.setCsrfToken(null);
    this.cookies = null;
    this.cookieStore.clear();
    // Everything else that described THAT session. The application server named
    // a server for a session that is gone — sending it again would pin the next
    // connect, preflight included, to a dead one — and the preflight flag would
    // otherwise let a later failure send a goodbye to the previous session's
    // address.
    this.appServer = null;
    this.preflightOpenedSession = false;
    // And the tracked identity, because WE discarded the session. Without this
    // the cookie that arrives next reads as a foreign replacement — and since a
    // replacement is now always fatal, our own deliberate re-authentication
    // would tear the connection down. The distinction that matters is not
    // "was a lock held" but "did we cause this": what we discarded on purpose
    // is not a session taken from under us.
    this.lifecycle.forgetIdentity();
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
