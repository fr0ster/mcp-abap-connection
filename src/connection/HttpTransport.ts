/**
 * An ADT request carried over HTTP.
 *
 * The obvious one, and until now the one that did not exist as a thing: RFC was
 * an object while HTTP was a branch inside `getAxiosInstance()`. An axis with a
 * code path on one end cannot be named in a type — a default type parameter has
 * nothing to point at — so this is what makes the two ends symmetrical.
 *
 * Nothing to open or give back at this level. A request opens its own socket
 * and there is no conversation to establish; `open()` only offers the
 * credential its logon, and the subclasses add the session mechanism.
 *
 * **Where the two axes touch.** TLS client-certificate material comes from the
 * CREDENTIAL — a certificate authenticates through the transport rather than
 * through a header. The provider presents it at the logon (`logonTarget()`);
 * the client is built lazily from it on the first request, over the
 * constructor's `agentOptions` (`ca`, `rejectUnauthorized` — settings that are
 * not the credential). Material that changes between logons drops the client;
 * the cookie jar and the CSRF token are the session's and stay.
 */

import { Agent, type AgentOptions } from 'node:https';
import type {
  AuthOutcome,
  ICertificateMaterial,
  ILogonTarget,
} from '@mcp-abap-adt/interfaces-auth';
import axios, { type AxiosInstance } from 'axios';
import type { ILogger } from '../logger.js';
import { mergeCookieHeaders } from '../utils/cookies.js';
import { AuthRefusedError, WireLogonError } from './authErrors.js';
import { CSRF_CONFIG, CSRF_ERROR_MESSAGES } from './csrfConfig.js';
import {
  type IAdtEstablishContext,
  type IAdtSessionContext,
  type IAdtTransport,
  type IAdtTransportRequest,
  type IAdtTransportResponse,
  refusalOf,
} from './IAdtTransport.js';
import { isStatefulRequest, SESSION_TYPE_HEADER } from './statefulRequest.js';

/** The cookie that names a stateful ABAP context. */
const CONTEXT_COOKIE = 'sap-contextid';

/**
 * A `Cookie` header without `sap-contextid`, for a request that is not stateful.
 *
 * `sap-contextid` names the stateful ABAP context a `LOCK` opened, and SAP
 * routes any request carrying it into that context — header or no header. So
 * a "stateless" request that carried it was not stateless: it ran in the
 * lock's context. Measured on E19 (BASIS 816) and E98 (BASIS 756), 2026-09-27,
 * one connection, a package locked, written and unlocked twice:
 *
 * - E19: the second `PUT` answered 400 PAK/058 "Package … is already locked" —
 *   the first write's save was still in that context's `CL_PACKAGE` buffer;
 * - E98: every `PUT` answered 423 "Resource … is not locked (invalid lock
 *   handle)".
 *
 * Without the cookie on the non-stateful requests, both systems wrote twice
 * and deleted on the same connection. Eclipse ADT does the same thing its
 * own way: its trace shows one stateful session for `LOCK` and `UNLOCK`
 * alone, and every other request — the `PUT` included — in a session of its
 * own.
 *
 * The jar itself keeps the cookie: the stateful requests that follow, the
 * `UNLOCK` above all, still need to reach the context that holds the lock.
 */
function withoutContextCookie(cookie: string | undefined): string | undefined {
  if (!cookie) return cookie;
  const kept = cookie
    .split(/;\s*/)
    .filter((pair) => pair && pair.split('=')[0]?.trim() !== CONTEXT_COOKIE)
    .join('; ');
  return kept || undefined;
}

// The one verdict every wire takes; re-exported for the wires built on this one.
export { isStatefulRequest } from './statefulRequest.js';

/** A 404 there means the system has no such endpoint, not that it is unwell. */
function absentEndpoint(error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | undefined)
    ?.response?.status;
  return status === 404 || status === 501;
}

const MATERIAL_FIELDS = ['cert', 'key', 'pfx', 'passphrase'] as const;

/**
 * The material fields a provider offered, and nothing else: a key outside
 * them (`ca`, `rejectUnauthorized`) belongs to `agentOptions`, and a field
 * offered as `undefined` was not offered.
 */
function materialOf(offered: ICertificateMaterial): ICertificateMaterial {
  const taken: ICertificateMaterial = {};
  for (const field of MATERIAL_FIELDS) {
    const value = offered[field];
    if (value !== undefined) Object.assign(taken, { [field]: value });
  }
  return taken;
}

