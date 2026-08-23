/**
 * An on-prem system over HTTP: the wire where the logon IS the session.
 *
 * There is nothing to open. The session arrives as a `SAP_SESSIONID` cookie on
 * the establishing call, which is why SM04 shows those sessions opened by
 * `P=/sap/bc/adt/discovery` — one per `connect()`, and one left behind per
 * `connect()` that never said it was finished.
 *
 * ADT publishes no session resource here — `/sap/bc/adt/core/http/sessions`
 * does not exist — so the goodbye is the platform's own,
 * `/sap/public/bc/icf/logoff`, which answers `200` while expiring the session
 * cookie.
 *
 * **Taking this transport is the consumer saying which system it is dialling.**
 * It does not ask the server which it is, and does not try the cloud mechanism
 * first to see whether it answers.
 */

import { mergeCookieHeaders } from '../utils/cookies.js';
import { HttpTransport } from './HttpTransport.js';
import type {
  IAdtEstablishContext,
  IAdtSessionContext,
  IOnPremTransport,
} from './IAdtTransport.js';

const ICF_LOGOFF_PATH = '/sap/public/bc/icf/logoff';

export class OnPremHttpTransport
  extends HttpTransport
  implements IOnPremTransport
{
  override readonly kind: string = 'onprem-http';

  /** Which system this wire is for. Read by the compiler, never at runtime. */
  readonly system = 'onprem' as const;

  /**
   * Whether an establishment actually succeeded.
   *
   * Cookies alone cannot answer it: a 401 that refuses us can carry a
   * `Set-Cookie`, and that is debris, not a session. Telling the server we are
   * finished with something we never had sends a request nobody asked for —
   * into the middle of an authentication exchange, in the case that found this.
   */
  private established = false;

  override async establish(context: IAdtEstablishContext): Promise<void> {
    await super.establish(context);
    this.established = true;
  }

  override forgetSession(): void {
    super.forgetSession();
    this.established = false;
  }

  /**
   * Nothing to ask for: the session comes with the establishing request.
   *
   * Stated by being absent rather than by a method that returns `false`. A wire
   * that has no session resource has nothing to say here, and a `false` was
   * only ever read by the connection to decide whether to send a close — a
   * decision that is now this class's, below.
   */

  override async close(context: IAdtSessionContext): Promise<void> {
    // Read synchronously, for the same reason as the cloud wire: the teardown
    // clears the jar while this is suspended on its first await.
    const cookies = this.cookies();
    const established = this.established;
    // Snapshotted too, and for the same reason as the cookies: the goodbye must
    // reach the application server that holds THIS session, and by the time it
    // goes out the wire may be pinned to the one holding the next.
    const affinity = this.affinityHeaders();
    if (!established || !cookies) {
      // Holding the cookie is the whole permission to end a session, and it is
      // why nothing is sent without one. The session limit is per user and the
      // pool is shared — a SAP GUI logon of the same user sits in the same SM04
      // list — so a connector that tidied up sessions it did not open would
      // eventually close somebody's GUI.
      return;
    }

    try {
      // Read once: a provider may answer differently on a second call, and one
      // request must be built from one credential.
      const auth = await context.authHeaders();
      await this.sendDetached({
        method: 'GET',
        url: `${context.baseUrl}${ICF_LOGOFF_PATH}`,
        headers: {
          ...affinity,
          ...auth,
          ...context.extraHeaders,
          Cookie: mergeCookieHeaders(auth.Cookie, cookies),
        },
      });
      this.logger?.debug('Told the server the session is finished');
    } catch (error) {
      this.logger?.debug(
        `Could not tell the server the session is finished: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
