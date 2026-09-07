/**
 * Whether an error is the network's rather than the server's.
 *
 * `@mcp-abap-adt/interfaces` published this as a function until 29.0.0, when
 * that package stopped emitting code: it holds types, interfaces and constants,
 * and a predicate is none of those. The codes are still there —
 * {@link NETWORK_ERROR_CODES} — and the judgement lives here, with the wire it
 * judges.
 *
 * The distinction is not cosmetic. A refusal from SAP is an answer and can be
 * retried once a token is refreshed; `ECONNREFUSED` is a statement about
 * infrastructure, and retrying it re-runs the same failure against the same
 * unreachable host.
 */
import { NETWORK_ERROR_CODES } from '@mcp-abap-adt/interfaces';

const CODES: ReadonlySet<string> = new Set(Object.values(NETWORK_ERROR_CODES));

export function isNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && CODES.has(code);
}
