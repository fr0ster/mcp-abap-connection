/**
 * Whether a refusal is the one fault the CSRF recovery cures in the same
 * session: a `403` naming CSRF, any answer whose text holds `CSRF token`, or
 * a `401` to a mutation sent while the wire holds no token yet.
 *
 * A module of its own so the order the connection asks it in is observable:
 * it is asked only after the refusal's cookies were observed, and never for
 * an answer that already lost the session.
 */
import { refusalOf } from './IAdtTransport.js';

export function shouldRetryCsrf(
  error: unknown,
  /** The request's method, already normalised by the caller. */
  method: string | undefined,
  /** Whether the wire holds a CSRF token now. */
  holdsToken: boolean,
): boolean {
  const refusal = refusalOf(error);
  if (!refusal) {
    return false;
  }

  const responseData = refusal.data;
  const responseText =
    typeof responseData === 'string'
      ? responseData
      : JSON.stringify(responseData || '');

  // Retry on 403 with CSRF message, or if response mentions CSRF token
  // Also retry on 401 for POST/PUT/DELETE if we don't have CSRF token yet (might need to get cookies first)
  // Handed in rather than read off `error.config`, which is axios's own
  // record of the request and does not exist on another wire's refusal. The
  // caller already normalised the method; asking the error for it was asking
  // the HTTP client.
  const normalized = method?.toUpperCase();
  const isPostPutDelete =
    normalized && ['POST', 'PUT', 'DELETE'].includes(normalized);
  const needsCsrfToken = !!isPostPutDelete && !holdsToken;

  return (
    (refusal.status === 403 && responseText.includes('CSRF')) ||
    responseText.includes('CSRF token') ||
    (needsCsrfToken && refusal.status === 401)
  );
}
