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
    transport: IAdtTransport,
    logger: ILogger | null = null,
    sessionId?: string,
  ) {
    super(config, transport, logger, sessionId);
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

  protected override async prepareCredential(): Promise<void> {
    await this.credential.prepare();
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

    // Asked per request, never held: a provider renews behind this call, and a
    // value kept here would be the stale one.
    const authorization = await this.credential.authorizationHeader();
    if (authorization) {
      headers.Authorization = authorization;
    }

    const cookies = this.credential.cookies();
    if (cookies) {
      headers.Cookie = cookies;
    }
    return headers;
  }

  protected override getHttpsAgentOptions(): AgentOptions {
    return this.credential.transportMaterial();
  }

  protected async establishSession(): Promise<void> {
    try {
      // The wire establishes itself, always. What that means is the wire's:
      // HTTP earns a CSRF token and the cookies that name the session; an RFC
      // conversation was opened before this and already IS the session, so it
      // does nothing and holds no token. Demanding one here was what made
      // `connect()` impossible over RFC.
      //
      // There is no second path. A credential that wanted to run the exchange
      // itself would need the connection to ask which of the two does the work,
      // and a credential whose way in IS a round trip does not need that: the
      // wire asks `authHeaders()` PER ATTEMPT, so a one-shot token is offered
      // on the establishing call and withheld afterwards by the credential
      // itself, with nobody deciding anything.
      await this.transport.establish({
        baseUrl: await this.getBaseUrl(),
        authHeaders: () => this.getAuthHeaders(),
        extraHeaders: { 'sap-adt-connection-id': this.getSessionId() ?? '' },
        observe: (headers) =>
          this.observeResponse(headers as Record<string, unknown>),
        isFatal: (error) => this.isSessionVerdict(error),
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
