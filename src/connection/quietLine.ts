/**
 * The one line a `noLog` request may write: the method, the path without its
 * query, the integer status and the byte count — nothing of the request's
 * query, headers or body, nothing of the answer's headers, status text or body.
 *
 * Shared by the connection and both wires, so a `noLog` line reads the same
 * whichever of them wrote it.
 */

import { rawBytes } from './rawBody.js';

/** What a quiet line carries, as its log fields. */
export interface QuietFacts {
  method: string;
  path: string;
  status?: number;
  bytes?: number;
}

/** What a quiet line names for a URL that does not parse: nothing of it. */
export const UNPARSABLE_URL = '<unparsable url>';

/**
 * The path of a request URL. A path (`/…`, not `//…`) is cut at its query or
 * fragment; anything else is parsed as an absolute URL and gives its pathname
 * alone — never its user, password, host, query or fragment, which the WHATWG
 * parser separates. One with a scheme and no authority (`user:pass@host/x`)
 * names nothing; one that does not parse (a bad port, `//host/x`) names the
 * fixed placeholder, never any part of the input.
 */
export function pathOf(url: string): string {
  if (!url.startsWith('/') || url.startsWith('//')) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return UNPARSABLE_URL;
    }
    return parsed.host ? parsed.pathname : '';
  }
  let end = url.length;
  const query = url.indexOf('?');
  if (query !== -1) end = query;
  const fragment = url.indexOf('#');
  if (fragment !== -1 && fragment < end) end = fragment;
  return escapedControls(url.slice(0, end));
}

/**
 * Whether a code point can end or break a line: C0, DEL, C1 (U+0080–U+009F,
 * NEL among them), and the line and paragraph separators.
 */
function breaksLines(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029
  );
}

/**
 * The text with every code point that can break a line written as a fixed
 * escape — `\xNN` up to U+00FF, `\uNNNN` beyond: neither a path nor a method
 * can split the quiet line into two, or forge a second one. Plain string code.
 */
function escapedControls(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (!breaksLines(code)) out += char;
    else if (code <= 0xff) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else out += `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return out;
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
  rawMethod: string,
  url: string,
  answer?: { status: number; data: unknown },
): { line: string; facts: QuietFacts } {
  const path = pathOf(url);
  // The caller's method, as written: escaped as the path is.
  const method = escapedControls(rawMethod);
  if (answer === undefined || !Number.isInteger(answer.status)) {
    return { line: `${method} ${path} → no answer`, facts: { method, path } };
  }
  // A `rawText` answer counts the bytes that arrived, not its decoded text's.
  const bytes = rawBytes(answer) ?? byteCount(answer.data);
  return {
    line: `${method} ${path} → ${answer.status} (${bytes} bytes)`,
    facts: { method, path, status: answer.status, bytes },
  };
}
