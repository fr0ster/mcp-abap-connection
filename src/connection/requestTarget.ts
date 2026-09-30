import type { IRequestTarget } from '@mcp-abap-adt/interfaces-auth';
import { mergeCookieHeaders } from '../utils/cookies.js';

/**
 * The request target every wire shares: it writes into the headers the request
 * is about to carry.
 *
 * The wires already put request headers where they go — HTTP merges `Cookie`
 * with its jar, RFC forwards every header as an endpoint header field — so no
 * wire needs a target of its own. A cookie the credential names wins over one
 * already on the request, as `mergeCookieHeaders` orders it.
 */
export function requestTargetOn(
  headers: Record<string, string>,
): IRequestTarget {
  return {
    header(name, value) {
      headers[name] = value;
    },
    cookies(value) {
      headers.Cookie = mergeCookieHeaders(headers.Cookie, value);
    },
  };
}
