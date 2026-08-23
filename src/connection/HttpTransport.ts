/**
 * An ADT request carried over HTTP.
 *
 * The obvious one, and until now the one that did not exist as a thing: RFC was
 * an object while HTTP was a branch inside `getAxiosInstance()`. An axis with a
 * code path on one end cannot be named in a type — a default type parameter has
 * nothing to point at — so this is what makes the two ends symmetrical.
 *
 * No `open()` or `close()`. A request opens its own socket and there is no
 * conversation to establish or give back; those members exist for a transport
 * that owns a wire, which is RFC.
 *
 * **Where the two axes touch.** TLS client-certificate material comes from the
 * CREDENTIAL — a certificate authenticates through the transport rather than
 * through a header — and configures this. It is taken as a thunk rather than a
 * value so it is read when the client is first built, by which time the
 * credential has been prepared and knows what it holds. Read in a constructor,
 * it would be whatever was loaded before the connection started, which for a
 * certificate is nothing.
 */

import { Agent, type AgentOptions } from 'node:https';
import axios, { type AxiosInstance } from 'axios';
import type { ILogger } from '../logger.js';
import { mergeCookieHeaders } from '../utils/cookies.js';
import { CSRF_CONFIG, CSRF_ERROR_MESSAGES } from './csrfConfig.js';
import type {
  IAdtEstablishContext,
  IAdtTransport,
  IAdtTransportRequest,
  IAdtTransportResponse,
} from './IAdtTransport.js';

/** A 404 there means the system has no such endpoint, not that it is unwell. */
function absentEndpoint(error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | undefined)
    ?.response?.status;
  return status === 404 || status === 501;
}

export class HttpTransport implements IAdtTransport {
  /**
   * A real wire, usable on its own: it sends, holds a jar, and earns a CSRF
   * token. What the two subclasses add is not the wire but the SESSION
   * MECHANISM — the cloud resource, the platform logoff — which is a different
   * question and the one the consumer answers by taking one of them.
   *
   * A bare one therefore does something well defined: it carries requests and
   * never asks for or gives back a session. Which system a connector is for is
   * enforced by its type parameter, not by this being unusable.
   */
  readonly kind: string = 'http';

  private instance: AxiosInstance | null = null;

  /**
   * The wire's own state.
   *
   * Here rather than on the connection because it is what HTTP *is*: a cookie
   * jar, the session those cookies address, and the application server the
   * session lives on. A connection that held these would be holding them for
   * every transport, including one that can never fill them.
   */
  private readonly jar = new Map<string, string>();
  private combined: string | null = null;
  private appServer: string | null = null;
  private token: string | null = null;

  constructor(
    private readonly agentOptions: () => AgentOptions = () => ({}),
    protected readonly logger: ILogger | null = null,
    /**
     * `client` because SAP answers `sap-usercontext` with the system default
     * rather than the client that was asked for, and later requests then route
     * to a client the caller never named — on a read-only one, every write
     * comes back 403.
     */
    private readonly options: { client?: string; baseUrl?: string } = {},
  ) {}

  /**
   * Fold a response into the wire state.
   *
   * Says nothing about what the change MEANS — whether a new session id is an
   * establishment or a replacement is a question about the session's lifetime,
   * which this has no way to answer and no business answering.
   */
  ingest(headers?: Record<string, unknown>): void {
    if (!headers) return;
    this.rememberAppServer(headers);

    const setCookie = headers['set-cookie'] as string[] | string | undefined;
    // Nothing was set, so nothing is folded in — not even the client, which is
    // an assertion ON the cookies a response brought rather than a cookie of
    // its own. Asserting it here would give a wire that has never been issued
    // anything a `Cookie` header to send, and the code above reads a non-empty
    // jar as "this connection holds something".
    if (!setCookie) return;
    for (const entry of Array.isArray(setCookie) ? setCookie : [setCookie]) {
      if (typeof entry !== 'string') continue;
      const [nameValue] = entry.split(';');
      if (!nameValue) continue;
      const [name, ...rest] = nameValue.split('=');
      const trimmed = name?.trim();
      if (!trimmed) continue;
      this.jar.set(trimmed, rest.join('=').trim());
    }

    if (this.options.client) {
      this.jar.set('sap-usercontext', `sap-client=${this.options.client}`);
    }

    if (this.jar.size === 0) return;
    const combined = Array.from(this.jar.entries())
      .map(([name, value]) => (value ? `${name}=${value}` : name))
      .join('; ');
    if (combined) this.combined = combined;
  }

  /** What to put on the `Cookie` header, or nothing if the jar is empty. */
  cookies(): string | null {
    return this.combined;
  }

