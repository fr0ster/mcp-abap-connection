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

/** The cookie that names a stateful ABAP context. */
export const CONTEXT_COOKIE = 'sap-contextid';

/**
 * Marked so by the connection, or — kept for callers that still write it
 * themselves — carrying the session header already. Taken on the request as
 * the caller made it, before a wire rewrites it.
 *
 * A request marked `stateless` is not stateful, whatever else it says: the
 * caller's `stateless: true` wins over the flag and over its own header.
 */
export function isStatefulRequest(request: IAdtTransportRequest): boolean {
  if (request.stateless) return false;
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

/** Whether a header's name is the session header, in any letter case. */
export function isSessionTypeHeader(name: string): boolean {
  return name.trim().toLowerCase() === SESSION_TYPE_HEADER;
}

/**
 * A `Cookie` header's value without `sap-contextid`, or `undefined` when
 * nothing is left. Plain string code: the pairs split at `;`, each read
 * without its leading whitespace.
 */
export function cookieWithoutContext(cookie: string): string | undefined {
  const kept = cookie
    .split(';')
    .map((pair) => pair.trimStart())
    .filter((pair) => pair && pair.split('=')[0]?.trim() !== CONTEXT_COOKIE)
    .join('; ');
  return kept || undefined;
}
