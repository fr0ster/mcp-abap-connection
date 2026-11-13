/**
 * What a thrown value may say about itself to a caller or a log line: its
 * typed facts, never its text.
 *
 * A thrown value comes from outside the type system — the NW RFC SDK, axios,
 * Node's sockets, a WebSocket library, a consumer's own code — and its message,
 * stack, cause and fields carry whatever its author put there: a gateway's
 * `host:port`, a URL with credentials in it, a request's headers. So nothing
 * of it is quoted. What it says is read as facts, each checked where it is
 * read — the RFC SDK's fields (`rfc`), a Node or axios error code (`code`),
 * an HTTP status (`status`) — and said in fixed words built from those facts.
 *
 * Every read is of an own data property: no getter runs, and an object whose
 * traps throw reads as having no facts.
 */

import {
  type IAbapConnectionError,
  type IRfcErrorInfo,
  RFC_RCS,
} from '@mcp-abap-adt/interfaces-adt-connection';
import type { IAdtTransportResponse } from './IAdtTransport.js';

/** An own data property of `source`, read without running a getter. */
export function ownData(source: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, name);
  return descriptor !== undefined && 'value' in descriptor
    ? descriptor.value
    : undefined;
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * The SDK's error as fields, or `undefined` when `thrown` is not that shape.
 *
 * The one place an SDK error enters, so the one place it is checked: `key` and
 * `codeString` own data properties holding strings, `group` and `code` own
 * data properties holding integers, and `codeString` one of the closed list
 * `RFC_RCS`. No getter runs, and an object whose traps throw reads as no
 * shape. `name` and `message` are not read, and nothing is read out of a
 * message.
 */
export function rfcErrorOf(thrown: unknown): IRfcErrorInfo | undefined {
  if (typeof thrown !== 'object' || thrown === null) return undefined;
  try {
    const key = ownData(thrown, 'key');
    const group = ownData(thrown, 'group');
    const code = ownData(thrown, 'code');
    const codeString = ownData(thrown, 'codeString');
    if (typeof key !== 'string' || !isInteger(group) || !isInteger(code)) {
      return undefined;
    }
    // Compared with each listed name, so only a string can match: this is
    // the check of `codeString`, and what is stored is the listed member.
    const listed = RFC_RCS.find((name) => name === codeString);
    if (listed === undefined) return undefined;
    return Object.freeze({ key, group, code, codeString: listed });
  } catch {
    return undefined;
  }
}

/** The longest code read as one: Node's and axios's are far shorter. */
const CODE_LIMIT = 64;

/** `A`–`Z`, `0`–`9` and `_`: what a Node or axios error code is made of. */
function isCodeUnit(unit: number): boolean {
  return (
    (unit >= 0x41 && unit <= 0x5a) ||
    (unit >= 0x30 && unit <= 0x39) ||
    unit === 0x5f
  );
}

/**
 * A code as a Node or axios error carries it (`ECONNREFUSED`,
 * `ERR_BAD_REQUEST`, one of `ADT_SESSION_ERROR`): a non-empty string of
 * upper-case ASCII letters, digits and `_` only, at most 64 of them. Anything
 * else is no code — free text is never taken for one.
 */
export function codeOf(thrown: unknown): string | undefined {
  if (typeof thrown !== 'object' || thrown === null) return undefined;
  try {
    const code = ownData(thrown, 'code');
    if (typeof code !== 'string') return undefined;
    if (code.length === 0 || code.length > CODE_LIMIT) return undefined;
    for (let i = 0; i < code.length; i += 1) {
      if (!isCodeUnit(code.charCodeAt(i))) return undefined;
    }
    return code;
  } catch {
    return undefined;
  }
}

/** An HTTP status: an integer from 100 to 599. */
function isStatus(value: unknown): value is number {
  return isInteger(value) && value >= 100 && value <= 599;
}

/**
 * The HTTP status a thrown value carries: its own `status`, else its
 * `response`'s — `undefined` when neither is an HTTP status.
 */
export function statusOf(thrown: unknown): number | undefined {
  if (typeof thrown !== 'object' || thrown === null) return undefined;
  try {
    const own = ownData(thrown, 'status');
    if (isStatus(own)) return own;
    const response = ownData(thrown, 'response');
    if (typeof response !== 'object' || response === null) return undefined;
    const status = ownData(response, 'status');
    return isStatus(status) ? status : undefined;
  } catch {
    return undefined;
  }
}

