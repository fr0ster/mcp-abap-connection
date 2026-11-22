/**
 * `rawText`: the body the caller receives as the final answer is the exact
 * text SAP sent. Nothing internal changes.
 *
 * The HTTP wire reads a `rawText` answer's body as bytes and makes two things
 * of them. The body every consumer inside the connection reads — the CSRF
 * recovery, the session verdicts, the replays, logging, the error's shape —
 * is exactly what the unflagged path has: what axios's defaults make of the
 * same bytes (UTF-8, a leading BOM dropped, JSON parsed when it parses). The
 * exact text is kept beside the answer object, in a module-private map, with
 * the raw byte length for `noLog`'s line; it replaces `data` only on the
 * object the caller receives, at the connection's door (`toCallerView`).
 *
 * The exact text is decoded in the charset the `Content-Type` declares when
 * `TextDecoder` knows it, else UTF-8, the BOM kept, non-fatally: a byte that
 * is not text in that charset reads as U+FFFD.
 */
import type { IAdtTransportResponse } from './IAdtTransport.js';

interface ExactBody {
  /** The text the caller receives. */
  text: string;
  /** The body's length in bytes, as it arrived. */
  bytes: number;
  /** The body as the unflagged path has it: what consumers inside read. */
  internal: unknown;
}

const EXACT = new WeakMap<object, ExactBody>();

/** The body's bytes: a Buffer, any other view, or a plain `ArrayBuffer`. */
function bytesOf(body: unknown): Uint8Array | undefined {
  if (body instanceof Uint8Array) return body;
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return undefined;
}

/**
 * What the unflagged path makes of these bytes, step for step as axios does:
 * UTF-8 (`Buffer#toString`), a leading BOM dropped, then its default
 * `transformResponse` — a non-empty string parsed as JSON when it parses.
 */
function unflaggedBody(bytes: Uint8Array): unknown {
  const decoded = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).toString('utf8');
  const text = decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
  if (text === '') return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The first `charset` parameter of the answer's `Content-Type`, unquoted, or
 * `undefined`. Parameters are split on `;` outside quoted strings. Headers
 * are the wire's, from outside the type system. Plain string code.
 */
function charsetOf(headers: unknown): string | undefined {
  if (typeof headers !== 'object' || headers === null) return undefined;
  let type: string | undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'content-type' && typeof value === 'string') {
      type = value;
    }
  }
  if (type === undefined) return undefined;
  for (const parameter of parametersOf(type)) {
    const at = parameter.indexOf('=');
    if (at < 0) continue;
    if (parameter.slice(0, at).trim().toLowerCase() !== 'charset') continue;
    return unquoted(parameter.slice(at + 1).trim());
  }
  return undefined;
}

/** A media type's parameters: split on `;` outside quoted strings. */
function parametersOf(type: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let escaped = false;
  for (const char of type) {
    if (escaped) {
      escaped = false;
    } else if (quoted && char === '\\') {
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ';' && !quoted) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.slice(1);
}

/** A parameter value without its quotes and escapes, when it is quoted. */
function unquoted(value: string): string {
  if (!(value.length >= 2 && value.startsWith('"') && value.endsWith('"'))) {
    return value;
  }
  let out = '';
  let escaped = false;
  for (const char of value.slice(1, -1)) {
    if (escaped) {
      out += char;
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else {
      out += char;
    }
  }
  return out;
}

/** The declared charset's decoder when `TextDecoder` knows it, else UTF-8. */
function decoderFor(charset: string | undefined): TextDecoder {
  if (charset !== undefined) {
    try {
      return new TextDecoder(charset, { ignoreBOM: true });
    } catch {
      // A label `TextDecoder` does not know: UTF-8.
    }
  }
  return new TextDecoder('utf-8', { ignoreBOM: true });
}

/**
 * A `rawText` answer as the connection reads it: `data` is what the
 * unflagged path has, and the exact text and raw byte length are kept beside
 * it. A body that is not bytes (a client that made something else of it) is
 * left as it is.
 */
export function rawTextAnswer(
  answer: IAdtTransportResponse,
): IAdtTransportResponse {
  const bytes = bytesOf(answer.data);
  if (bytes === undefined) return answer;
  const internal = unflaggedBody(bytes);
  const read: IAdtTransportResponse = { ...answer, data: internal };
  EXACT.set(read, {
    text: decoderFor(charsetOf(answer.headers)).decode(bytes),
    bytes: bytes.byteLength,
    internal,
  });
  return read;
}

/** The same exact text on another object carrying the same answer. */
export function carryExact(from: object, to: object): void {
  const exact = EXACT.get(from);
  if (exact !== undefined) EXACT.set(to, exact);
}

/** A `rawText` answer's raw byte length, else `undefined`. */
export function rawByteLength(answer: object): number | undefined {
  return EXACT.get(answer)?.bytes;
}

/**
 * The caller's view, at the connection's door: a `rawText` answer's `data`
 * becomes its exact text. Every consumer inside has read it by then.
 */
export function toCallerView(answer: { data: unknown }): void {
  const exact = EXACT.get(answer);
  if (exact !== undefined) answer.data = exact.text;
}

/**
 * The body as consumers inside read it, for one that sits outside the
 * connection's door (the check replay of `createConnection`): what the
 * unflagged path has, whether or not the caller's view was applied.
 */
export function internalBody(answer: IAdtTransportResponse): unknown {
  const exact = EXACT.get(answer);
  return exact === undefined ? answer.data : exact.internal;
}
