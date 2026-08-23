/**
 * What carries an ADT request to the server.
 *
 * The credential says how a request proves who it is; this says what the
 * request travels over. They are independent axes, and on-prem is where both
 * are real choices: the same ADT REST call goes over HTTP, or over RFC to
 * `SADT_REST_RFC_ENDPOINT` — the FM Eclipse ADT itself uses through JCo — on a
 * system where stateful HTTP sessions are not usable. ABAP Cloud has one
 * transport, so its connector takes no such parameter.
 *
 * **Said by the caller, never sniffed.** Which transport is in use is a fact
 * about the deployment, not something to be discovered by trying one and
 * watching it fail — the same rule `SessionStrategy` states for session
 * mechanics.
 */

/** One request, in the terms every transport can honour. */
export interface IAdtTransportRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: unknown;
  /**
   * Query parameters, unserialised.
   *
   * Part of the request rather than folded into `url` by the caller, because
   * the two transports carry them differently: HTTP hands them to a client
   * that serialises them, RFC has no such step and must write them into the
   * URI itself. A transport that ignored them would send the request without
   * its query — silently, and only on one of the two wires.
   */
  params?: Record<string, unknown>;
  /** Milliseconds; absent means the transport's own default. */
  timeout?: number;
  /**
   * Which statuses resolve rather than throw. Absent means the default: 2xx
   * resolves, everything else throws — which the retry and 401 handling above
   * this seam is written against.
   */
  validateStatus?: (status: number) => boolean;
}

/** What came back, in the terms every transport can produce. */
export interface IAdtTransportResponse {
  status: number;
  statusText?: string;
  /**
   * Deliberately `unknown`: a transport names its own header container, and a
   * caller narrows what it needs. HTTP has axios's, RFC builds one out of
   * `HEADER_FIELDS`.
   */
  headers: unknown;
  data: unknown;
}

/** What a transport needs from above to establish itself. */
/**
 * What a wire needs from the connection to ask for a session, or give one back.
 *
 * The same shape the establishing call takes, minus the retry knobs: opening a
 * session is one request, and one that is retried is one the caller cannot
 * reason about — a second session may already be open by the time the first
 * answer arrives.
 */
export interface IAdtSessionContext {
  /** The server, for a wire that addresses one. */
  baseUrl: string;
  /** Read once per request: a provider may renew behind the call. */
  authHeaders: () => Promise<Record<string, string>>;
  /** Anything the conversation carries — the ADT connection id, today. */
  extraHeaders?: Record<string, string>;
  /** Where to hand each answer, so the connection sees what the wire saw. */
  observe: (headers: unknown) => void;
}

export interface IAdtEstablishContext extends IAdtSessionContext {
  /**
   * Where to hand each answer. The wire folds a response into its own state;
   * whether a new session id is an establishment or a replacement is a question
   * about the session's lifetime, which is decided above.
   */
  observe: (headers: unknown) => void;
  /** How many times to ask again. Absent means the transport's own default. */
  retries?: number;
  /** Milliseconds between attempts. Absent means the transport's own default. */
  retryDelayMs?: number;
  /** Milliseconds per attempt. Absent means the transport's own default. */
  timeoutMs?: number;
  /**
   * Which failures must not be retried.
   *
   * A verdict about the session — "the one we were on is gone" — is not a
   * failed exchange: retrying would observe the SAME new session, read it as
   * unchanged, and lose the replacement for good. The wire cannot tell those
   * apart, so it asks.
   */
  isFatal?: (error: unknown) => boolean;
}

export interface IAdtTransport {
  /** For logs, so which transport ran is never inferred from behaviour. */
  readonly kind: string;

  /**
   * Get a session, in whatever way this wire has one.
   *
   * An RFC conversation is opened, and IS the session. ABAP Cloud publishes a
   * session as a resource and this asks for one. On-prem HTTP has neither — its
   * session arrives as a cookie on the establishing call — so its
   * implementation is empty.
   *
   * **Required, not optional.** A wire with nothing to open writes an empty
   * method, which is true of it; the alternative was the connection asking
   * `open?.()` at every teardown — a runtime question about a collaborator it
   * was handed, which is the thing a contract exists to answer instead.
   *
   * This used to be a `SessionStrategy` the connection selected and drove: a
   * second wire abstraction beside this one, in the class every wire shares,
   * describing a mechanism only some of them have.
   */
  open(context: IAdtSessionContext): Promise<void>;

