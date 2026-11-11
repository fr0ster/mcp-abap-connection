/**
 * An ADT request carried over RFC.
 *
 * `SADT_REST_RFC_ENDPOINT` is the standard FM Eclipse ADT uses for on-prem ADT
 * through JCo, and what it carries is a request line, header fields and a body
 * — an HTTP request in all but the wire. So this translates, and translating is
 * the whole of its job.
 *
 * It exists because an RFC conversation is inherently stateful: one ABAP
 * session for the connection's lifetime, which is the way through HTTP 423
 * "invalid lock handle" on legacy systems (BASIS < 7.50) where stateful HTTP
 * sessions are not usable.
 *
 * **Two conversations, the way Eclipse ADT holds them over JCo.** Its trace
 * shows one long-lived stateful session (`JCoEnqueueSystemSession`) for `LOCK`
 * and `UNLOCK`, and every other call — the `PUT` included — in a session of
 * its own. Here:
 *
 * - the persistent conversation, opened by `open()` and kept while this wire
 *   lives, carries the requests marked `stateful` — the lock and what must
 *   share its session;
 * - every other request opens a conversation of its own, and closes it when
 *   it answers.
 *
 * One conversation for everything kept whatever an ABAP program left in the
 * session. `CL_PACKAGE` buffers its instances for the life of the session and
 * a save leaves them changeable, so after a create or a write every further
 * write or delete of that package answered 400 PAK/058 "Package … is already
 * locked"; a read straight after a create answered 400 SADT_RESOURCE/007.
 * Measured on E19 (2026-09-27): LOCK and UNLOCK on one conversation, the PUT
 * on another — two writes in a row fail on a shared second conversation and
 * pass on a fresh one per call. The price is a logon per non-stateful call
 * (~0.5 s on E19, against ~0.1 s for the call itself).
 *
 * **What is NOT here.** Cookies, the CSRF token and the session lifecycle
 * belong to the connection above this seam and are already in
 * `request.headers` by the time `send()` is called. `x-sap-adt-sessiontype` is
 * not sent at all: over RFC `request.stateful` picks the conversation, and
 * Eclipse's JCo trace carries no session header either. A transport that
 * also captured cookies would be doing that work twice, and the two copies
 * would disagree the first time one of them was cleared.
 *
 * **A request's language.** Over HTTP the ICF layer reads `sap-language` — a
 * header or a query parameter — and runs the request in it. This endpoint has
 * no ICF logon: it runs a request in the conversation's logon language and
 * ignores `sap-language` wherever it is written (measured on S/4HANA 2025,
 * 2026-11-09). So a request's `sap-language` is compared with the logon
 * language of the conversation that would carry it — the `lang` its logon
 * carries: the provider's where it wrote one, else the factory's. Another
 * language: a non-stateful request goes on a conversation logged on in it,
 * opened for that call and closed after it, nothing kept; a stateful one is
 * refused before anything is sent, because a session cannot change its
 * language.
 */

import { randomUUID } from 'node:crypto';
import { authError } from '@mcp-abap-adt/auth-errors';
import {
  type IAbapConnectionError,
  type IRfcErrorInfo,
  RFC_RCS,
} from '@mcp-abap-adt/interfaces-adt-connection';
import type { AuthOutcome, ILogonTarget } from '@mcp-abap-adt/interfaces-auth';
import type { ILogger } from '../logger.js';
import { WireLogonError, WireSessionLostError } from './authErrors.js';
import type {
  IAdtEstablishContext,
  IAdtSessionContext,
  IAdtTransportRequest,
  IAdtTransportResponse,
  IOnPremTransport,
} from './IAdtTransport.js';
import { isStatefulRequest } from './statefulRequest.js';

/**
 * The SDK answers with untyped structures: each level is read as a record and
 * each field checked before use, rather than trusted as `any`.
 */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The slice of the native client this needs, so the SDK is not a hard dependency. */
export interface IRfcConversation {
  open(): Promise<void>;
  close(): Promise<void>;
  /**
   * `options.passport`, when given, is the SAP passport sent with this call
   * only (`@mcp-abap-adt/sap-rfc-lite` >= 0.4.0). A conversation written for
   * two arguments still conforms: it is never handed a third unless a request
   * carried a passport.
   */
  call(
    fm: string,
    params: Record<string, unknown>,
    options?: { passport?: Buffer | undefined },
  ): Promise<Record<string, unknown>>;
  readonly alive: boolean;
  /**
   * Ends the ABAP session context and keeps the connection open
   * (`RfcResetServerContext`, `@mcp-abap-adt/sap-rfc-lite` >= 0.2.0). Where it
   * exists, one conversation serves the non-stateful calls, reset after each;
   * where it does not, each such call opens a conversation of its own.
   */
  resetServerContext?(): Promise<void>;
}

