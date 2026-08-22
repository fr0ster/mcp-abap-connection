/**
 * A connection whose authentication is passed in.
 *
 * The shared half of the two platform connectors, and the reason the split is
 * possible at all: `establishSession()` was measured to be the same work in
 * every one of the five auth classes — fetch a CSRF token from
 * `/sap/bc/adt/discovery`, keep it, tolerate a failure — with the only
 * per-credential part being a step before it. That step is `prepare()`.
 *
 * So this owns the establishing call, and the credential contributes three
 * things at most: what to prepare, what header to send, and what TLS material
 * to present. Which system this is talking to was stated by the caller when it
 * chose the subclass, and is never worked out here.
 */

import type { AgentOptions } from 'node:https';
import type {
  IAbapRequestOptions,
  IAdtResponse,
  IAuthProvider,
} from '@mcp-abap-adt/interfaces';
import type { SapConfig } from '../config/sapConfig.js';
import type { ILogger } from '../logger.js';
import { AbstractAbapConnection } from './AbstractAbapConnection.js';
import { type IAdtTransport, refusalOf } from './IAdtTransport.js';

/** A 401 from the server, whatever transport shape it arrives in. */
function isUnauthorized(error: unknown): boolean {
  const status = (error as { response?: { status?: number } })?.response
    ?.status;
  return status === 401;
}

export abstract class CredentialAbapConnection<
  TCredential extends IAuthProvider = IAuthProvider,
