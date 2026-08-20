/**
 * How a connection proves who it is — passed in, not inherited.
 *
 * The class a consumer takes says which SYSTEM it is dialling; this says how it
 * authenticates there. The two are independent: a communication user against
 * ABAP Cloud and a bearer token against on-prem are both ordinary, and a design
 * where the credential picks the system's session mechanism gets one of them
 * wrong whichever way it guesses.
 *
 * Deliberately not "give me a token". Four of the five ways in are not tokens:
 * basic is a header built from a username, a certificate is TLS material and no
 * header at all, and SPNEGO is a negotiation with the server. What every one of
 * them has in common is small, and it is this.
 *
 * `establishSession()` is NOT here. Measured across all five implementations it
 * is the same work — fetch a CSRF token from `/sap/bc/adt/discovery`, keep it,
 * tolerate a failure — with the only difference being a step before it, which is
 * `prepare()`.
 */

import type { AgentOptions } from 'node:https';

export interface IAuthProvider {
  /** For logs, so which credential ran is never inferred from behaviour. */
  readonly kind: string;

  /**
   * Get ready before anything is sent: load key material, unlock a store.
   * Called once per establishment, before the first request.
   *
   * Not for tokens. A stateful token provider caches and renews on its own, so
   * asking it IS the preparation — and holding what it returned would hide the
   * renewal it exists to do.
   *
   * Optional because most credentials are ready as constructed. A credential
   * that throws here fails the connect, which is correct — it has nothing to
   * authenticate with.
   */
  prepare?(): Promise<void>;

  /**
   * The `Authorization` header value, or `''` when this credential is not a
   * header — a certificate authenticates through TLS and has none.
   *
   * **Asked per request, and asynchronous, because the answer can change.** A
   * token provider checks expiry and renews behind this call; anything cached
   * on this side would serve the stale token and defeat it. Cheap in the
   * ordinary case for the same reason: the provider holds the token and only
   * goes to the network when it has expired.
   */
  authorizationHeader(): Promise<string>;

  /**
   * Cookies this credential authenticates with, for the ways in where the
   * session was negotiated elsewhere and handed over — SAML is one.
   *
   * Part of the contract rather than a method a provider happens to have: the
   * first version left it off, so `SamlAuthProvider` held the cookies, nothing
   * ever asked for them, and the recommended replacement authenticated with
   * nothing at all.
   */
  cookies?(): string;

  /**
   * TLS options for credentials that live in the transport rather than in a
   * header. Omitted by everything else.
   */
  httpsAgentOptions?(): AgentOptions;

  /**
   * Fetch the CSRF token this credential's own way.
   *
   * Only SPNEGO needs it: its token is consumed by one request and the exchange
   * is the fetch. Everything else leaves it out and gets the shared path.
   */
  fetchCsrfToken?(url: string): Promise<string>;
}