/**
 * What `RfcTransport` opens its conversations with: the logon parameters the
 * provider wrote go in, a conversation comes out. `language` is the logon
 * language a conversation opens in when its logon names no `lang`, where the
 * factory states it — `rfcConversationFrom` does, from the config. The
 * effective logon language is the `lang` the logon carried, else this. Where
 * neither states one, the wire cannot know the logon language, and every
 * request that names a `sap-language` is treated as naming another one.
 */
export type RfcConversationFactory = ((
  logon: Readonly<Record<string, string>>,
) => IRfcConversation) & { readonly language?: string };

/** The header and query parameter that name the language a request runs in. */
const LANGUAGE_FIELD = 'sap-language';

/**
 * The language a request names in `sap-language` — a header, a query
 * parameter in `params`, or one written into the URL — or `undefined` when it
 * names none. Names are read without case, as HTTP reads them; an empty value
 * names no language. A request that names two different languages is refused:
 * which of them a system would take is not something this wire decides.
 */
function requestedLanguage(request: IAdtTransportRequest): string | undefined {
  const named: string[] = [];
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (name.toLowerCase() === LANGUAGE_FIELD) named.push(String(value));
  }
  for (const [name, value] of Object.entries(request.params ?? {})) {
    if (
      name.toLowerCase() === LANGUAGE_FIELD &&
      value !== undefined &&
      value !== null
    ) {
      named.push(String(value));
    }
  }
  const queryStart = request.url.indexOf('?');
  if (queryStart >= 0) {
    const query = new URLSearchParams(request.url.slice(queryStart + 1));
    for (const [name, value] of query) {
      if (name.toLowerCase() === LANGUAGE_FIELD) named.push(value);
    }
  }
  let language: string | undefined;
  for (const value of named) {
    if (value === '') continue;
    if (language === undefined) {
      language = value;
    } else if (!sameLanguage(language, value)) {
      throw new Error(
        `The request names two languages in ${LANGUAGE_FIELD}, ${language} and ${value}; nothing was sent.`,
      );
    }
  }
  return language;
}

/**
 * `language` when a request names it and the conversation's logon language is
 * another (or unknown); `undefined` when it names none or the same one.
 */
function otherLanguage(
  language: string | undefined,
  logonLanguage: string | undefined,
): string | undefined {
  return language !== undefined && !sameLanguage(language, logonLanguage)
    ? language
    : undefined;
}

/**
 * The provider's logon parameters, with the request's language as `lang` over
 * any `lang` the provider wrote — or as they are when the request names none.
 */
function inLanguage(
  parameters: Readonly<Record<string, string>>,
  language: string | undefined,
): Readonly<Record<string, string>> {
  return language === undefined
    ? parameters
    : { ...parameters, lang: language };
}

/** SAP language keys are read without case: `ru` and `RU` are one language. */
function sameLanguage(a: string, b: string | undefined): boolean {
  return b !== undefined && a.toUpperCase() === b.toUpperCase();
}

/**
 * ADT exception types, mapped to what they would have been over HTTP. Standard
 * types, returned in `<exc:exception>` XML.
 */
const EXCEPTION_STATUS: Record<string, { code: number; text: string }> = {
  ExceptionResourceNotFound: { code: 404, text: 'Not Found' },
  ExceptionResourceNoAuthorization: { code: 403, text: 'Forbidden' },
  ExceptionResourceAlreadyExists: { code: 409, text: 'Conflict' },
  ExceptionResourceLocked: { code: 423, text: 'Locked' },
  ExceptionBadRequest: { code: 400, text: 'Bad Request' },
  ExceptionNotSupported: { code: 501, text: 'Not Implemented' },
  ExceptionConflict: { code: 409, text: 'Conflict' },
};

const TYPE_OPEN = '<exc:type';
const TYPE_CLOSE = '</exc:type>';

/**
 * The text of the first `<exc:type …>TEXT</exc:type>` in `body`, by a linear
 * scan: from each `<exc:type`, the first `>` after it opens the text, which
 * runs to the next `<` and counts only when it is not empty and that `<`
 * begins `</exc:type>`. Otherwise the next `<exc:type` is tried.
 */
function exceptionType(body: string): string | undefined {
  let open = body.indexOf(TYPE_OPEN);
  while (open >= 0) {
    const tagEnd = body.indexOf('>', open + TYPE_OPEN.length);
    if (tagEnd < 0) return undefined;
    const textEnd = body.indexOf('<', tagEnd + 1);
    if (textEnd > tagEnd + 1 && body.startsWith(TYPE_CLOSE, textEnd)) {
      return body.slice(tagEnd + 1, textEnd);
    }
    open = body.indexOf(TYPE_OPEN, open + 1);
  }
  return undefined;
}

/**
 * The status an exception document stands for. A type is looked up only as an
 * own key of `EXCEPTION_STATUS`: `toString`, `constructor` and the other
 * members every object inherits name no status, and give 500 as an unknown
 * type does.
 */
function statusFromExceptionXml(body: string): { code: number; text: string } {
  const type = exceptionType(body)?.trim();
  return type && Object.hasOwn(EXCEPTION_STATUS, type)
    ? EXCEPTION_STATUS[type]
    : { code: 500, text: 'Internal Server Error' };
}

