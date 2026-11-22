/**
 * A `rawText` answer: its body as the exact text SAP sent, decoded here.
 *
 * The HTTP wire reads the body as bytes and decodes them in the charset the
 * answer's `Content-Type` declares — UTF-8 when it declares none, or one
 * `TextDecoder` does not know — with `fatal: true` and the BOM kept. A body
 * that does not decode is not text: no replacement character ever stands in
 * for a byte (`readable: false`, the body absent).
 *
 * `rawText` changes how the body is represented and nothing else, so beside
 * the text each answer keeps what the request would have seen without the
 * flag — the body as axios's defaults would have handed it over (UTF-8, the
 * BOM dropped, JSON parsed when it parses) — for the connection's verdicts,
 * and the raw byte length for `noLog`'s line. Kept by the answer object, in a
 * module-private map: nothing of it is a field the caller sees.
 */
import type { IAdtTransportResponse } from './IAdtTransport.js';

interface RawFacts {
  /** The body as the request without the flag would have seen it. */
  unflagged: unknown;
  /** The body's length in bytes, as it arrived. */
  bytes: number;
  /** Whether the body decoded in its charset. */
  readable: boolean;
}

const RAW = new WeakMap<object, RawFacts>();

/** The body's bytes, from a Buffer, any other view, or an `ArrayBuffer`. */
function bytesOf(body: unknown): Uint8Array | undefined {
  if (body instanceof Uint8Array) return body;
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return undefined;
}

/**
 * The `charset` parameter of the answer's `Content-Type`, or `undefined`.
 * Headers are the wire's, from outside the type system: read without
 * assuming their container. Plain string code.
 */
export function charsetOf(headers: unknown): string | undefined {
  if (typeof headers !== 'object' || headers === null) return undefined;
  let type: string | undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'content-type' && typeof value === 'string') {
      type = value;
    }
  }
  if (type === undefined) return undefined;
  for (const parameter of type.split(';').slice(1)) {
    const at = parameter.indexOf('=');
    if (at < 0) continue;
    if (parameter.slice(0, at).trim().toLowerCase() !== 'charset') continue;
    let value = parameter.slice(at + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    return value === '' ? undefined : value;
  }
  return undefined;
}

/** A strict decoder for the declared charset; UTF-8 when none or unknown. */
function decoderFor(charset: string | undefined): TextDecoder {
  if (charset !== undefined) {
    try {
      return new TextDecoder(charset, { fatal: true, ignoreBOM: true });
    } catch {
      // A label `TextDecoder` does not know: UTF-8, as with none declared.
    }
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
}

/** What axios's defaults make of a body: UTF-8, no BOM, JSON when it parses. */
function asUnflagged(text: string): unknown {
  const unmarked = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (unmarked === '') return unmarked;
  try {
    return JSON.parse(unmarked);
  } catch {
    return unmarked;
  }
}

function factsOf(
  body: unknown,
  headers: unknown,
): {
  text: string | undefined;
  facts: RawFacts;
} {
  const bytes = bytesOf(body);
  if (bytes === undefined) {
    // A client that already made text of it: the text is what there is.
    const text = typeof body === 'string' ? body : undefined;
    return {
      text,
      facts: {
        unflagged: text === undefined ? body : asUnflagged(text),
        bytes: text === undefined ? 0 : Buffer.byteLength(text, 'utf8'),
        readable: text !== undefined || body === undefined || body === null,
      },
    };
  }
  const unflagged = asUnflagged(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
      'utf8',
    ),
  );
  try {
    return {
      text: decoderFor(charsetOf(headers)).decode(bytes),
      facts: { unflagged, bytes: bytes.byteLength, readable: true },
    };
  } catch {
    return {
      text: undefined,
      facts: { unflagged, bytes: bytes.byteLength, readable: false },
    };
  }
}

/**
 * The answer with its body decoded — or, when `source` is an answer already
 * decoded so, this copy of it with the same facts.
 */
export function rawAnswer(
  answer: IAdtTransportResponse,
  source?: unknown,
): IAdtTransportResponse {
  const known =
    typeof source === 'object' && source !== null ? RAW.get(source) : undefined;
  if (known !== undefined) {
    RAW.set(answer, known);
    return answer;
  }
  const { text, facts } = factsOf(answer.data, answer.headers);
  const decoded: IAdtTransportResponse = { ...answer, data: text };
  RAW.set(decoded, facts);
  return decoded;
}

/** Whether `source` is an answer decoded by `rawAnswer`. */
export function isRawAnswer(source: unknown): boolean {
  return typeof source === 'object' && source !== null && RAW.has(source);
}

/** The same facts on another object carrying the same answer. */
export function carryRaw(from: object, to: object): void {
  const known = RAW.get(from);
  if (known !== undefined) RAW.set(to, known);
}

/**
 * The body a verdict reads: what the request would have seen without
 * `rawText` — the answer's own body when it is not a `rawText` answer.
 */
export function verdictData(answer: IAdtTransportResponse): unknown {
  const known = RAW.get(answer);
  return known === undefined ? answer.data : known.unflagged;
}

/** A `rawText` answer's body length in bytes as it arrived, else `undefined`. */
export function rawBytes(answer: object): number | undefined {
  return RAW.get(answer)?.bytes;
}

/** `false` for a `rawText` answer whose body did not decode. */
export function rawReadable(answer: object): boolean {
  return RAW.get(answer)?.readable ?? true;
}
