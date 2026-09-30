/**
 * A scriptable 3.0 provider that records every call.
 *
 * For tests whose subject is what the connection does with a provider's
 * answers. `authorize` writes `Authorization: Stub <n>`, where `n` counts the
 * Ok answers `rejected` has given — so a test can see whether a request
 * carried the renewed credential. Each answer list is played in order and its
 * last entry repeats; an entry that is a function is called (and may throw).
 */
import type {
  AuthOutcome,
  IAuthProvider,
  IAuthRejection,
  ILogonTarget,
  IRequestTarget,
} from '@mcp-abap-adt/interfaces-auth';

type Answer<A extends unknown[]> = AuthOutcome | ((...args: A) => AuthOutcome);

export interface StubScript {
  kind?: string;
  prepare?: Answer<[]>[];
  establish?: Answer<[ILogonTarget]>[];
  authorize?: Answer<[IRequestTarget]>[];
  rejected?: Answer<[IAuthRejection]>[];
}

export interface StubCall {
  method: 'prepare' | 'establish' | 'authorize' | 'rejected';
  argument?: unknown;
}

const OK: AuthOutcome = { ok: true };

export function stubProvider(
  script: StubScript = {},
): IAuthProvider & { calls: StubCall[]; renewals: () => number } {
  const calls: StubCall[] = [];
  const positions = { prepare: 0, establish: 0, authorize: 0, rejected: 0 };
  let renewals = 0;

  function next<A extends unknown[]>(
    method: keyof typeof positions,
    answers: Answer<A>[] | undefined,
    args: A,
  ): AuthOutcome {
    const list = answers?.length ? answers : [OK];
    const answer = list[Math.min(positions[method]++, list.length - 1)];
    return typeof answer === 'function' ? answer(...args) : answer;
  }

  return {
    kind: script.kind ?? 'stub',
    calls,
    renewals: () => renewals,
    prepare: async () => {
      calls.push({ method: 'prepare' });
      return next('prepare', script.prepare, []);
    },
    establish: async (target) => {
      calls.push({ method: 'establish', argument: target });
      return next('establish', script.establish, [target]);
    },
    authorize: async (request) => {
      calls.push({ method: 'authorize', argument: request });
      const outcome = next('authorize', script.authorize, [request]);
      if (outcome.ok) request.header('Authorization', `Stub ${renewals}`);
      return outcome;
    },
    rejected: async (rejection) => {
      calls.push({ method: 'rejected', argument: rejection });
      const outcome = next('rejected', script.rejected, [rejection]);
      if (outcome.ok) renewals += 1;
      return outcome;
    },
  };
}