  /**
   * Give the session back.
   *
   * Never throws, and a repeat call finds nothing owed — this is reached from
   * `disconnect()`, which promises to settle. What it does is the wire's: a
   * DELETE on the address the server published, the platform's logoff, or
   * closing the conversation.
   */
  close(context: IAdtSessionContext): Promise<void>;

  /**
   * Issue one request.
   *
   * Throws for a status `validateStatus` does not admit, carrying `response`
   * on the error — that is the shape the request path classifies against, and
   * a transport that resolved instead would turn a 401 into a success with a
   * logon page in the body.
   */
  send(request: IAdtTransportRequest): Promise<IAdtTransportResponse>;

  /**
   * Fold a response into whatever state this wire keeps.
   *
   * Every transport answers, because every transport has an answer — HTTP
   * keeps a cookie jar and the application server it was told about, RFC keeps
   * nothing because its conversation carries the session itself. What the
   * change MEANS is not asked here: whether a new session id is an
   * establishment or a replacement is a question about the session's lifetime,
   * and it is answered above.
   */
  ingest(headers?: Record<string, unknown>): void;

  /** What to put on the `Cookie` header, or `null` for a wire that has none. */
  cookies(): string | null;

  /**
   * Which session this wire is on, as something comparable.
   *
   * Empty means "this wire is on no session" — which for HTTP is a system that
   * issued no `SAP_SESSIONID`, and for RFC never happens while the
   * conversation is open, because the conversation IS the session.
   */
  sessionFingerprint(): Map<string, string>;

  /** Headers that keep this connection on the server its session lives on. */
  affinityHeaders(): Record<string, string>;

  /**
   * Get this wire ready to carry a mutation.
   *
   * HTTP earns a CSRF token, and the cookies that name the session arrive with
   * it. RFC has nothing to earn: the conversation was opened before this and IS
   * the session, and `SADT_REST_RFC_ENDPOINT` returns neither a token nor a
   * cookie however it is asked — so a shared implementation could only be one
   * that fails on one of the two wires, which is what it did.
   *
   * The context is what the wire cannot know: which server, which credential,
   * and where to hand the answer so the session lifetime above can fence and
   * classify it.
   */
  establish(context: IAdtEstablishContext): Promise<void>;

  /** The CSRF token this wire holds, or `null` for a wire that has none. */
  csrfToken(): string | null;

  /**
   * Take a token earned elsewhere.
   *
   * A SAML credential does the exchange itself — the session cookie it earns is
   * the point of it — and the token still has to reach the wire that will
   * present it. `null` drops one without dropping the session around it.
   */
  adoptCsrfToken(token: string | null): void;

  /** Drop the session state this wire was holding. */
  forgetSession(): void;
}

/**
 * The response a refusal carries, whichever client threw it.
 *
 * `IAdtTransport` promises exactly this about a failure and nothing more: the
 * error has a `response`. `HttpTransport` throws an `AxiosError`, which happens
 * to satisfy it; `RfcTransport` throws a plain `Error` with the field, which is
 * what the contract asks for.
 *
 * Read structurally, because `instanceof AxiosError` is a question about which
 * HTTP client is installed — an answer no other wire can give, and the reason
 * observing a failing response, and noticing a dead session in one, were
 * reachable over one wire only.
 */
/**
 * Which system a wire is for.
 *
 * A marker rather than a class, because a consumer writes their own transports
 * — that is the whole reason the wire is an argument. Constraining a connector
 * to the shipped classes would have made "bring your own wire" impossible while
 * appearing to allow it, since these classes carry private state and so compare
 * nominally.
 *
 * It is still the CALLER who says which system: declaring `system` is that
 * statement, made once by whoever writes the transport rather than at every
 * construction. Nothing reads it at runtime and nothing infers from it — its
 * only job is to stop "ABAP Cloud over RFC" from compiling.
 */
export interface IOnPremTransport extends IAdtTransport {
  readonly system: 'onprem';
}

export interface ICloudTransport extends IAdtTransport {
  readonly system: 'cloud';
}

export function refusalOf(error: unknown): IAdtTransportResponse | null {
  const response = (error as { response?: unknown } | null | undefined)
    ?.response;
  if (!response || typeof response !== 'object') return null;
  const candidate = response as { status?: unknown };
  return typeof candidate.status === 'number'
    ? (response as IAdtTransportResponse)
    : null;
}
