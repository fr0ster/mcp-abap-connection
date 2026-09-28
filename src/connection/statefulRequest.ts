/**
 * Whether a request runs in the stateful session — the one a lock is taken and
 * released in.
 *
 * One verdict for every wire. HTTP expresses it as a header and the context
 * cookie, RFC as the conversation it picks; if the two wires decided it
 * differently, a caller that asked for the session one way would keep its lock
 * on one wire and lose it on the other.
 */
import type { IAdtTransportRequest } from './IAdtTransport.js';

/** The header that asks SAP for the stateful session over HTTP. */
export const SESSION_TYPE_HEADER = 'x-sap-adt-sessiontype';

/**
 * Marked so by the connection, or — kept for callers that still write it
 * themselves — carrying the session header already. Taken on the request as
 * the caller made it, before a wire rewrites it.
 */
export function isStatefulRequest(request: IAdtTransportRequest): boolean {
  if (request.stateful) return true;
  const headers = request.headers;
  if (!headers) return false;
  for (const [name, value] of Object.entries(headers)) {
    if (
      name.toLowerCase() === SESSION_TYPE_HEADER &&
      String(value).toLowerCase() === 'stateful'
    ) {
      return true;
    }
  }
  return false;
}