/** Material is the same when every field holds the same value, buffers by bytes. */
function sameMaterial(
  a: ICertificateMaterial | null,
  b: ICertificateMaterial,
): boolean {
  if (!a) return Object.keys(b).length === 0;
  return MATERIAL_FIELDS.every((field) => {
    const left = a[field];
    const right = b[field];
    if (left === right) return true;
    if (left === undefined || right === undefined) return false;
    return Buffer.from(left).equals(Buffer.from(right));
  });
}

/**
 * Whether the server certificate is verified: yes, as Node does, unless told
 * otherwise in so many words.
 *
 * `agentOptions.rejectUnauthorized`, when the caller set it, decides — it is
 * the caller's own code. Otherwise `TLS_REJECT_UNAUTHORIZED=0` or
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` turns verification off, and nothing else
 * does: unset, `1` and a typo (`false`, `no`) all verify, so a misread
 * variable fails closed. A self-signed system is trusted with
 * `agentOptions.ca`, not by turning verification off.
 */
function verifiesServerCertificate(options: AgentOptions): boolean {
  if (typeof options.rejectUnauthorized === 'boolean') {
    return options.rejectUnauthorized;
  }
  return !(
    process.env.TLS_REJECT_UNAUTHORIZED === '0' ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
  );
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
   * The TLS material the last logon offered. The client is built from it, and
   * a logon offering different material drops the client — never the jar.
   */
  private material: ICertificateMaterial | null = null;

  /** Whether this wire has said that it does not verify the server certificate. */
  private saidUnverified = false;

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
     * The SAP client (mandant) every request on this wire addresses, from the
     * first one on: the establishing call is where the session and its CSRF
     * token are issued, so a client applied any later is applied to a session
     * that already lives in another one. See `clientHeaders()`.
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

    // SAP answers `sap-usercontext` with the system default rather than the
    // client that was asked for; folded in as it came, later requests would
    // route to a client the caller never named — on a read-only one, every
    // write comes back 403.
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
   * A session exists when the server named one.
   *
   * `SAP_SESSIONID` is what a lock is bound to, so its absence means there is
   * nothing to hold one — the connection can read and can keep nothing.
   */
  sessionEstablished(): boolean {
    return this.sessionFingerprint().size > 0;
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
   * The client, said the way ABAP hears it: the `sap-client` header.
   *
   * ICF takes the client from the `sap-client` header or query parameter, or
   * from the `sap-usercontext` cookie — and NOT from `X-SAP-Client`, which it
   * ignores. Measured against an on-prem system (client 100 the default),
   * plain curl with basic auth on `/sap/bc/adt/core/discovery`:
   * `X-SAP-Client: 999` answers 200 from client 100, `sap-client: 999` answers
   * 401. Before this, the client reached the system only through the cookie,
   * which the wire holds from the first response on — so the first request,
   * the one that opens the session and earns the CSRF token, always landed in
   * the default client, and a wrong client failed one request late.
   *
   * The header rather than the query parameter: it addresses the client
   * without rewriting a URL the caller built, and it rides on the detached
   * goodbye the same way it rides on everything else.
   */
  protected clientHeaders(): Record<string, string> {
    return this.options.client ? { 'sap-client': this.options.client } : {};
  }

  /**
   * The `sap-usercontext` cookie the client is asserted with, from the first
   * request on — before any response could have set one.
   *
   * Added when a request is dressed rather than put in the jar: the jar is
   * what the server issued, and a jar that held something before the first
   * answer would read as a connection that holds a session.
   */
  private clientCookie(): string | undefined {
    return this.options.client
      ? `sap-usercontext=sap-client=${this.options.client}`
      : undefined;
  }

  /**
   * What this wire says about the session it is already in, on every request.
   *
   * Empty here, because it is not the same on every wire: a cloud session is a
   * resource that has to be named, an on-prem one arrives with the logon, and
   * an RFC conversation has no such notion at all. A wire that has something to
   * say overrides this.
   */
  protected sessionHeaders(): Record<string, string> {
    return {};
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
          // Authorized per attempt: a provider may renew behind the call.
          const auth: Record<string, string> = {};
          await context.authorize(auth);
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
          // tokenless answer still opened. And before the fold: an answer the
          // connection refuses as a gone session's throws here, and nothing
          // of it reaches the jar.
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
          // retries and past the fallback endpoint. So does the provider's
          // refusal to authorize: it is its word, and asking again only asks
          // it again.
          if (error instanceof AuthRefusedError || context.isFatal?.(error)) {
            throw error;
          }

          last = error instanceof Error ? error : new Error(String(error));
          const response = (
            error as { response?: { headers?: Record<string, unknown> } }
          ).response;
          if (response?.headers) {
            // A refusal can still carry the cookies that matter — handed up
            // first, so one the connection refuses is not folded in.
            context.observe(response.headers);
            this.ingest(response.headers);
          }

          // A refused logon, named as one — after its cookies are in, and
          // without a retry: asking again with the credential just refused
          // tells the system nothing new. What to do about it is not the
          // wire's to decide.
          if (refusalOf(error)?.status === 401) {
            throw new WireLogonError(error, 401);
          }

          if (response?.headers) {
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
  private dress(request: IAdtTransportRequest): Record<string, string> {
    this.refuseAnotherClient(request);
    const headers = request.headers;
    const stateful = isStatefulRequest(request);
    const dressed: Record<string, string> = {
      ...this.affinityHeaders(),
      ...this.sessionHeaders(),
      ...(stateful ? this.sessionTypeHeaders() : {}),
      ...headers,
    };
    // The caller's spelling of the client goes; the wire's goes in last. It is
    // the same value — refuseAnotherClient saw to that — said once.
    for (const name of Object.keys(dressed)) {
      if (name.toLowerCase() === 'sap-client') delete dressed[name];
    }
    Object.assign(dressed, this.clientHeaders());
    // Whatever the caller spelled the header as: HTTP does not tell `Cookie`
    // from `cookie`, and a lowercase one spread in above would bypass the
    // filter below.
    let callerCookie: string | undefined;
    for (const name of Object.keys(dressed)) {
      if (name.toLowerCase() !== 'cookie') continue;
      callerCookie = mergeCookieHeaders(callerCookie, dressed[name]);
      delete dressed[name];
    }
    // The client cookie last, so it wins: on the first request it is the only
    // thing that names the client, and later the jar already holds the same
    // value.
    const merged = mergeCookieHeaders(
      mergeCookieHeaders(callerCookie, this.combined ?? undefined),
      this.clientCookie(),
    );
    // Filtered on the merged header, not only on the jar: a caller's own
    // `Cookie` can carry the context too — the connection's CSRF and 401
    // retries put the whole jar there — and a non-stateful request must not
    // reach the context whichever way the cookie arrived.
    const cookie = stateful ? merged : withoutContextCookie(merged);
    if (cookie) dressed.Cookie = cookie;
    else delete dressed.Cookie;
    return dressed;
  }

  /**
   * How this wire asks for the stateful session: `x-sap-adt-sessiontype:
   * stateful`, as Eclipse sends on its `LOCK` and `UNLOCK` over HTTP. A wire
   * whose system is hurt by the header overrides this (BASIS 7.40, see
   * `LegacyOnPremHttpTransport`).
   */
  protected sessionTypeHeaders(): Record<string, string> {
    return { [SESSION_TYPE_HEADER]: 'stateful' };
  }

  /**
   * The client belongs to the connection. Another client is another logon —
   * its own user and password, its own session and CSRF token — so a caller
   * that names one in a `sap-client` header, query string or `params` entry, in
   * any case, or in a `sap-usercontext` cookie, is refused before anything is sent: sending it would land the request in
   * that client with the session and credential of this one. Naming the
   * connection's own client is harmless and passes.
   */
  private refuseAnotherClient(request: IAdtTransportRequest): void {
    const own = this.options.client || undefined;
    const named: string[] = [];
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      if (name.toLowerCase() === 'sap-client') named.push(String(value));
    }
    const url = request.url ?? '';
    const query = url.indexOf('?');
    if (query !== -1) {
      const params = new URLSearchParams(url.slice(query + 1));
      for (const [name, value] of params) {
        if (name.toLowerCase() === 'sap-client') named.push(value);
      }
    }
    // The structured parameters too: axios serialises them into the same query
    // string. A list is several values, each of which must be the client.
    for (const [name, value] of Object.entries(request.params ?? {})) {
      if (name.toLowerCase() !== 'sap-client' || value === undefined) continue;
      for (const each of Array.isArray(value) ? value : [value]) {
        named.push(String(each));
      }
    }
    // And the cookie ICF also reads: `sap-usercontext=sap-client=<n>` in a
    // caller's `Cookie`. The connection's own CSRF and 401 retries put the
    // whole jar there, so a wire given no client admits the client its jar
    // holds — the one the system answered with — and nothing else.
    const cookieOwn = own ?? this.jarClient();
    const cookieNamed: string[] = [];
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      if (name.toLowerCase() !== 'cookie') continue;
      for (const pair of String(value).split(';')) {
        const [cookieName, ...rest] = pair.split('=');
        if (cookieName?.trim().toLowerCase() !== 'sap-usercontext') continue;
        for (const [key, client] of new URLSearchParams(
          rest.join('=').trim(),
        )) {
          if (key.toLowerCase() === 'sap-client') cookieNamed.push(client);
        }
      }
    }
    for (const client of cookieNamed) {
      if (client === cookieOwn) continue;
      throw new Error(
        `the request names client ${client}, but the connection is ${
          own ? `for client ${own}` : 'given no client'
        }: the client belongs to the connection — another client is another connection, with its own credential`,
      );
    }
    for (const client of named) {
      if (client === own) continue;
      throw new Error(
        `the request names client ${client}, but the connection is ${
          own ? `for client ${own}` : 'given no client'
        }: the client belongs to the connection — another client is another connection, with its own credential`,
      );
    }
  }

  /** The client the jar's `sap-usercontext` names, as the system set it. */
  private jarClient(): string | undefined {
    const context = this.jar.get('sap-usercontext');
    if (context === undefined) return undefined;
    for (const [key, client] of new URLSearchParams(context)) {
      if (key.toLowerCase() === 'sap-client') return client;
    }
    return undefined;
  }

  /** A path becomes an address; anything already absolute is left alone. */
  private address(url: string): string {
    if (!url.startsWith('/') || !this.options.baseUrl) return url;
    const base = this.options.baseUrl.endsWith('/')
      ? this.options.baseUrl.slice(0, -1)
      : this.options.baseUrl;
    return `${base}${url}`;
  }

  /**
   * What this wire says to a provider at a logon.
   *
   * TLS material is taken: the client is built from it, over `agentOptions`,
   * and material that differs by value from the last logon's drops the client
   * so the next request builds a new agent. Logon parameters belong to the RFC
   * wire; a provider that needs them is told so and decides what that means.
   */
  protected logonTarget(): ILogonTarget {
    return {
      tlsMaterial: (offered): AuthOutcome => {
        const material = materialOf(offered);
        if (!sameMaterial(this.material, material)) {
          this.instance = null;
        }
        this.material = material;
        return { ok: true };
      },
      logonParameters: (): AuthOutcome => ({
        ok: false,
        refusal: { reason: 'this wire takes no logon parameters (HTTP)' },
      }),
    };
  }

  private client(): AxiosInstance {
    if (!this.instance) {
      const options = this.agentOptions();
      const rejectUnauthorized = verifiesServerCertificate(options);

      if (!rejectUnauthorized && !this.saidUnverified) {
        this.saidUnverified = true;
        this.logger?.debug(
          'TLS: the server certificate is not verified (explicit opt-out)',
        );
      }

      this.instance = axios.create({
        httpsAgent: new Agent({
          ...options,
          rejectUnauthorized,
          ...this.material,
        }),
      });
    }
    return this.instance;
  }

  /**
   * The logon, and nothing else to ask for: an HTTP session arrives with the
   * establishing call.
   *
   * The credential is offered the logon here, before any request — a cloud
   * preflight included. "There is no session resource here" is a fact about
   * this wire, and a fact is stated, not left for a caller to discover.
   */
  async open(context: IAdtSessionContext): Promise<void> {
    await context.logon(this.logonTarget());
  }

  /**
   * Nothing to give back at this level.
   *
   * The two concrete wires override it — the cloud one DELETEs the session
   * resource, the on-prem one sends the platform logoff. A bare HTTP wire has
   * neither, and says so by doing nothing.
   */
  async close(_context: IAdtSessionContext): Promise<void> {}

  /**
   * Throws for a status the request does not admit — by doing nothing, because
   * that is already what axios does, and `AxiosError` already carries
   * `response`. The contract was written to describe this behaviour rather than
   * to add it.
   */
  async send(request: IAdtTransportRequest): Promise<IAdtTransportResponse> {
    return this.dispatch(request, this.dress(request));
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
