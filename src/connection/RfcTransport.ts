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
 * **What is NOT here.** Cookies, the CSRF token, `x-sap-adt-sessiontype` and
 * the session lifecycle belong to the connection above this seam and are
 * already in `request.headers` by the time `send()` is called. A transport that
 * also captured cookies would be doing that work twice, and the two copies
 * would disagree the first time one of them was cleared.
 */

import { randomUUID } from 'node:crypto';
import type { ILogger } from '../logger.js';
import type {
  IAdtEstablishContext,
  IAdtTransport,
  IAdtTransportRequest,
  IAdtTransportResponse,
  IOnPremTransport,
} from './IAdtTransport.js';

/** The slice of the native client this needs, so the SDK is not a hard dependency. */
export interface IRfcConversation {
  open(): Promise<void>;
  close(): Promise<void>;
  call(
    fm: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, any>>;
  readonly alive: boolean;
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

function statusFromExceptionXml(body: string): { code: number; text: string } {
  const type = /<exc:type[^>]*>([^<]+)<\/exc:type>/.exec(body)?.[1]?.trim();
  return (
    (type ? EXCEPTION_STATUS[type] : undefined) ?? {
      code: 500,
      text: 'Internal Server Error',
    }
  );
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
 * pattern rather than by the list we happened to think of.
 */
const SECRET_HEADER_PATTERNS = [
  /authorization/i,
  /cookie/i,
  /token/i,
  /secret/i,
  /password/i,
  /credential/i,
  /api[-_]?key/i,
];

/**
 * The NAME is kept and only the VALUE goes — a redacted header still says it
 * was sent, which is half of what the log is read for.
 */
function redactHeaders(
  fields: { NAME: string; VALUE: string }[],
): { NAME: string; VALUE: string }[] {
  return fields.map((field) =>
    SECRET_HEADER_PATTERNS.some((pattern) => pattern.test(field.NAME))
      ? { ...field, VALUE: '[redacted]' }
      : field,
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
  /** Names the conversation, and so the ABAP session it carries. */
  private conversationId = '';

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
    private readonly connect: () => IRfcConversation,
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

  async open(): Promise<void> {
    if (this.conversation?.alive) return;
    const conversation = this.connect();
    try {
      await conversation.open();
    } catch (e) {
      throw new Error(`Failed to open RFC connection: ${message(e)}`);
    }
    this.conversation = conversation;
    // Minted here, where the session begins. A conversation opened after an
    // earlier one closed is a DIFFERENT ABAP session, and the fingerprint has
    // to say so — a constant would report `unchanged` across a reconnect and
    // hide exactly the replacement the identity policy exists to catch.
    this.conversationId = randomUUID();
    this.logger?.debug('RFC conversation opened (stateful by nature)');
  }

  /** Never throws, and a repeat call finds nothing owed. */
  async close(): Promise<void> {
    const conversation = this.conversation;
    if (!conversation) return;
    this.conversation = null;
    this.conversationId = '';
    try {
      await conversation.close();
      this.logger?.debug('RFC conversation closed');
    } catch (e) {
      this.logger?.debug(`RFC close error: ${message(e)}`);
    }
  }

  async send(request: IAdtTransportRequest): Promise<IAdtTransportResponse> {
    if (!this.conversation?.alive) {
      throw new Error('RFC transport is not open. Call connect() first.');
    }

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
    const headerFields = Object.entries(request.headers ?? {}).map(
      ([NAME, VALUE]) => ({ NAME, VALUE: String(VALUE) }),
    );

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
    // mid-flight is precisely what the connection emulates over HTTP, where
    // a critical section raises the caller's timeout to a ten-minute ceiling so
    // an abort cannot orphan a lock handle. Here that comes free.
    let raw: Record<string, any>;
    try {
      raw = await this.conversation.call('SADT_REST_RFC_ENDPOINT', {
        REQUEST: {
          REQUEST_LINE: {
            METHOD: method,
            URI: uri,
            VERSION: 'HTTP/1.1',
          },
          HEADER_FIELDS: headerFields,
          MESSAGE_BODY: body ? Buffer.from(body, 'utf-8') : Buffer.alloc(0),
        },
      });
    } catch (e) {
      // An RFC-level failure, not an answer: nothing came back to classify.
      const msg = message(e);
      this.logger?.error(`RFC call failed: ${msg}`);
      throw new Error(`RFC call to SADT_REST_RFC_ENDPOINT failed: ${msg}`);
    }

    const answer = raw.RESPONSE ?? raw;

    const rawCode = answer.STATUS_LINE?.STATUS_CODE ?? answer.STATUS_LINE?.CODE;
    let status =
      typeof rawCode === 'string'
        ? Number.parseInt(rawCode, 10)
        : (rawCode ?? 0);
    let statusText: string =
      answer.STATUS_LINE?.REASON_PHRASE ?? answer.STATUS_LINE?.REASON ?? '';

    const data = answer.MESSAGE_BODY
      ? Buffer.isBuffer(answer.MESSAGE_BODY)
        ? answer.MESSAGE_BODY.toString('utf-8')
        : String(answer.MESSAGE_BODY)
      : '';

    const headers: Record<string, unknown> = {};
    for (const field of answer.HEADER_FIELDS ?? []) {
      if (field.NAME && field.VALUE !== undefined) {
        headers[String(field.NAME).toLowerCase()] = field.VALUE;
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
