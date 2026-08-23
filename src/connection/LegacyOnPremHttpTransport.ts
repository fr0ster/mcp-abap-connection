/**
 * An on-prem system old enough that the stateful header hurts.
 *
 * On BASIS 7.40, `x-sap-adt-sessiontype: stateful` makes the server keep locks
 * in ABAP session memory instead of the global enqueue table, and the next
 * `PUT` over that lock comes back `423`. Such a system also names no HTTP
 * session, so a connection that insisted on a `SAP_SESSIONID` would refuse to
 * connect to a system that is working fine.
 *
 * Both of those used to be one flag on the connection — `skipSessionType` —
 * carried in the class every wire shares, describing one deployment. It is a
 * deployment, so it is a wire: taking this one is the caller saying which
 * system they are dialling, exactly as taking the cloud or the on-prem wire is.
 */

import type {
  IAdtTransportRequest,
  IAdtTransportResponse,
} from './IAdtTransport.js';
import { OnPremHttpTransport } from './OnPremHttpTransport.js';

const SESSION_TYPE_HEADER = 'x-sap-adt-sessiontype';

export class LegacyOnPremHttpTransport extends OnPremHttpTransport {
  override readonly kind = 'onprem-http-legacy';

  /**
   * The header never goes out, whatever the caller set the session type to.
   *
   * Dropped here rather than refused above: `setSessionType()` records what the
   * caller wants, and what actually travels is the wire's business. A caller
   * that asks for a stateful session on this system gets one — through the RFC
   * conversation, or through this wire's own session — without the header that
   * would move its locks somewhere they cannot be released.
   */
  override async send(
    request: IAdtTransportRequest,
  ): Promise<IAdtTransportResponse> {
    return super.send(this.withoutSessionType(request));
  }

  private withoutSessionType(
    request: IAdtTransportRequest,
  ): IAdtTransportRequest {
    if (!request.headers) return request;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (name.toLowerCase() === SESSION_TYPE_HEADER) continue;
      headers[name] = value;
    }
    return { ...request, headers };
  }

  /**
   * This system names no session, and that is not a failure.
   *
   * The rule above — refuse to connect when the server issued no
   * `SAP_SESSIONID` — exists because a connection without one can read and can
   * hold nothing. Here there is nothing to hold that way in the first place, so
   * answering "no session" would refuse a system that works.
   */
  override sessionEstablished(): boolean {
    return true;
  }
}
