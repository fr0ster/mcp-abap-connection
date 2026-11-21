/**
 * The one line a `noLog` request may write: the method, the path without its
 * query, the integer status and the byte count — nothing of the request's
 * query, headers or body, nothing of the answer's headers, status text or body.
 *
 * Shared by the connection and both wires, so a `noLog` line reads the same
 * whichever of them wrote it.
 */

/** What a quiet line carries, as its log fields. */
export interface QuietFacts {
  method: string;
  path: string;
  status?: number;
  bytes?: number;
}

/** The path of a request URL: everything before its query or fragment. */
export function pathOf(url: string): string {
  let end = url.length;
  const query = url.indexOf('?');
  if (query !== -1) end = query;
  const fragment = url.indexOf('#');
  if (fragment !== -1 && fragment < end) end = fragment;
  return url.slice(0, end);
}

/**
 * The size of an answer's body in bytes. A body is the wire's, from outside the
 * type system: a string or bytes as they are, anything else as it serialises;
 * one that will not serialise counts as none.
 */
export function byteCount(data: unknown): number {
  if (data === undefined || data === null) return 0;
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  try {
    const text = JSON.stringify(data);
    return text === undefined ? 0 : Buffer.byteLength(text, 'utf8');
  } catch {
    return 0;
  }
}

/**
 * The quiet line: `METHOD /path → STATUS (N bytes)` for an answer, and
 * `METHOD /path → no answer` for a request that got none.
 */
export function quietLine(
  method: string,
  url: string,
  answer?: { status: number; data: unknown },
): { line: string; facts: QuietFacts } {
  const path = pathOf(url);
  if (answer === undefined || !Number.isInteger(answer.status)) {
    return { line: `${method} ${path} → no answer`, facts: { method, path } };
  }
  const bytes = byteCount(answer.data);
  return {
    line: `${method} ${path} → ${answer.status} (${bytes} bytes)`,
    facts: { method, path, status: answer.status, bytes },
  };
}
