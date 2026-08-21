/**
 * How a session is opened on the server, and how the server is told we are
 * done with it.
 *
 * Two systems, two mechanisms, one meaning. On ABAP Cloud a session is a
 * resource: it is asked for at `/sap/bc/adt/core/http/sessions` and the
 * response publishes its own address, which is what a `DELETE` is sent to. On
 * on-prem there is no such resource — the logon call is the establishing
 * request itself, and the platform's `/sap/public/bc/icf/logoff` is how it is
 * given back.
 *
 * **Both are notifications, not commands.** They say "we have finished with
 * this session". Whether the system frees it now, later, or keeps it to reuse
 * is the system's business, and nothing here checks afterwards or depends on
 * the answer. Measured on a trial: the `DELETE` is answered `200` and the
 * session is still listed a moment later; the logoff is answered `200` and it
 * is not. Neither is a failure — they are two systems deciding differently
 * about a message they both accepted.
 *
 * Split by what the server publishes rather than by which system we think we
 * are talking to: `openSession()` asks, and a system that has no such resource
 * says so. Guessing the platform would be a guess; asking is not.
 */

import type { ICredentialTransport } from '../auth/IAuthProvider.js';
import type { ILogger } from '../logger.js';

/** What a strategy needs from the connection to talk to the server. */
export interface ISessionTransport extends ICredentialTransport {
  /** Auth headers for a request made outside the normal request path. */
  authHeaders(): Promise<Record<string, string>>;
  /** Cookies held for this connection, or null before any have arrived. */
  cookies(): string | null;
  /** The CSRF token held, if one has been fetched. */
  csrfToken(): string | null;
  /** Issue a raw request and hand back status, headers and body. */
  send(request: {
    method: 'GET' | 'DELETE';
    url: string;
    headers: Record<string, string>;
    /**
     * A deadline for the REQUEST, and only where one belongs.
     *
     * The open is a preflight that `connect()` waits for, so it is bounded.
     * The close must not be: a request timeout aborts the socket, which would
     * cancel the very message it was waiting for and leave the session open —
     * the caller's own deadline bounds the WAIT instead, elsewhere.
     */
    timeoutMs?: number;
    /**
     * Whether the cookies this answers with become the connection's.
     *
     * True for the open — its `SAP_SESSIONID` **is** the session. False for a
     * close: a teardown's response must not feed the session identity, or the
     * cookies it sets read as the session having been replaced under a
     * connection that is on its way out.
     */
    adoptCookies?: boolean;
  }): Promise<{ status: number; headers: unknown; data: unknown }>;
}

export abstract class SessionStrategy {
  constructor(protected readonly logger: ILogger | null) {}

  /** A name for logs, so which one ran is never a guess. */
  abstract readonly kind: 'cloud-security-session' | 'icf';

  /**
   * Ask the server to open a session, before anything needs one.
   *
   * Returns whether a session resource was actually opened and its address
   * captured — `false` is not a failure, it is a system saying it has none, and
   * the close then falls to the mechanism that needs no address. Never throws: a system that
   * will not open one is a fact for the establishment that follows to report,
   * with the whole picture, not a transport error raised from a preflight.
   */
  abstract openSession(transport: ISessionTransport): Promise<boolean>;

  /**
   * Tell the server we are done with the session.
   *
   * Never throws, and says nothing about what the server then did with it.
   */
  abstract closeSession(transport: ISessionTransport): Promise<void>;
}