/** An own data property of `source`, read without running a getter. */
function ownData(source: object, name: string): unknown {
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
function rfcErrorOf(thrown: unknown): IRfcErrorInfo | undefined {
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

/**
 * What a failed call throws: an `Error` with today's words, and the SDK's
 * fields as `rfc` when the SDK named the failure. The top-level `code` is not
 * set: `rfc` does not change what it means.
 */
function rfcCallError(
  text: string,
  rfc: IRfcErrorInfo | undefined,
): Error & IAbapConnectionError {
  const error = new Error(text);
  return rfc === undefined ? error : Object.assign(error, { rfc });
}

function message(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object') return JSON.stringify(e);
  return String(e);
}

/**
 * Header names whose VALUE must never reach a log.
 *
 * `Authorization` carries the Basic-auth credential in plain (base64, but that
 * is not encryption) form — and it is not the only one. `request.headers`
 * reaches this wire verbatim from the caller, so a consumer's `Cookie`
 * (`SAP_SESSIONID_*`, `MYSAPSSO2`), an `x-csrf-token` or its own `X-Api-Key`
 * arrives here too. A log line advertised as safe to paste into an issue has
 * to be safe for the headers nobody here anticipated, so this matches by
 * part of the name rather than by the list we happened to think of.
 *
 * Plain string code, no regular expression: the name is folded to lower case
 * in ASCII `A`–`Z` only (the former `/i` patterns, without the `u` flag, never
 * folded a non-ASCII character to an ASCII letter — `toLowerCase()` would map
 * the Kelvin sign to `k`), then searched for each part.
 */
const SECRET_HEADER_PARTS = [
  'authorization',
  'cookie',
  'token',
  'secret',
  'password',
  'credential',
  'apikey',
  'api-key',
  'api_key',
];

/** `text` with ASCII `A`–`Z` lowered, every other character as it is. */
function asciiLowerCase(text: string): string {
  let folded = '';
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    folded +=
      unit >= 0x41 && unit <= 0x5a
        ? String.fromCharCode(unit + 0x20)
        : text.charAt(i);
  }
  return folded;
}

/** Whether a header's value must not reach a log, by its name. */
function isSecretHeader(name: string): boolean {
  const folded = asciiLowerCase(name);
  return SECRET_HEADER_PARTS.some((part) => folded.includes(part));
}

/**
 * The header an HTTP request carries the SAP passport in. Over RFC it is not a
 * header field: `SADT_REST_RFC_ENDPOINT` does not read one there, so the
 * passport goes to the SDK as the call's own.
 */
const PASSPORT_HEADER = 'sap-passport';

function isPassportHeader(name: string): boolean {
  return asciiLowerCase(name) === PASSPORT_HEADER;
}

/** `0`–`9`, `A`–`F`, `a`–`f`. */
function isHexDigit(unit: number): boolean {
  return (
    (unit >= 0x30 && unit <= 0x39) ||
    (unit >= 0x41 && unit <= 0x46) ||
    (unit >= 0x61 && unit <= 0x66)
  );
}

/** Non-empty, of even length, and every character a hex digit. */
function isHex(value: string): boolean {
  if (value.length === 0 || value.length % 2 !== 0) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (!isHexDigit(value.charCodeAt(i))) return false;
  }
  return true;
}

/**
 * The passport a request carries in `SAP-PASSPORT` (its name read without
 * case), decoded; `undefined` when it carries none. Refused, before anything
 * is sent, when the header is named more than once or its value is not hex —
 * the header named, its value never quoted. The passport's structure is the
 * SDK's to check.
 */
function passportOf(
  headers: Readonly<Record<string, string>> | undefined,
): Buffer | undefined {
  let value: string | undefined;
  for (const [name, each] of Object.entries(headers ?? {})) {
    if (!isPassportHeader(name)) continue;
    if (value !== undefined) {
      throw new Error(
        'The request names SAP-PASSPORT more than once; nothing was sent.',
      );
    }
    value = each;
  }
  if (value === undefined) return undefined;
  if (!isHex(value)) {
    throw new Error(
      'The SAP-PASSPORT header is not a passport in hex; nothing was sent.',
    );
  }
  // Only after the test: `Buffer.from(…, 'hex')` stops silently at the first
  // pair that is not hex.
  return Buffer.from(value, 'hex');
}

/**
 * The NAME is kept and only the VALUE goes — a redacted header still says it
 * was sent, which is half of what the log is read for.
 */
function redactHeaders(
  fields: { NAME: string; VALUE: string }[],
): { NAME: string; VALUE: string }[] {
  return fields.map((field) =>
    isSecretHeader(field.NAME) ? { ...field, VALUE: '[redacted]' } : field,
  );
}

/**
 * How much of a body a log line carries before it is cut. An ADT payload is
 * an ABAP source or a repository listing: whole ones are megabytes, and a log
 * sink handed a single line that size is a problem of its own.
 */
