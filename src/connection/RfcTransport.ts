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

import type { ILogger } from '../logger.js';
import type {
  IAdtTransport,
  IAdtTransportRequest,
  IAdtTransportResponse,
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

/** Axios's own default, which the classification above this seam is written against. */
const admits2xx = (status: number) => status >= 200 && status < 300;

export class RfcTransport implements IAdtTransport {
  readonly kind = 'rfc';

  private conversation: IRfcConversation | null = null;

  /**
   * The client is built by a factory rather than constructed here: the SDK is
   * an optional dependency loaded by `require` at open time, and a transport
   * that reached for it in its constructor could not be built at all on a
   * machine without it.
   */
  constructor(
    private readonly connect: () => IRfcConversation,
    private readonly logger: ILogger | null = null,
  ) {}

  async open(): Promise<void> {
    if (this.conversation?.alive) return;
    const conversation = this.connect();
    try {
      await conversation.open();
    } catch (e) {
      throw new Error(`Failed to open RFC connection: ${message(e)}`);
    }
    this.conversation = conversation;
    this.logger?.debug('RFC conversation opened (stateful by nature)');
  }

  /** Never throws, and a repeat call finds nothing owed. */
  async close(): Promise<void> {
    const conversation = this.conversation;
    if (!conversation) return;
    this.conversation = null;
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