/** The facts a thrown value is said by. */
export interface FailureFacts {
  readonly code?: string;
  readonly status?: number;
  readonly rfc?: IRfcErrorInfo;
}

/** Every fact `thrown` carries, each checked; none of its text. */
export function factsOf(thrown: unknown): FailureFacts {
  const rfc = rfcErrorOf(thrown);
  // An RFC error's `code` is the SDK's number, said by `rfc`; a code is a
  // string, so it is not read twice.
  const code = codeOf(thrown);
  const status = statusOf(thrown);
  return {
    ...(code !== undefined ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(rfc !== undefined ? { rfc } : {}),
  };
}

/** The words for a value that carries no fact. */
export const NO_FACTS = 'no code was given';

/**
 * A thrown value in fixed words: its facts — the RFC return code, the code,
 * the status — or `no code was given`. For a message and a log line.
 */
export function factWords(thrown: unknown): string {
  const facts = factsOf(thrown);
  const parts: string[] = [];
  if (facts.rfc !== undefined) parts.push(facts.rfc.codeString);
  if (facts.code !== undefined) parts.push(facts.code);
  if (facts.status !== undefined) parts.push(`status ${facts.status}`);
  return parts.length === 0 ? NO_FACTS : parts.join(', ');
}

/** A copy of a thrown value: fixed words and its facts, nothing else of it. */
export type FailureCopy = Error & IAbapConnectionError & FailureFacts;

/**
 * A copy of `thrown` a consumer may stringify or inspect: an `Error` named
 * `WireFailure`, its message `The failure: <facts>`, and its facts as fields
 * (`code`, `status`, `rfc`). No message, stack, cause, config or other field
 * of `thrown` is kept. `undefined` stays `undefined`.
 */
export function failureCopy(thrown: unknown): FailureCopy | undefined {
  if (thrown === undefined) return undefined;
  const copy = new Error(`The failure: ${factWords(thrown)}`);
  copy.name = 'WireFailure';
  return Object.assign(copy, factsOf(thrown));
}

/** What an HTTP request's failure is, as the wire hands it up. */
export type HttpFailure = Error &
  IAbapConnectionError & {
    readonly status?: number;
    /** SAP's answer, as SAP gave it: status, reason, headers, body. */
    readonly response?: IAdtTransportResponse;
  };

/**
 * SAP's answer a rejection carries, copied field by field — `status`,
 * `statusText`, `headers`, `data`, as SAP gave them — and nothing else of the
 * response object (axios's holds the request and its config).
 */
function answerOf(thrown: unknown): IAdtTransportResponse | undefined {
  if (typeof thrown !== 'object' || thrown === null) return undefined;
  try {
    const response = ownData(thrown, 'response');
    if (typeof response !== 'object' || response === null) return undefined;
    const status = ownData(response, 'status');
    if (!isInteger(status)) return undefined;
    const statusText = ownData(response, 'statusText');
    return {
      status,
      ...(typeof statusText === 'string' ? { statusText } : {}),
      headers: ownData(response, 'headers'),
      data: ownData(response, 'data'),
    };
  } catch {
    return undefined;
  }
}

/**
 * What an HTTP client's rejection becomes before it leaves the wire: an
 * `Error` in fixed words with its facts and SAP's answer, and nothing else.
 *
 * axios's error carries the request's config — its `Authorization`, `Cookie`
 * and CSRF headers among it — the Node request, and a message that names the
 * host and port it could not reach. None of that is kept. What is: SAP's
 * answer when there was one (`response`, `status`; the message axios gives it,
 * `Request failed with status code <n>`, built from the status), else the
 * code (`ECONNREFUSED`, `ECONNABORTED`, …) and `The request failed: <code>`.
 */
export function httpFailure(thrown: unknown): HttpFailure {
  const response = answerOf(thrown);
  const code = codeOf(thrown);
  const error = new Error(
    response !== undefined
      ? `Request failed with status code ${response.status}`
      : `The request failed: ${code ?? 'it got no answer'}`,
  );
  return Object.assign(
    error,
    code !== undefined ? { code } : {},
    response !== undefined ? { status: response.status, response } : {},
  );
}
