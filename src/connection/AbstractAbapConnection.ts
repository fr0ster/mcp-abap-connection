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
import {
  type RequestLease,
  SessionLifecycle,
  sessionError,
} from '../session/SessionLifecycle.js';
import {
  getCriticalSectionTimeout,
  getReleaseDeadline,
  getTimeout,
} from '../utils/timeouts.js';
import type { AbapConnection, AbapRequestOptions } from './AbapConnection.js';
import { CSRF_CONFIG, CSRF_ERROR_MESSAGES } from './csrfConfig.js';
import {
  type IAdtSessionContext,
  type IAdtTransport,
  type IAdtTransportRequest,
  refusalOf,
} from './IAdtTransport.js';

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

  private baseUrl: string;
  private sessionId: string | null = null;
  private sessionMode: 'stateless' | 'stateful' = 'stateless';
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
  /**
   * Whether the preflight opened a session of its own.
   *
   * Distinct from "there are cookies": a failed establishment often leaves a
   * cookie from the 401 that rejected it, and that is debris, not a session.
   * Only a preflight answered with a session address opened one, and only that
   * is worth saying goodbye to when establishment then fails.
   */

  protected constructor(
    private readonly config: SapConfig,
    /**
     * Required, and constructed by the caller.
     *
     * There is no default to fall back to and nothing is worked out from the
     * config: the wire is a fact about the deployment, and a library that
     * picked one would be guessing at the thing this design exists to stop
     * guessing at. It also carries what the caller alone can wire — the
     * credential's TLS material, the client — which is why it arrives built.
     */
    readonly transport: IAdtTransport,
    protected readonly logger: ILogger | null,
    sessionId?: string,
  ) {
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
   * Whether the header actually goes out is the WIRE's: a system where the
   * stateful header makes the server store locks in session memory instead of
   * the enqueue table — BASIS 7.40 — is a different deployment, and a
   * deployment is a transport, not a flag on the connection.
   */
  setSessionType(type: 'stateful' | 'stateless'): void {
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

      // The wire gets a session in whatever way it has one: an RFC
      // conversation opened, a cloud session resource asked for, nothing at
      // all on a wire whose session arrives with the establishing call. Which
      // of those it is belongs to the transport the caller handed in.
      await this.transport.open(this.sessionContext());

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
   * **Nothing to wait for.** This TELLS the server the session is finished and
   * does not act on the answer — whether and when the session is freed is the
   * server's affair. Waiting for a reply nobody reads was also the one thing
   * that could make a teardown unbounded, since the goodbye carries no request
   * timeout by design.
   */
  async disconnect(): Promise<void> {
    // Nothing here throws. This method's place is a `finally` — a connection
    // that was connected must be disconnected — and an exception raised there
    // replaces the error that sent the caller into it.

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
      // DISPATCHED, not awaited. The goodbye carries no request timeout by
      // design — a server that never answers must not hold a teardown open —
      // so what the caller's `deadlineMs` bounds is the WAIT below, not the
      // request. Awaiting here would make every teardown unbounded and the
      // deadline meaningless.
      //
      // The context is taken now, while the session is still true: the clear
      // below runs while the close is suspended on its first await.
      const context = this.sessionContext();
      const inFlight = Promise.resolve(this.transport.close(context)).then(
        () => undefined,
      );
      this.clearSessionState();
      this.lifecycle.markDisconnected();
    });
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
  /**
   * Whether a 401 belongs to the credential rather than to the session.
   *
   * The session-level retries below exist to ACQUIRE COOKIES: discard a stale
   * CSRF token and ask again, or retry a GET now that the refusal has brought
   * cookies with it. They help exactly one kind of credential — one that
   * authenticates from scratch on every request with a header it can always
   * rebuild, so the only thing that can differ between two attempts is the
   * session.
   *
   * Two kinds they do not help, and actively harm:
   *
   *   - one that can RENEW. Retrying swallows the refusal, and the credential
   *     never learns the token it handed out was rejected.
   *   - one that CARRIES cookies of its own — a SAML session negotiated
   *     elsewhere and handed over. A 401 there says that session is dead, and
   *     no number of retries with the same cookies will change it.
   *
   * Asked of the credential rather than read off `config.authType`, which is
   * what this used to do. A config string is a claim about what was configured;
   * `renew` and `cookies` are the object saying what it actually is — and a
   * consumer's own provider gets the right answer without this class knowing it
   * exists.
   */
  protected credentialAnswersRefusals(): boolean {
    return false;
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
   * What a wire needs from this connection to get a session, or give one back.
   *
   * A snapshot in the sense that matters: a close is dispatched without being
   * awaited, so nothing here may read the connection again once the teardown
   * has cleared it.
   */
  protected sessionContext(): IAdtSessionContext {
    return {
      baseUrl: this.baseUrl,
      authHeaders: () => this.getAuthHeaders(),
      extraHeaders: { 'sap-adt-connection-id': this.getSessionId() ?? '' },
      observe: (headers) =>
        this.observeResponse(headers as Record<string, unknown>),
    };
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
      // Whether there is anything to say is the wire's to know: a cloud
      // session has an address or it does not, and an on-prem one was
      // established or the cookie is debris from the refusal. The connection
      // asks, and each wire answers by doing nothing when it has nothing.
      const goodbye = this.transport.close(this.sessionContext());
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
    if (!this.transport.sessionEstablished()) {
      // Goodbye first, for the same reason the catch above does it: the
      // preflight may have opened a session — on cloud it does — and this path
      // is about to drop the cookies that are the only permission to close it.
      // Refusing to connect must not leak the session the refusal is about.
      try {
        void this.transport.close(this.sessionContext());
      } catch (error) {
        this.logger?.debug(
          `Could not tell the server the session is finished: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.invalidateSession();
      this.lifecycle.forgetIdentity();
      this.lifecycle.markDisconnected();
      throw sessionError(
        ADT_SESSION_ERROR.NOT_CONNECTED,
        `The server authenticated the request but opened no ABAP session: the ${this.transport.kind} wire reports it is on none, so there is nothing for a lock to be bound to. The wire itself is fine — the request was carried and answered — which is why this is not a transport failure and does not look like one. ` +
          'Stateless reads would still work over it, but a lock, and any write under that lock, is dead the moment it is issued. ' +
          'The usual cause is the system declining to open another session for this user: they are limited per user, shared with every other tool logged on as them, and released either by disconnecting or by their own idle timeout. ' +
          'Whether to wait, retry, or release sessions this user still holds is yours to decide — this library does not retry on your behalf.',
      );
    }

    this.lifecycle.markConnected(this.sessionFingerprint());
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
  protected isSessionVerdict(error: unknown): boolean {
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
  protected observeResponse(
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
    // The wire folds the response into its own state; what the change MEANS
    // is decided here, because it is a question about the session's lifetime.
    this.transport.ingest(headers);
    this.applyIdentityPolicy(
      this.lifecycle.observe(this.transport.sessionFingerprint()),
    );
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
    const refusal = refusalOf(error);
    if (!refusal) return false;
    if (refusal.status !== 400) return false;

    const text = [
      refusal.statusText,
      typeof refusal.data === 'string' ? refusal.data : '',
    ]
      .join(' ')
      .toLowerCase();
    return text.includes('session not found');
  }

  /** Drops everything that described the session. Not a lifecycle transition. */
  private clearSessionState(): void {
    this.setCsrfToken(null);
    // Cookies, the fingerprint and the application server are the wire's, and
    // it gives them back together — a server named for a session that no
    // longer exists is as stale as the cookie that addressed it.
    this.transport.forgetSession();
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
    return this.transport.sessionFingerprint();
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

    // The PATH, not an address. Which server it belongs in front of — or
    // whether it belongs in front of one at all — is the wire's to say.
    const requestUrl = endpoint;

    // Try to ensure CSRF token is available for POST/PUT/DELETE, but don't fail if it can't be fetched
    // The retry logic will handle CSRF token errors automatically
    if (
      normalizedMethod === 'POST' ||
      normalizedMethod === 'PUT' ||
      normalizedMethod === 'DELETE'
    ) {
      if (!this.transport.csrfToken()) {
        try {
          await this.ensureWireReady();
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

    // Read once: the wire is asked what it holds, and the same value is what
    // goes on the header.
    const presented = this.transport.csrfToken();
    if (
      (normalizedMethod === 'POST' ||
        normalizedMethod === 'PUT' ||
        normalizedMethod === 'DELETE') &&
      presented
    ) {
      requestHeaders['x-csrf-token'] = presented;
    }

    // No cookies and no affinity headers here. Both are the wire's own state,
    // and the wire puts them on the requests it sends — a connection that
    // threaded them would be threading them for every transport, including one
    // that has neither.

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

    const requestConfig: IAdtTransportRequest = {
      method: normalizedMethod,
      url: requestUrl,
      headers: requestHeaders,
      timeout: effectiveTimeout,
      // `unknown` on the caller's options, a record on the seam: the two
      // transports serialise a query differently and both need the pairs.
      params: params as Record<string, unknown> | undefined,
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
      const response = await this.transport.send(requestConfig);
      this.observeResponse(
        response.headers as Record<string, unknown>,
        lease.generation,
      );

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
        status: refusalOf(error)?.status,
        data: undefined,
      };

      const refusal = refusalOf(error);
      if (refusal) {
        errorDetails.data =
          typeof refusal.data === 'string'
            ? refusal.data.slice(0, 200)
            : JSON.stringify(refusal.data).slice(0, 200);

        // Every wire's refusal, not only axios's. A response the connection
        // never observed is a session replacement it never noticed.
        this.observeResponse(
          refusal.headers as Record<string, unknown> | undefined,
          lease.generation,
        );
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

      // The "login-form 401": SAP refused a mutation while we hold a cached CSRF
      // token, so the token and the session it is bound to are dead and must be
      // discarded before the retry.
      //
      // Not keyed on the credential any more. It used to be "basic auth only —
      // JWT/SAML lifecycles are managed elsewhere", and elsewhere was
      // JwtAbapConnection, which is gone. Credential renewal now lives a layer
      // ABOVE this, in CredentialAbapConnection, which wraps the whole request:
      // these retries happen first and it only sees a 401 that survived them.
      // Nothing collides, so nothing needs to be excluded.
      const isCachedTokenStale =
        !this.credentialAnswersRefusals() &&
        (normalizedMethod === 'POST' ||
          normalizedMethod === 'PUT' ||
          normalizedMethod === 'DELETE') &&
        refusalOf(error)?.status === 401 &&
        this.getCsrfToken() !== null;

      // Retry logic for CSRF token errors (403 with CSRF message) and the
      // login-form 401 pattern.
      if (this.shouldRetryCsrf(error, normalizedMethod) || isCachedTokenStale) {
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

          const retryResponse = await this.transport.send(requestConfig);
          this.observeResponse(
            retryResponse.headers as Record<string, unknown>,
            lease.generation,
          );

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

      // A 401 on a GET where cookies have since arrived: the first request had
      // none, and the session they name is what the retry needs. Guarded below
      // on actually holding some, so a wire that issues no cookies — RFC —
      // never takes it.
      if (
        refusalOf(error)?.status === 401 &&
        normalizedMethod === 'GET' &&
        !this.credentialAnswersRefusals()
      ) {
        // If we already have cookies from error response, retry immediately
        const afterError = this.transport.cookies();
        if (afterError) {
          this.logger?.debug(
            `[DEBUG] BaseAbapConnection - 401 on GET request, retrying with cookies from error response`,
          );
          requestHeaders.Cookie = afterError;

          const retryResponse = await this.transport.send(requestConfig);
          this.observeResponse(
            retryResponse.headers as Record<string, unknown>,
            lease.generation,
          );

          return retryResponse as unknown as IAdtResponse<T, D>;
        }

        // If no cookies, try to get them via CSRF token fetch
        this.logger?.debug(
          `[DEBUG] BaseAbapConnection - 401 on GET request, attempting to get cookies via CSRF token fetch`,
        );
        try {
          // Try to get CSRF token (this will also get cookies)
          this.setCsrfToken(
            await this.fetchCsrfToken(requestUrl, 3, 1000, lease.generation),
          );
          const afterCsrf = this.transport.cookies();
          if (afterCsrf) {
            requestHeaders.Cookie = afterCsrf;
            this.logger?.debug(
              `[DEBUG] BaseAbapConnection - Retrying GET request with cookies from CSRF fetch`,
            );

            const retryResponse = await this.transport.send(requestConfig);
            this.observeResponse(
              retryResponse.headers as Record<string, unknown>,
              lease.generation,
            );

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
   * Ask the wire to establish itself, and hand back what it earned.
   *
   * The exchange itself is the transport's — it is the HTTP wire that has a
   * token to earn and an endpoint to earn it from, and the RFC wire that has
   * neither. What stays here is the part that is about the SESSION rather than
   * the wire: fencing the answer by generation, and letting the identity policy
   * read what it means.
   */
  protected async fetchCsrfToken(
    _url: string,
    retryCount: number = CSRF_CONFIG.RETRY_COUNT,
    retryDelay: number = CSRF_CONFIG.RETRY_DELAY,
    /** Fences the response effects; omitted during connect(), which has no lease. */
    generation?: number,
  ): Promise<string> {
    // Dropped first, because this is only ever reached to REPLACE one: the
    // establishment is idempotent and would hand back the very token the
    // caller has just been told is stale.
    this.transport.adoptCsrfToken(null);
    await this.transport.establish({
      baseUrl: this.baseUrl,
      authHeaders: () => this.getAuthHeaders(),
      extraHeaders: { 'sap-adt-connection-id': this.sessionId ?? '' },
      observe: (headers) =>
        this.observeResponse(headers as Record<string, unknown>, generation),
      retries: retryCount,
      retryDelayMs: retryDelay,
      timeoutMs: getTimeout('csrf'),
      isFatal: (error) => this.isSessionVerdict(error),
    });

    const token = this.transport.csrfToken();
    if (!token) throw new Error(CSRF_ERROR_MESSAGES.NOT_IN_HEADERS);
    return token;
  }
  protected getCsrfToken(): string | null {
    return this.transport.csrfToken();
  }

  /**
   * Set CSRF token (protected for use by subclasses)
   */
  protected setCsrfToken(token: string | null): void {
    // A credential that did the exchange itself hands the token to the wire
    // that will present it.
    this.transport.adoptCsrfToken(token);
  }

  /**
   * Get cookies (protected for use by subclasses)
   */
  protected getCookies(): string | null {
    return this.transport.cookies();
  }

  /**
   * Seed the wire with cookies the caller already holds — a SAML session, which
   * IS the credential rather than something a logon call earns.
   *
   * Handed over as a response would deliver them, because the wire owns the jar
   * and how it stores them is its business, not this class's.
   */
  protected setInitialCookies(cookies: string): void {
    this.transport.ingest({
      'set-cookie': cookies.split(';').map((entry) => entry.trim()),
    });
  }

  /**
   * Subclasses override to inject extra https.Agent options (e.g. mTLS
   * cert/key/pfx). The returned options are merged with the base options
   * (rejectUnauthorized).
   */
  protected getHttpsAgentOptions(): import('node:https').AgentOptions {
    return {};
  }

  /**
   * Make sure the wire is ready to carry a mutation.
   *
   * What ready MEANS is the wire's: HTTP holds a CSRF token and returns at once
   * when it already has one; an RFC conversation has nothing to earn and does
   * nothing. Demanding a token back was an HTTP assumption, and over RFC it
   * raised `No CSRF token in response headers` before every write — swallowed
   * by the caller, but logged as an error and repeated on the next one.
   */
  private async ensureWireReady(): Promise<void> {
    await this.transport.establish({
      baseUrl: this.baseUrl,
      authHeaders: () => this.getAuthHeaders(),
      extraHeaders: { 'sap-adt-connection-id': this.sessionId ?? '' },
      observe: (headers) =>
        this.observeResponse(headers as Record<string, unknown>),
      isFatal: (error) => this.isSessionVerdict(error),
    });
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
    // The wire's state described THAT session: the cookies, the fingerprint
    // taken from them, and the application server it lived on. Sending the
    // server name again would pin the next connect — preflight included — to a
    // server whose session is gone.
    this.transport.forgetSession();
    // Everything else that described THAT session. The application server named
    // And the tracked identity, because WE discarded the session. Without this
    // the cookie that arrives next reads as a foreign replacement — and since a
    // replacement is now always fatal, our own deliberate re-authentication
    // would tear the connection down. The distinction that matters is not
    // "was a lock held" but "did we cause this": what we discarded on purpose
    // is not a session taken from under us.
    this.lifecycle.forgetIdentity();
  }

  private shouldRetryCsrf(error: unknown, method?: string): boolean {
    const refusal = refusalOf(error);
    if (!refusal) {
      return false;
    }

    // The credential answers this one; retrying here would swallow the 401 it
    // needs to see, or repeat cookies that are already dead.
    if (this.credentialAnswersRefusals()) {
      return false;
    }

    const responseData = refusal.data;
    const responseText =
      typeof responseData === 'string'
        ? responseData
        : JSON.stringify(responseData || '');

    // Retry on 403 with CSRF message, or if response mentions CSRF token
    // Also retry on 401 for POST/PUT/DELETE if we don't have CSRF token yet (might need to get cookies first)
    // Handed in rather than read off `error.config`, which is axios's own
    // record of the request and does not exist on another wire's refusal. The
    // caller already normalised the method; asking the error for it was asking
    // the HTTP client.
    const normalized = method?.toUpperCase();
    const isPostPutDelete =
      normalized && ['POST', 'PUT', 'DELETE'].includes(normalized);
    const needsCsrfToken = !!isPostPutDelete && !this.transport.csrfToken();

    return (
      (refusal.status === 403 && responseText.includes('CSRF')) ||
      responseText.includes('CSRF token') ||
      (needsCsrfToken && refusal.status === 401)
    );
  }
}

export { AbstractAbapConnection };