  /**
   * Which ABAP session this wire is on.
   *
   * `SAP_SESSIONID` and nothing else: `sap-usercontext` is ours and does not
   * name a session, and a fingerprint that moved when it did would report a
   * replacement every time the client was re-asserted.
   */
  sessionFingerprint(): Map<string, string> {
    const fingerprint = new Map<string, string>();
    for (const [name, value] of this.jar) {
      if (name.startsWith('SAP_SESSIONID')) fingerprint.set(name, value);
    }
    return fingerprint;
  }

  /**
   * Headers that keep this connection on the server its session lives on.
   *
   * `sap-adt-saplb: fetch` asks the server to name itself — it answers on every
   * request, so the binding survives a restart that moves us. `saplb` is that
   * name sent back. `REDISPATCH_ON_SHUTDOWN` is what Eclipse asks for: if the
   * server is going down, send us elsewhere rather than fail.
   */
  affinityHeaders(): Record<string, string> {
    return {
      'sap-adt-saplb': 'fetch',
      ...(this.appServer
        ? { saplb: this.appServer, 'saplb-options': 'REDISPATCH_ON_SHUTDOWN' }
        : {}),
    };
  }

  /**
   * Earn a CSRF token, and with it the cookies that name the session.
   *
   * The token and the session are one thing on this wire: SAP binds a lock
   * handle to the `SAP_SESSIONID` the same exchange sets, so a token kept
   * across a new session would be presented against a session it was never
   * issued for.
   */
  async establish(context: IAdtEstablishContext): Promise<void> {
    // Idempotent. Asked again before a mutation, a wire that already holds a
    // token must not spend a round trip earning another — SAP binds the lock
    // handle to the session the token came with, so a second exchange would
    // move the session out from under a lock taken against the first.
    if (this.token) return;

    const base = context.baseUrl.endsWith('/')
      ? context.baseUrl.slice(0, -1)
      : context.baseUrl;
    const endpoints = [
      `${base}${CSRF_CONFIG.ENDPOINT}`,
      // BASIS < 7.52 has no /sap/bc/adt/core/discovery.
      `${base}${CSRF_CONFIG.FALLBACK_ENDPOINT}`,
    ];
    const retries = context.retries ?? CSRF_CONFIG.RETRY_COUNT;
    const delay = context.retryDelayMs ?? CSRF_CONFIG.RETRY_DELAY;

    let last: Error | undefined;
    for (const [index, url] of endpoints.entries()) {
      // The fallback exists for a system that HAS no
      // `/sap/bc/adt/core/discovery` — BASIS < 7.52 — which the server says by
      // answering 404 there. Trying it after a refused connection or a timeout
      // asks a host that is not answering to answer a different path, which
      // doubles the wait before the caller is told what is actually wrong.
      if (index > 0 && !absentEndpoint(last)) break;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          // Read per attempt: a provider may renew behind the call.
          const auth = await context.authHeaders();
          const response = await this.send({
            method: 'GET',
            url,
            headers: {
              ...auth,
              ...context.extraHeaders,
              ...CSRF_CONFIG.REQUIRED_HEADERS,
            },
            ...(context.timeoutMs !== undefined
              ? { timeout: context.timeoutMs }
              : {}),
          });

          // Handed up BEFORE the token is read: the cookies are the session,
          // and a fold that only happened on success would lose the session a
          // tokenless answer still opened.
          context.observe(response.headers);
          this.ingest(response.headers as Record<string, unknown>);

          const token = (response.headers as Record<string, unknown>)[
            'x-csrf-token'
          ] as string | undefined;
          if (token) {
            this.token = token;
            this.logger?.debug('CSRF token obtained');
            return;
          }
          last = new Error(CSRF_ERROR_MESSAGES.NOT_IN_HEADERS);
        } catch (error) {
          // Not a failed exchange: see `isFatal`. Leaves immediately, past the
          // retries and past the fallback endpoint.
          if (context.isFatal?.(error)) throw error;

          last = error instanceof Error ? error : new Error(String(error));
          const response = (
            error as { response?: { headers?: Record<string, unknown> } }
          ).response;
          if (response?.headers) {
            // A refusal can still carry the cookies that matter.
            context.observe(response.headers);
            this.ingest(response.headers);

            // …and the token itself. SAP answers 405 to a GET on some
            // endpoints and puts the token in the header anyway, and other
            // refusals carry one too. A retry would throw away a token the
            // server already handed over.
            const onError = response.headers['x-csrf-token'] as
              | string
              | undefined;
            if (onError) {
              this.token = onError;
              this.logger?.debug(
                'CSRF token arrived on a refusal, and is kept',
              );
              return;
            }
          }
        }
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    // The original error, with its `response`, when there was one: the
    // classification above this reads `error.response.status`, and a generic
    // replacement would tell it nothing.
    throw last ?? new Error(CSRF_ERROR_MESSAGES.NOT_IN_HEADERS);
  }

  /** The token this wire earned, or nothing if it has not earned one. */
  csrfToken(): string | null {
    return this.token;
  }

  adoptCsrfToken(token: string | null): void {
    this.token = token;
  }

