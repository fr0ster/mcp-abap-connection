/**
 * A connection whose authentication is passed in.
 *
 * The shared half of the two platform connectors, and the reason the split is
 * possible at all: `establishSession()` was measured to be the same work in
 * every one of the five auth classes — fetch a CSRF token from
 * `/sap/bc/adt/discovery`, keep it, tolerate a failure — with the only
 * per-credential part being a step before it. That step is `prepare()`.
 *
 * So this owns the establishing call, and the credential contributes what to
 * prepare and what each request carries. Which system this is talking to was stated by the caller when it
 * chose the subclass, and is never worked out here.
 */

import type {
  IAuthProvider,
  IAuthRejection,
  ILogonTarget,
} from '@mcp-abap-adt/interfaces-auth';
import type { SapConfig } from '../config/sapConfig.js';
import type { ILogger } from '../logger.js';
import { AbstractAbapConnection } from './AbstractAbapConnection.js';
import { AuthRefusedError, type GuardedAnswer, guarded } from './authErrors.js';
import { type IAdtTransport, refusalOf } from './IAdtTransport.js';
import { requestTargetOn } from './requestTarget.js';

export abstract class CredentialAbapConnection<
  TCredential extends IAuthProvider = IAuthProvider,
> extends AbstractAbapConnection {
  constructor(
    config: SapConfig,
    /** Public because the type is the point: a caller can reach what it gave. */
    readonly credential: TCredential,
    transport: IAdtTransport,
    logger: ILogger | null = null,
    sessionId?: string,
  ) {
    super(config, transport, logger, sessionId);
  }

  /**
   * Whatever the credential needs before the first request goes out.
   *
   * Runs before the preflight, not inside the establishing call: a credential
   * that had not yet done its one-time work rejected the connect from inside an
   * argument evaluation, outside every catch, with no request sent.
   *
   * A provider answers rather than throws; a throw is treated as an answer too
   * (`guarded`), so a buggy provider fails the connect with words, not with an
   * unhandled rejection.
   */
  protected override async prepareCredential(): Promise<void> {
    const { outcome, thrown } = await guarded(
      () => this.credential.prepare(),
      'prepare',
    );
    if (!outcome.ok) {
      throw new AuthRefusedError(outcome.refusal, 'prepare', thrown);
    }
  }

  /**
   * The credential writes what this request carries: its header, or its
   * cookies, or both.
   *
   * On every path, not only on ordinary requests: a SAML session that is not
   * presented to the session preflight and the establishing call is a session
   * the server never sees us in.
   */
  protected override async authorizeRequest(
    headers: Record<string, string>,
  ): Promise<void> {
    // Asked per request, never held: a provider renews behind this call, and a
    // value kept here would be the stale one.
    const { outcome, thrown } = await guarded(
      () => this.credential.authorize(requestTargetOn(headers)),
      'request',
    );
    if (!outcome.ok) {
      throw new AuthRefusedError(outcome.refusal, 'request', thrown);
    }
  }

  /** What the credential brings to a logon: TLS material, logon parameters. */
  protected override async logon(target: ILogonTarget): Promise<void> {
    const { outcome, thrown } = await guarded(
      () => this.credential.establish(target),
      'logon',
    );
    if (!outcome.ok) {
      throw new AuthRefusedError(outcome.refusal, 'logon', thrown);
    }
  }

  /**
   * The provider's answer, whole; a throw is an answer too (`guarded`), and
   * is kept beside it to become the cause of the refusal.
   */
  protected override async credentialRejected(
    rejection: IAuthRejection,
  ): Promise<GuardedAnswer> {
    return guarded(() => this.credential.rejected(rejection), rejection.at);
  }

  protected async establishSession(): Promise<void> {
    try {
      // The wire establishes itself, always. What that means is the wire's:
      // HTTP earns a CSRF token and the cookies that name the session; an RFC
      // conversation was opened before this and already IS the session, so it
      // does nothing and holds no token. Demanding one here was what made
      // `connect()` impossible over RFC.
      //
      // There is no second path. A credential whose way in IS a round trip
      // does not need one: the wire authorizes PER ATTEMPT, so a one-shot token
      // is offered on the establishing call and withheld afterwards by the
      // credential itself, with nobody deciding anything.
      await this.transport.establish({
        ...this.sessionContext(),
        baseUrl: await this.getBaseUrl(),
        isFatal: (error) => this.endsTheExchange(error),
      });
      this.logger?.debug('Connected', {
        credential: this.credential.kind,
        hasCsrfToken: !!this.getCsrfToken(),
        hasCookies: !!this.getCookies(),
      });
    } catch (error) {
      this.logger?.warn(
        `Could not establish (${this.credential.kind}): ${error instanceof Error ? error.message : String(error)}`,
      );
      // A rejecting response can still carry the cookies that matter; the wire
      // folds them in as it establishes, so nothing is read out of the error
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
