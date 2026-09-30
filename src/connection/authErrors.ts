/**
 * What the connection raises when the credential says no, and the mark a wire
 * puts on a failure that is a refused logon.
 */

import type { AuthOutcome, IAuthRefusal } from '@mcp-abap-adt/interfaces-auth';

/** When in the connection's life the credential refused. */
export type AuthRefusalMoment = 'prepare' | 'logon' | 'request';

/**
 * The credential said no, or the system refused it and the provider's answer
 * is final.
 *
 * `refusal` is the provider's own words; `cause` keeps the wire's error as it
 * arrived, so a network failure stays visible even when a provider words it as
 * a credential problem.
 */
export class AuthRefusedError extends Error {
  readonly refusal: IAuthRefusal;
  readonly at: AuthRefusalMoment;
  override readonly cause?: unknown;

  constructor(refusal: IAuthRefusal, at: AuthRefusalMoment, cause?: unknown) {
    super(
      refusal.hint ? `${refusal.reason} — ${refusal.hint}` : refusal.reason,
    );
    this.name = 'AuthRefusedError';
    this.refusal = refusal;
    this.at = at;
    this.cause = cause;
  }
}

/**
 * A wire's mark: this failure is a refused logon. It decides nothing — what to
 * do about it is the provider's answer, not the wire's.
 *
 * Exported so a consumer's own wire can say the same thing. `cause` is the raw
 * error, the same object, never re-wrapped.
 */
export class WireLogonError extends Error {
  readonly status?: number;
  override readonly cause: unknown;

  constructor(cause: unknown, status?: number) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'WireLogonError';
    this.cause = cause;
    this.status = status;
  }
}

/** A provider threw instead of answering: a bug in the provider, not an answer. */
export const PROVIDER_FAILED: IAuthRefusal = {
  reason: 'the credential provider failed',
};

/**
 * The provider said Ok to a rejection and the retry was refused too. The one
 * refusal the connection words itself, because the provider's last word was Ok.
 */
export const REFUSED_AGAIN: IAuthRefusal = {
  reason: 'the credential was refused again after the provider renewed it',
};

/** A connection built without a credential has nothing to renew. */
export const NO_CREDENTIAL_TO_RENEW: IAuthRefusal = {
  reason: 'this connection has no credential to renew',
};

/**
 * Run one provider call so that a throw is an answer too.
 *
 * A consumer's provider may be buggy; the connection must not let that surface
 * as an unhandled rejection. The throw is kept beside the outcome, to become
 * the cause of whatever the caller then raises.
 */
export async function guarded(
  call: () => Promise<AuthOutcome>,
): Promise<{ outcome: AuthOutcome; thrown?: unknown }> {
  try {
    return { outcome: await call() };
  } catch (thrown) {
    return { outcome: { ok: false, refusal: PROVIDER_FAILED }, thrown };
  }
}