  /** Drop everything the wire was holding. The socket outlives none of it. */
  forgetSession(): void {
    this.jar.clear();
    this.combined = null;
    this.appServer = null;
    // The token was issued INTO the session being dropped. Kept, it would be
    // presented against a session it was never bound to.
    this.token = null;
  }

  /**
   * Take the application server's name from a response, if it named one. Only
   * ever from the server's own answer — never guessed.
   */
  private rememberAppServer(headers: Record<string, unknown>): void {
    const key = Object.keys(headers).find(
      (k) => k.toLowerCase() === 'sap-adt-saplb',
    );
    const value = key ? headers[key] : undefined;
    if (typeof value === 'string' && value && value !== this.appServer) {
      this.appServer = value;
      this.logger?.debug(`Session is on application server ${value}`);
    }
  }

  /**
   * Everything this wire adds to a request of its own accord: the cookies it
   * holds, and the headers that keep it on the server its session lives on.
   *
   * Here rather than on the connection because they are HTTP's — a cookie jar
   * and a dispatcher to stay bound to — and a connection that threaded them
   * would be threading them for every wire, including one that has neither.
   *
   * MERGED with whatever the caller set: a SAML session IS the credential's
   * cookie, and replacing it would send the request out unauthenticated while
   * looking like it carried a session.
   */
  private dress(headers?: Record<string, string>): Record<string, string> {
    const dressed: Record<string, string> = {
      ...this.affinityHeaders(),
      ...headers,
    };
    const merged = mergeCookieHeaders(
      headers?.Cookie,
      this.combined ?? undefined,
    );
    if (merged) dressed.Cookie = merged;
    return dressed;
  }

  /** A path becomes an address; anything already absolute is left alone. */
  private address(url: string): string {
    if (!url.startsWith('/') || !this.options.baseUrl) return url;
    const base = this.options.baseUrl.endsWith('/')
      ? this.options.baseUrl.slice(0, -1)
      : this.options.baseUrl;
    return `${base}${url}`;
  }

  private client(): AxiosInstance {
    if (!this.instance) {
      // Kept as it was: an explicit opt-IN, so a misread env var cannot quietly
      // turn verification off.
      const rejectUnauthorized =
        process.env.NODE_TLS_REJECT_UNAUTHORIZED === '1' ||
        (process.env.TLS_REJECT_UNAUTHORIZED === '1' &&
          process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0');

      this.logger?.debug(
        `TLS configuration: rejectUnauthorized=${rejectUnauthorized}`,
      );

      this.instance = axios.create({
        httpsAgent: new Agent({
          rejectUnauthorized,
          ...this.agentOptions(),
        }),
      });
    }
    return this.instance;
  }

  /**
   * Throws for a status the request does not admit — by doing nothing, because
   * that is already what axios does, and `AxiosError` already carries
   * `response`. The contract was written to describe this behaviour rather than
   * to add it.
   */
  async send(request: IAdtTransportRequest): Promise<IAdtTransportResponse> {
    return this.dispatch(request, this.dress(request.headers));
  }

  /**
   * Send EXACTLY these headers, with nothing of the wire's live state mixed in.
   *
   * For a goodbye, and only for a goodbye. `disconnect()` dispatches the logoff
   * without awaiting it, so the request is still being assembled while the
   * connection is already free to `connect()` again — and by the time it goes
   * out, the jar can hold a different session. Dressing it then merges the LIVE
   * `SAP_SESSIONID` over the snapshot, and `mergeCookieHeaders` lets the later
   * value win on a repeated name, so the goodbye for the old session arrives
   * addressed to the new one and closes it.
   *
   * Reading the cookies synchronously is necessary and was not sufficient: the
   * snapshot survived only until the send path put the jar back on top of it.
   */
  protected async sendDetached(
    request: IAdtTransportRequest,
  ): Promise<IAdtTransportResponse> {
    return this.dispatch(request, { ...request.headers });
  }

  private async dispatch(
    request: IAdtTransportRequest,
    headers: Record<string, string>,
  ): Promise<IAdtTransportResponse> {
    const response = await this.client()({
      method: request.method,
      // The connection hands over a PATH; putting a server in front of it is
      // this wire's job. RFC's is to write the same path into the request line
      // as it stands — handed an absolute URL there, SADT_REST_RFC_ENDPOINT
      // dumps with STRING_OFFSET_TOO_LARGE. Neither can be done for both from
      // above, which is why addressing sits here.
      url: this.address(request.url),
      headers,
      ...(request.data !== undefined ? { data: request.data } : {}),
      ...(request.params !== undefined ? { params: request.params } : {}),
      ...(request.timeout !== undefined ? { timeout: request.timeout } : {}),
      ...(request.validateStatus !== undefined
        ? { validateStatus: request.validateStatus }
        : {}),
    });

    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      data: response.data,
    };
  }
}