const DEFAULT_MAX_LOGGED_BODY_CHARS = 2000;

function clip(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}… (+${text.length - max} more chars)`;
}

/** What this wire does beyond carrying the request. */
export interface IRfcTransportOptions {
  /**
   * Whether the debug channel also carries the request headers and both
   * bodies. Off by default, and deliberately not inferred from the presence
   * of a logger: `ILogger` has no level predicate, so `logger?.debug()` cannot
   * tell an enabled debug channel from a discarded one — without this flag
   * every caller who passes a logger at all would pay to build and throw away
   * a copy of every body on the wire.
   */
  logWire?: boolean;

  /**
   * Ceiling on a logged body, in characters. Defaults to 2000. `0` logs the
   * size and none of the bytes, `Infinity` asks for the whole body, and a
   * negative or `NaN` value falls back to the default rather than throwing —
   * a debug option is not worth failing a connection over.
   */
  maxLoggedBodyChars?: number;
}

/** Axios's own default, which the classification above this seam is written against. */
const admits2xx = (status: number) => status >= 200 && status < 300;

export class RfcTransport implements IOnPremTransport {
  readonly kind = 'rfc';

  /** Which system this wire is for. Read by the compiler, never at runtime. */
  readonly system = 'onprem' as const;

  private conversation: IRfcConversation | null = null;
  /**
   * Bumped by every `close()`. A call that opened a conversation of its own
   * compares it after the logon: the wire may have been closed while that
   * logon was under way, and a write must not go out on a wire the caller has
   * already given back.
   */
  private generation = 0;

  /**
   * The conversation the non-stateful calls share when the client can reset
   * it: opened on the first such call, reset after every call, closed with the
   * wire. `null` until then, or after a reset failed.
   */
  private stateless: IRfcConversation | null = null;
  /** Taken by the call on `stateless` until its reset is done. */
  private statelessBusy = false;
  /** `false` once a client showed it cannot reset; then every call opens its own. */
  private canReset: boolean | undefined;
  /** Names the conversation, and so the ABAP session it carries. */
  private conversationId = '';
  /**
   * The language the stateful conversation logged on in: the `lang` its logon
   * carried — the provider's where it wrote one, else the factory's. What a
   * request's `sap-language` is compared with. `undefined` when neither
   * states one.
   */
  private logonLanguage: string | undefined;
  /** The language the kept stateless conversation logged on in, the same way. */
  private statelessLanguage: string | undefined;
  /**
   * Where each logon asks the provider what to open with. Kept from `open()`;
   * `null` when the wire is driven without a lifecycle, and then a conversation
   * opens with the address alone.
   */
  private context: IAdtSessionContext | null = null;

  /**
   * Nothing to fold in. `SADT_REST_RFC_ENDPOINT` answers with two header
   * fields — `~server_protocol` and `content-type` — on every call, including
   * one that asks for a token with `x-csrf-token: fetch`, and on a stateful
   * POST. Measured on E19. There is no ICM in this path, so there is no ICF
   * session to cookie and no application server to be redispatched between.
   */
  ingest(): void {}

  /** None, and never any: see `ingest()`. */
  cookies(): null {
    return null;
  }

  /** None: the session is the conversation, which no cookie names. */
  sessionCookies(): null {
    return null;
  }

  /**
   * Refused, with nothing sent: an RFC session is a conversation, opened by
   * this process and held by it, and a conversation cannot be taken over.
   */
  async resume(): Promise<void> {
    throw new TypeError(
      'An RFC session cannot be taken over: it is a conversation, not something a cookie names. Over RFC, connect() opens a new session.',
    );
  }

  /**
   * Nothing to establish. `open()` made the ABAP session, and there is no token
   * to earn: this endpoint answers `x-csrf-token: fetch` with the same two
   * header fields it answers everything else with. A wire with no
   * cross-site request to forge against needs no token to prove one was not.
   */
  async establish(_context: IAdtEstablishContext): Promise<void> {}

  /** None: see `establish()`. */
  csrfToken(): null {
    return null;
  }

  /**
   * Ignored. Nothing on this wire reads a token, and keeping one would be
   * state that never leaves the object.
   */
  adoptCsrfToken(): void {}

  /**
   * The conversation, which IS the session — so it is fingerprinted by its own
   * existence rather than by an address the server hands out.
   */
  /** The conversation IS the session, so it exists exactly while that does. */
  sessionEstablished(): boolean {
    return this.conversation?.alive ?? false;
  }

  sessionFingerprint(): Map<string, string> {
    const fingerprint = new Map<string, string>();
    if (this.conversation?.alive) {
      fingerprint.set('rfc-conversation', this.conversationId);
    }
    return fingerprint;
  }

  /** None: there is no dispatcher in front of this wire to stay bound to. */
  affinityHeaders(): Record<string, string> {
    return {};
  }

  /**
   * Nothing to forget separately. The session ends when the conversation does,
   * and that is `close()` — a wire whose state could be dropped while the
   * conversation stayed open would be claiming a session it had disowned.
   */
  forgetSession(): void {}

  /**
   * The client is built by a factory rather than constructed here: the SDK is
   * an optional dependency loaded by `require` at open time, and a transport
   * that reached for it in its constructor could not be built at all on a
   * machine without it.
   */
  constructor(
    private readonly connect: RfcConversationFactory,
    private readonly logger: ILogger | null = null,
    private readonly options: IRfcTransportOptions = {},
  ) {}

  /** Cut a body down to what a log line may carry. */
  private clipped(text: string): string {
    const asked =
      this.options.maxLoggedBodyChars ?? DEFAULT_MAX_LOGGED_BODY_CHARS;
    // A nonsense ceiling is a typo in a debug option, and a debug option is
    // not worth failing a connection over — but it is worth not honouring. A
    // negative one reaches `slice(0, -n)`, which drops the END of the body
    // while the line still says the rest was merely clipped: a log that lies
    // about what it cut is worse than one that cut too much. `NaN` compares
    // false against every bound, so the test is for the good case.
    const ceiling =
      asked >= 0 ? Math.floor(asked) : DEFAULT_MAX_LOGGED_BODY_CHARS;
    return clip(text, ceiling);
  }

  async open(context?: IAdtSessionContext): Promise<void> {
    if (context) this.context = context;
    if (this.conversation?.alive) return;
    const generation = this.generation;
    const parameters = await this.logonParameters();
    const conversation = await this.openedWith(parameters);
    // close() ran while this logged on: the session it would have handed out
    // belongs to a wire already given back, so it is closed, not kept.
    if (generation !== this.generation) {
      await this.closeQuietly(conversation);
      throw new Error('RFC transport was closed while it was being opened.');
    }
    this.conversation = conversation;
    this.logonLanguage = this.languageOf(parameters);
    // Minted here, where the session begins. A conversation opened after an
    // earlier one closed is a DIFFERENT ABAP session, and the fingerprint has
    // to say so — a constant would report `unchanged` across a reconnect and
    // hide exactly the replacement the identity policy exists to catch.
    this.conversationId = randomUUID();
    this.logger?.debug('RFC conversation opened (the stateful one)');
  }

  /** Never throws, and a repeat call finds nothing owed. */
  async close(): Promise<void> {
    // Everything the wire holds is given up BEFORE the first await. Closing
    // takes time, and a send() that ran meanwhile would otherwise find the
    // old stateful conversation still `alive` — a lock request carried on a
    // session already being given back — or open a stateless one of its own
    // and send a write after close(). With both references gone and the
    // generation moved on, such a send() is refused as "not open", and a
    // logon still under way sees the change and sends nothing.
    this.generation += 1;
    const stateless = this.stateless;
    const conversation = this.conversation;
    this.stateless = null;
    this.conversation = null;
    this.conversationId = '';
    this.logonLanguage = undefined;
    this.statelessLanguage = undefined;
    if (stateless) await this.closeQuietly(stateless);
    if (!conversation) return;
    try {
      await conversation.close();
    } catch (e) {
      this.logQuietly(() => `RFC close error: ${message(e)}`);
      return;
    }
    this.logQuietly(() => 'RFC conversation closed');
  }

  async send(request: IAdtTransportRequest): Promise<IAdtTransportResponse> {
    if (!this.conversation?.alive) {
      throw new Error('RFC transport is not open. Call connect() first.');
    }
    // The same verdict HTTP takes: the flag the connection sets, or a session
    // header the caller wrote itself. A caller that asks for the lock's
    // session either way has to land on the conversation that holds it.
    // Taken once, here: every await below compares against it, and a call
    // that finds the wire closed since it began sends nothing.
    const generation = this.generation;
    const passport = passportOf(request.headers);
    const language = requestedLanguage(request);
    if (isStatefulRequest(request)) {
      const other = otherLanguage(language, this.logonLanguage);
      if (other !== undefined) {
        throw new Error(
          `The request asks for ${LANGUAGE_FIELD} ${other}, but the stateful RFC session is logged on in ${this.logonLanguage ?? 'a language neither the RFC conversation factory nor the provider states'}: a session cannot change its language, so the request was not sent.`,
        );
      }
      return this.carry(request, this.conversation, generation, passport, true);
    }
    return this.carryOnItsOwn(request, language, generation, passport);
  }

  /**
   * A request that is not stateful, in a fresh ABAP session.
   *
   * Where the client can reset (`resetServerContext`), one kept conversation
   * serves these calls and is reset after each: a fresh context without a new
   * logon, ~0.1 s instead of ~0.5 s on E19. Where it cannot, or while that
   * conversation is busy with another call, the call opens a conversation of
   * its own and closes it when it answers.
   *
   * A call and its reset go together: a second call on the kept conversation
   * before the first one's reset would run in the first one's context — a
   * package the first one saved would refuse the second one's write (PAK/058).
   * So a concurrent call takes a conversation of its own instead of waiting.
   *
   * A request that names a `sap-language` runs on a conversation logged on in
   * it: the kept one when that one's logon language is the same, else one of
   * its own logged on with that `lang`, closed after the call.
   */
  private async carryOnItsOwn(
    request: IAdtTransportRequest,
    language: string | undefined,
    generation: number,
    passport: Buffer | undefined,
  ): Promise<IAdtTransportResponse> {
    if (this.canReset !== false && !this.statelessBusy) {
      return this.carryOnKept(request, language, generation, passport);
    }
    return this.carryOnThrowaway(
      request,
      inLanguage(await this.logonParameters(), language),
      generation,
      passport,
    );
  }

  private async carryOnKept(
    request: IAdtTransportRequest,
    language: string | undefined,
    generation: number,
    passport: Buffer | undefined,
  ): Promise<IAdtTransportResponse> {
    this.statelessBusy = true;
    try {
      let kept = this.stateless;
      if (!kept?.alive) {
        // The provider is asked first: what it writes says which language the
        // kept conversation would log on in, before any logon is made.
        const parameters = await this.logonParameters();
        if (
          otherLanguage(language, this.languageOf(parameters)) !== undefined
        ) {
          return await this.carryOnThrowaway(
            request,
            inLanguage(parameters, language),
            generation,
            passport,
          );
        }
        const opened = await this.openOwn(parameters, generation);
        // Checked again after the await: close() may have run since openOwn()
        // checked, and a conversation of a closed wire must not become the
        // kept one of the next.
        if (generation !== this.generation) {
          await this.closeQuietly(opened);
          throw new Error(
            'RFC transport was closed while the call was being opened; nothing was sent.',
          );
        }
        if (typeof opened.resetServerContext !== 'function') {
          // An older client: it cannot be reset, so it is used once and closed,
          // and every later call opens its own.
          this.canReset = false;
          try {
            return await this.carry(request, opened, generation, passport);
          } finally {
            await this.closeUnlessReleased(opened);
          }
        }
        this.canReset = true;
        this.stateless = opened;
        this.statelessLanguage = this.languageOf(parameters);
        kept = opened;
        this.logger?.debug(
          'RFC stateless conversation opened (reset per call)',
        );
      } else if (
        otherLanguage(language, this.statelessLanguage) !== undefined
      ) {
        return await this.carryOnThrowaway(
          request,
          inLanguage(await this.logonParameters(), language),
          generation,
          passport,
        );
      }
      try {
        return await this.carry(request, kept, generation, passport);
      } finally {
        if (!kept.alive) {
          // An RFC error ended it, and the library released it: nothing is
          // left to reset or close, and either would reject. It carried no
          // session of this instance — a reset clears it after every call —
          // so it is replaced as a failed reset replaces it: dropped, and the
          // next call opens another.
          this.dropStateless(kept);
        } else {
          try {
            await kept.resetServerContext?.();
          } catch (e) {
            // A context that could not be reset must not serve the next call.
            this.logQuietly(
              () =>
                `RFC reset failed, dropping the conversation: ${message(e)}`,
            );
            this.dropStateless(kept);
            await this.closeQuietly(kept);
          }
        }
      }
    } finally {
      this.statelessBusy = false;
    }
  }

  /**
   * A conversation opened for this one call with `parameters`, closed when it
   * answers, whatever the answer.
   */
  private async carryOnThrowaway(
    request: IAdtTransportRequest,
    parameters: Readonly<Record<string, string>>,
    generation: number,
    passport: Buffer | undefined,
  ): Promise<IAdtTransportResponse> {
    const own = await this.openOwn(parameters, generation);
    try {
      this.logger?.debug('RFC conversation opened for one stateless call');
      return await this.carry(request, own, generation, passport);
    } finally {
      await this.closeUnlessReleased(own);
    }
  }

  /**
   * The stateful conversation is `conversation` no more: the library released
   * it, so there is nothing left to close, and a close would only reject.
   */
  private dropSession(conversation: IRfcConversation): void {
    if (this.conversation === conversation) {
      this.conversation = null;
      this.conversationId = '';
      this.logonLanguage = undefined;
    }
  }

  /** The kept stateless conversation is `conversation` no more. */
  private dropStateless(conversation: IRfcConversation): void {
    if (this.stateless === conversation) {
      this.stateless = null;
      this.statelessLanguage = undefined;
    }
  }

  /**
   * A conversation used for one call, closed — unless an RFC error ended it:
   * the library has released it, and a close would only reject.
   */
  private async closeUnlessReleased(
    conversation: IRfcConversation,
  ): Promise<void> {
    if (conversation.alive) await this.closeQuietly(conversation);
  }

  /**
   * A new conversation, logged on with `parameters`. The logon takes time
   * (~0.5 s on E19); if the wire was closed meanwhile, the conversation is
   * closed again and nothing is sent — not a PUT, not a DELETE — on a wire
   * already given back.
   */
  private async openOwn(
    parameters: Readonly<Record<string, string>>,
    generation: number,
  ): Promise<IRfcConversation> {
    const own = await this.openedWith(parameters);
    if (generation !== this.generation || !this.conversation?.alive) {
      await this.closeQuietly(own);
      throw new Error(
        'RFC transport was closed while the call was being opened; nothing was sent.',
      );
    }
    return own;
  }

  /**
   * The target a provider writes its logon into.
   *
   * Parameters accumulate over the calls of one logon and go into this open
   * alone. TLS material is refused: there is no TLS to configure on this wire,
   * and whether that matters is the provider's call.
   */
  private logonTarget(parameters: Record<string, string>): ILogonTarget {
    return {
      tlsMaterial: (): AuthOutcome => ({
        ok: false,
        refusal: authError['logon-target']({
          wire: 'rfc',
          refused: 'tls-material',
        }),
      }),
      logonParameters: (written): AuthOutcome => {
        Object.assign(parameters, written);
        return { ok: true };
      },
    };
  }

  /** What the provider writes for one logon: asked every time. */
  private async logonParameters(): Promise<Record<string, string>> {
    const parameters: Record<string, string> = {};
    await this.context?.logon(this.logonTarget(parameters));
    return parameters;
  }

  /**
   * The language a logon with `parameters` logs on in: its `lang` — the
   * provider's, or the one a call in another language put over it — else the
   * factory's.
   */
  private languageOf(
    parameters: Readonly<Record<string, string>>,
  ): string | undefined {
    return parameters.lang ?? this.connect.language;
  }

  /**
   * A new conversation, logged on with `parameters`; a failed open is a
   * refused logon whose cause is the SDK's own error, untouched — a provider
   * reads its `key` and message.
   */
  private async openedWith(
    parameters: Readonly<Record<string, string>>,
  ): Promise<IRfcConversation> {
    const conversation = this.connect(parameters);
    try {
      await conversation.open();
    } catch (e) {
      throw new WireLogonError(e);
    }
    return conversation;
  }

  /**
   * A debug line that cannot throw: the line is built and written inside the
   * guard, so neither a value that will not stringify nor a logger that throws
   * stops what logs it — a close above all.
   */
  private logQuietly(line: () => string): void {
    try {
      this.logger?.debug(line());
    } catch {
      // A broken logger must not stop a close; there is nowhere left to say so.
    }
  }

  private async closeQuietly(conversation: IRfcConversation): Promise<void> {
    try {
      await conversation.close();
    } catch (e) {
      this.logQuietly(() => `RFC close error: ${message(e)}`);
    }
  }

  private async carry(
    request: IAdtTransportRequest,
    conversation: IRfcConversation,
    generation: number,
    passport: Buffer | undefined,
    /** Whether `conversation` is the stateful one: the instance's session. */
    carriesSession = false,
  ): Promise<IAdtTransportResponse> {
    const method = request.method.toUpperCase();

    // HTTP clients serialise `params`; RFC has no such step, so they go into
    // the URI here or they do not travel at all.
    let uri = request.url;
    const query = Object.entries(request.params ?? {}).filter(
      ([, v]) => v !== undefined && v !== null,
    );
    if (query.length > 0) {
      const serialised = new URLSearchParams(
        query.map(([k, v]) => [k, String(v)]),
      ).toString();
      uri += (uri.includes('?') ? '&' : '?') + serialised;
    }
    // The passport is not a header field over RFC: it goes to the SDK as the
    // call's own (`passport`, read in `send()`).
    const headerFields = Object.entries(request.headers ?? {})
      .filter(([NAME]) => !isPassportHeader(NAME))
      .map(([NAME, VALUE]) => ({ NAME, VALUE: String(VALUE) }));

    // ADT refuses a request with no Accept — `400 ExceptionResourceBadRequest:
    // Accept header missing`, measured on E19. Over HTTP axios supplies the
    // default and nobody notices; this endpoint forwards only what it is
    // handed, so without this the same call dies on this wire alone.
    if (!headerFields.some((h) => h.NAME.toLowerCase() === 'accept')) {
      headerFields.push({ NAME: 'Accept', VALUE: '*/*' });
    }

    const body =
      request.data !== undefined && request.data !== null
        ? String(request.data)
        : '';
    if (
      body &&
      !headerFields.some((h) => h.NAME.toLowerCase() === 'content-type')
    ) {
      headerFields.push({
        NAME: 'Content-Type',
        VALUE: 'text/plain; charset=utf-8',
      });
    }

    this.logger?.debug(`RFC → ${method} ${uri}`);
    // `RFC → METHOD URI` alone was not enough to debug a body that goes
    // missing or gets mis-serialised on the way to `SADT_REST_RFC_ENDPOINT`
    // (found chasing a `superPackage` that disappeared before it reached
    // SAP) — the actual bytes matter, so the debug channel carries them too
    // when the caller asks for it, redacted and clipped so a captured log is
    // safe to paste into an issue and small enough to want to.
    if (this.logger && this.options.logWire) {
      this.logger.debug(
        `RFC HEADERS: ${JSON.stringify(redactHeaders(headerFields))}`,
      );
      // A GET has no body, and `RFC BODY (0 chars):` says nothing.
      if (body) {
        this.logger.debug(
          `RFC BODY (${body.length} chars): ${this.clipped(body)}`,
        );
      }
    }

    // `request.timeout` is deliberately not read, and the absence of the word
    // here is what made that look like an oversight (#42).
    //
    // There is nothing to enforce it with: the SDK exposes no cancel, and an
    // abandoned call still holds the conversation — the next one would queue
    // behind a call nobody is waiting for. A deadline that reports failure
    // while the wire stays busy is worse than none, because the error reads as
    // "safe to retry" when it is not.
    //
    // Nor is one needed. What bounds this call is the server: a dialog step
    // ends at `rdisp/max_wprun_time`. And a call that cannot be torn down
    // mid-flight is precisely what the connection keeps over HTTP, where a
    // request inside a critical section carries no deadline at all, so an
    // abort cannot orphan a lock handle. Here that comes free.
    // The last point before anything leaves: nothing awaits between this
    // check and the call, so a close() that ran at any await above stops it.
    if (generation !== this.generation) {
      throw new Error(
        'RFC transport was closed before the call was sent; nothing was sent.',
      );
    }
    let raw: Record<string, unknown>;
    try {
      const params = {
        REQUEST: {
          REQUEST_LINE: {
            METHOD: method,
            URI: uri,
            VERSION: 'HTTP/1.1',
          },
          HEADER_FIELDS: headerFields,
          MESSAGE_BODY: body ? Buffer.from(body, 'utf-8') : Buffer.alloc(0),
        },
      };
      // The passport, for this call only; without one, the call as it always
      // was — two arguments, so a conversation written for two still works.
      raw =
        passport === undefined
          ? await conversation.call('SADT_REST_RFC_ENDPOINT', params)
          : await conversation.call('SADT_REST_RFC_ENDPOINT', params, {
              passport,
            });
    } catch (e) {
      // An RFC-level failure, not an answer: nothing came back to classify.
      const msg = message(e);
      this.logger?.error(`RFC call failed: ${msg}`);
      const failure = rfcCallError(
        `RFC call to SADT_REST_RFC_ENDPOINT failed: ${msg}`,
        rfcErrorOf(e),
      );
      // The library released the stateful conversation after the error
      // (`alive` false), and it was not a close() of ours: the session it
      // carried is gone, with every lock taken in it. Said, not cured — no
      // other conversation is opened in its place.
      if (
        carriesSession &&
        !conversation.alive &&
        generation === this.generation
      ) {
        this.dropSession(conversation);
        throw new WireSessionLostError(failure.message, failure.rfc);
      }
      throw failure;
    }

    const answer = record(raw.RESPONSE) ?? raw;
    const statusLine = record(answer.STATUS_LINE);

    const rawCode = statusLine?.STATUS_CODE ?? statusLine?.CODE;
    let status =
      typeof rawCode === 'string'
        ? Number.parseInt(rawCode, 10)
        : typeof rawCode === 'number'
          ? rawCode
          : 0;
    const reason = statusLine?.REASON_PHRASE ?? statusLine?.REASON;
    let statusText: string = typeof reason === 'string' ? reason : '';

    const answered = answer.MESSAGE_BODY;
    const data = answered
      ? Buffer.isBuffer(answered)
        ? answered.toString('utf-8')
        : String(answered)
      : '';

    const headers: Record<string, unknown> = {};
    const fields = answer.HEADER_FIELDS;
    for (const field of Array.isArray(fields) ? fields : []) {
      const entry = record(field);
      if (entry?.NAME && entry.VALUE !== undefined) {
        headers[String(entry.NAME).toLowerCase()] = entry.VALUE;
      }
    }

    // BASIS < 7.50 answers without populating STATUS_LINE. Left alone, a
    // failure would read as 200 with an error document in the body — which is
    // the green run that inspected nothing, one layer down.
    if (!status && data.includes('<exc:exception')) {
      const detected = statusFromExceptionXml(data);
      status = detected.code;
      statusText = detected.text;
      this.logger?.debug(
        `RFC: STATUS_LINE empty, read ${status} out of the exception XML`,
      );
    }
    if (!status) {
      status = 200;
      statusText = statusText || 'OK';
    }

    this.logger?.debug(`RFC ← ${status} ${statusText} (${data.length} bytes)`);
    // The line above already carries the size, so an empty body needs no line
    // of its own.
    if (this.logger && this.options.logWire && data) {
      this.logger.debug(`RFC RESPONSE BODY: ${this.clipped(data)}`);
    }

    const response: IAdtTransportResponse = {
      status,
      statusText,
      headers,
      data,
    };

    const admits = request.validateStatus ?? admits2xx;
    if (!admits(status)) {
      const error = new Error(
        `Request failed with status ${status}: ${method} ${uri}`,
      ) as Error & { response: IAdtTransportResponse };
      error.response = response;
      throw error;
    }

    return response;
  }
}