> extends AbstractAbapConnection {
  constructor(
    config: SapConfig,
    /** Public because the type is the point: a caller can reach what it gave. */
    readonly credential: TCredential,
    logger: ILogger | null = null,
    sessionId?: string,
    options?: { skipSessionType?: boolean; transport?: IAdtTransport },
  ) {
    super(config, logger, sessionId, options);
  }

  /**
   * Whatever the credential needs before the first request goes out.
   *
   * Runs before the preflight, not inside the establishing call: building the
   * transport reads the TLS options, and a certificate whose material had not
   * been loaded yet rejected the connect while the argument was still being
   * evaluated — outside every catch, with no request sent.
   */
  /** The header last put on the wire, so a change can be seen. */
  private lastAuthorization = '';
  private credentialRenewal?: Promise<boolean>;

  protected override async prepareCredential(): Promise<void> {
    await this.credential.prepare?.();
  }

  /**
   * Nothing here: the header is asked for asynchronously in `getAuthHeaders()`,
   * because a provider can renew behind the call and a synchronous read would
   * have to hold what it returned. The base's abstract member is satisfied and
   * unused.
   */
  protected buildAuthorizationHeader(): string {
    return '';
  }

  /**
   * The credential's cookies travel with its header.
   *
   * On every path, not only on ordinary requests: a SAML session that is not
   * presented to the session preflight and the establishing call is a session
   * the server never sees us in.
   */
  override async getAuthHeaders(): Promise<Record<string, string>> {
    const headers = await super.getAuthHeaders();

    // Asked now, not kept: a token provider renews behind this call, and a
    // value held from establishment would be the stale one.
    const authorization = await this.credential.authorizationHeader();
    if (authorization) {
      headers.Authorization = authorization;
      this.lastAuthorization = authorization;
    }

    const cookies = this.credential.cookies?.();
    if (cookies) {
      headers.Cookie = cookies;
    }
    return headers;
  }

  protected override getHttpsAgentOptions(): AgentOptions {
    return (
      this.credential.transportMaterial?.() ?? super.getHttpsAgentOptions()
    );
  }

  /**
   * One retry, and only when the credential actually changed.
   *
   * A provider renews on its own — `BaseTokenProvider` checks expiry and
   * refreshes before answering — so a 401 has two very different causes, and
   * asking again tells them apart. A different answer means the token was
   * stale: the ABAP session built on the old one is dead, so it is rebuilt and
   * the request goes once more. The same answer means the server refused these
   * credentials, and repeating them would only ask a second time.
   *
   * This is why no renewal strategy is injected. The provider owns "get me a
   * valid credential"; what is left is "the credential changed, so the session
   * is gone", which belongs to whoever owns the session and cannot be done from
   * outside it.
   */
  // biome-ignore lint/suspicious/noExplicitAny: matches the base signature exactly
  override async makeAdtRequest<T = any, D = any>(
    options: IAbapRequestOptions,
  ): Promise<IAdtResponse<T, D>> {
    // Which session this request is going out on. A 401 that comes back after
    // the session has already been replaced says nothing about the credential:
    // it was answered by a server we are no longer talking to.
    const sentOn = this.sessionGeneration;
    // And which lifetime. The generation alone cannot tell a session somebody
    // REBUILT from one the caller tore down: both move it. The epoch moves only
    // for a teardown, and the two cases want opposite answers — see below.
    const sentDuring = this.teardownEpoch;
    try {
      return await super.makeAdtRequest<T, D>(options);
    } catch (error) {
      if (!isUnauthorized(error)) throw error;

      if (!(await this.rebuiltAfterCredentialChange(sentOn, sentDuring)))
        throw error;
      // Exactly once, and to `super` deliberately: reaching for `this` would
      // re-enter this method, and a provider that answers differently every
      // time — a broken refresher, or a server refusing whatever it is given —
      // would look like "the credential changed" forever.
      //
      // A test pins the request count at two, but it does NOT distinguish the
      // two forms: swapping `super` for `this` leaves the suite green, and why
      // it does not then recurse is unexplained. Treat this line as guarded by
      // review, not by the suite.
      return await super.makeAdtRequest<T, D>(options);
    }
  }

  /**
   * Ask the provider again; if it answers differently, rebuild the session.
   *
   * Single-flight, because concurrent operations meet the same 401 at the same
   * moment and the session must be rebuilt once, not once per request in
   * flight. Everyone joins the first one and gets its verdict.
   */
  private rebuiltAfterCredentialChange(
    sentOn: number,
    sentDuring: number,
  ): Promise<boolean> {
    if (this.credentialRenewal) return this.credentialRenewal;

    const inFlight = (async () => {
      // The caller tore this connection down while the request was in flight.
      // The session it was sent on is gone deliberately, so retrying would
      // replay it inside the LIVE one: same connection, current cookies, and a
      // server that sees a legitimate-looking write nobody asked for. For a
      // read that is merely wasteful; this was found on a PUT, where it is a
      // mutation from a dead session committed into a live one. The 401 goes
      // back to the caller unchanged.
      if (this.teardownEpoch !== sentDuring) return false;

      // No teardown, so somebody else rebuilt while this was in flight. The
      // refusal was answered by a session that no longer exists and says
      // nothing about the credential in use now: retry on the new one. Renewing
      // again would force a second refresh and tear down a healthy session —
      // which is what comparing against a connection-wide "last header" did,
      // since by then that header was the NEW one.
      //
      // The two branches differ because the questions do. A rebuild continues
      // one lifetime; a teardown ends it, and nothing from before it may be
      // replayed after.
      if (this.sessionGeneration !== sentOn) return true;
      const before = this.lastAuthorization;
      // Tell the credential its last answer was refused BEFORE asking again.
      // Asking alone is not enough: a token provider returns the cached token
      // while it believes it is valid, which after a 401 is precisely what it
      // wrongly believes.
      await this.credential.renew?.();
      const now = await this.credential.authorizationHeader();
      if (!now || now === before) return false;

      this.logger?.debug(
        'The credential changed after a 401; the session built on the old one is gone. Rebuilding.',
      );
      const baseline = this.teardownEpoch;
      this.discardSession();
      await this.recoverSession(baseline);
      return true;
    })().finally(() => {
      if (this.credentialRenewal === inFlight) {
        this.credentialRenewal = undefined;
      }
    });

    this.credentialRenewal = inFlight;
    return inFlight;
  }

  /**
   * The establishing call, shared because it always was.
   *
   * Failure is a warning rather than a throw, as it has been: the first request
   * retries it, and a system that answers the discovery call badly may still
   * answer everything else. What decides whether the connection is usable is
   * the session check that follows, not this.
   */
  protected async establishSession(): Promise<void> {
    try {
      if (this.credential.fetchCsrfToken) {
        // The credential does the exchange itself — a SAML session is earned by
        // it — and hands the token to the wire that will present it.
        this.setCsrfToken(
          await this.credential.fetchCsrfToken(this.sessionTransport()),
        );
      } else {
        // Otherwise the wire establishes itself. What that means is the wire's:
        // HTTP earns a CSRF token and the cookies that name the session; an RFC
        // conversation was opened before this and already IS the session, so it
        // does nothing and holds no token. Demanding one here was what made
        // `connect()` impossible over RFC.
        await this.transport.establish({
          baseUrl: await this.getBaseUrl(),
          authHeaders: () => this.getAuthHeaders(),
          extraHeaders: { 'sap-adt-connection-id': this.getSessionId() ?? '' },
          observe: (headers) =>
            this.observeResponse(headers as Record<string, unknown>),
          isFatal: (error) => this.isSessionVerdict(error),
        });
      }
      this.logger?.debug('Connected', {
        credential: this.credential.kind,
        hasCsrfToken: !!this.getCsrfToken(),
        hasCookies: !!this.getCookies(),
      });
    } catch (error) {
      this.logger?.warn(
        `Could not establish (${this.credential.kind}): ${error instanceof Error ? error.message : String(error)}`,
      );
      // A rejecting response can still carry the cookies that matter; they are
      // taken by fetchCsrfToken itself, so nothing is read out of the error
      // here beyond saying whether any arrived.
      if (refusalOf(error)?.headers) {
        this.logger?.debug(
          `Cookies after a failed establishment: ${this.getCookies() ? 'present' : 'none'}`,
        );
      }
      // Rethrow: a resolved connect() must mean a usable session exists.
      //
      // This warned and resolved, on the reasoning that "the first request will
      // retry" — true while establishment could happen lazily, and left behind
      // when connect() became mandatory. Swallowing now leaves a connection
      // that reports success and holds nothing; worse, it skips the debris
      // clearing in establishAndCommit()'s catch, so the Set-Cookie that came
      // with the 401 survives as the session identity. A cookie is proof to
      // every credential that auth is settled, so the NEXT connect() goes out
      // with no credentials at all and fails for an unrelated reason.
      throw error;
    }
  }
}
