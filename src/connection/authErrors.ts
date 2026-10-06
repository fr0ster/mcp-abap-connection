/**
 * What the connection raises when the credential says no, and the mark a wire
 * puts on a failure that is a refused logon.
 */

import { authError, classifyOutcome } from '@mcp-abap-adt/auth-errors';
import type { AuthOutcome, IAuthRefusal } from '@mcp-abap-adt/interfaces-auth';

/** When in the connection's life the credential refused. */
export type AuthRefusalMoment = 'prepare' | 'logon' | 'request';

/**
 * The credential said no, or the system refused it and the provider's answer
 * is final.
 *
 * `refusal` is the provider's error as `@mcp-abap-adt/auth-errors` minted it
 * (or the connection's own), classified on the way in: a refusal that is not
 * this copy's minted error is rebuilt from its kind and facts, or else is
 * `provider-threw` — decide on its `kind` and `facts`; the message is its
 * `reason — hint`. `cause` keeps the wire's error as it arrived, so a network failure stays visible even when a provider words it as
 * a credential problem — unless the provider threw instead of answering, when
 * it is that throw.
 */
export class AuthRefusedError extends Error {
  readonly refusal: IAuthRefusal;
  readonly at: AuthRefusalMoment;
  override readonly cause?: unknown;

  constructor(refusal: IAuthRefusal, at: AuthRefusalMoment, cause?: unknown) {
    const checked = checkedRefusal(refusal, at);
    super(
      checked.hint ? `${checked.reason} — ${checked.hint}` : checked.reason,
    );
    this.name = 'AuthRefusedError';
    this.refusal = checked;
    this.at = at;
    this.cause = cause;
  }
}

/**
 * The refusal an `AuthRefusedError` carries, never the object as given unread:
 * anyone may build one — over a `structuredClone`, say — and its words reach
 * the message. A refusal this copy of `auth-errors` minted is kept as the same
 * object; one that rebuilds from its kind and facts (a clone, another copy's)
 * is rebuilt, its words rendered anew and its diagnostics dropped; anything
 * else is `provider-threw` at the moment.
 */
function checkedRefusal(
  refusal: IAuthRefusal,
  at: AuthRefusalMoment,
): IAuthRefusal {
  const fallback = providerFailed(at);
  const outcome = classifyOutcome({ ok: false, refusal }, fallback);
  return outcome.ok ? fallback : outcome.refusal;
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

/**
 * A provider threw instead of answering, or answered something that is not an
 * outcome: a bug in the provider, not an answer.
 */
export function providerFailed(at: AuthRefusalMoment): IAuthRefusal {
  return authError.connection({ problem: 'provider-threw', at });
}

/**
 * The provider said Ok to a rejection and the retry was refused too. The one
 * refusal the connection words itself, because the provider's last word was Ok.
 */
export function refusedAgain(at: AuthRefusalMoment): IAuthRefusal {
  return authError.connection({ problem: 'refused-after-renewal', at });
}

/** A connection built without a credential has nothing to renew. */
export const NO_CREDENTIAL_TO_RENEW: IAuthRefusal = authError.connection({
  problem: 'no-credential',
});

/**
 * A provider's answer, and what it threw when the answer is a throw. `thrown`
 * is present only then, so a provider that threw `undefined` is still told
 * apart from one that answered.
 */
export interface GuardedAnswer {
  outcome: AuthOutcome;
  thrown?: unknown;
}

/**
 * Run one provider call so that a throw is an answer too, and so that what
 * the provider answered is an outcome the connection can trust.
 *
 * A consumer's provider may be buggy; the connection must not let that surface
 * as an unhandled rejection. The throw is kept beside the outcome, to become
 * the cause of whatever the caller then raises.
 *
 * A provider written in JavaScript can answer any object, and an
 * `AuthRefusedError` built from it would carry its free text. So every answer
 * goes through `classifyOutcome`: a refusal minted by this copy of
 * `auth-errors` passes as the same object, another copy's is rebuilt from its
 * kind and facts, and anything else is `provider-threw` at `at`.
 */
export async function guarded(
  call: () => Promise<AuthOutcome>,
  at: AuthRefusalMoment,
): Promise<GuardedAnswer> {
  const fallback = providerFailed(at);
  try {
    return { outcome: classifyOutcome(await call(), fallback) };
  } catch (thrown) {
    return { outcome: { ok: false, refusal: fallback }, thrown };
  }
}
