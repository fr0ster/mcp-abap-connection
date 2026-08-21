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

export interface IAdtTransport {
  /** For logs, so which transport ran is never inferred from behaviour. */
  readonly kind: string;

  /**
   * Issue one request.
   *
   * Throws for a status `validateStatus` does not admit, carrying `response`
   * on the error — that is the shape the request path classifies against, and
   * a transport that resolved instead would turn a 401 into a success with a
   * logon page in the body.
   */
  send(request: IAdtTransportRequest): Promise<IAdtTransportResponse>;
}
