/**
 * On-prem: the logon is the establishing request, and the platform takes the
 * session back through `/sap/public/bc/icf/logoff`.
 *
 * There is nothing to open. The session arrives as a `SAP_SESSIONID` cookie on
 * the establishing call, which is why on-prem SM04 shows those sessions opened
 * by `P=/sap/bc/adt/discovery` — one per `connect()`, and one left behind per
 * `connect()` that never said it was finished.
 *
 * ADT publishes no session resource here — `/sap/bc/adt/core/http/sessions`
 * does not exist — so this is the only mechanism, and it is the platform's
 * rather than ADT's.
 */

import { mergeCookieHeaders } from '../utils/cookies.js';
import { type ISessionTransport, SessionStrategy } from './SessionStrategy.js';

const ICF_LOGOFF_PATH = '/sap/public/bc/icf/logoff';

export class IcfSessionStrategy extends SessionStrategy {
  readonly kind = 'icf' as const;

  /**
   * Nothing to ask for: the session comes with the establishing request.
   *
   * `false` is about the session RESOURCE, not about sessions — this system has
   * no address to open or close one by, which is exactly why the close below is
   * the platform's logoff.
   */
  async openSession(_transport: ISessionTransport): Promise<boolean> {
    return false;
  }

  async closeSession(transport: ISessionTransport): Promise<void> {
    const cookies = transport.cookies();
    if (!cookies) {
      // Holding the cookie is the whole permission to end a session, and it is
      // why nothing is sent without one. The session limit is per user and the
      // pool is shared — a SAP GUI logon of the same user sits in the same SM04
      // list — so a connector that tidied up sessions it did not open would
      // eventually close somebody's GUI.
      return;
    }

    try {
      // Read once: see CloudSecuritySessionStrategy — a provider may answer
      // differently on a second call, and one request must be built from one
      // credential.
      const auth = await transport.authHeaders();
      await transport.send({
        method: 'GET',
        url: `${transport.baseUrl}${ICF_LOGOFF_PATH}`,
        headers: {
          ...auth,
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
