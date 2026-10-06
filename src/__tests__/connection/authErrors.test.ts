import {
  authError,
  classifyOutcome,
  isMinted,
} from '@mcp-abap-adt/auth-errors';
import type { AuthOutcome, IAuthRefusal } from '@mcp-abap-adt/interfaces-auth';
import {
  AuthRefusedError,
  guarded,
  NO_CREDENTIAL_TO_RENEW,
  providerFailed,
  refusedAgain,
  WireLogonError,
} from '../../connection/authErrors.js';

/**
 * What a provider written in JavaScript answers: any value at all. Parsed
 * JSON is untyped, which is exactly what such a provider's answer is.
 */
function answering(value: unknown): () => Promise<AuthOutcome> {
  const json = JSON.stringify(value);
  return async () => JSON.parse(json);
}

describe('AuthRefusedError', () => {
  const refused = authError['credential-refused']({
    credential: 'user-password',
    at: 'logon',
  });

  it('carries the refusal, the moment and the cause', () => {
    const cause = new Error('wire');
    const error = new AuthRefusedError(refused, 'logon', cause);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AuthRefusedError');
    expect(error.refusal).toBe(refused);
    expect(error.refusal.kind).toBe('credential-refused');
    expect(error.at).toBe('logon');
    expect(error.cause).toBe(cause);
  });

  it('words its message as the reason alone when there is no hint', () => {
    expect(
      new AuthRefusedError(NO_CREDENTIAL_TO_RENEW, 'prepare').message,
    ).toBe('this connection has no credential to renew');
  });

  it('words its message as reason — hint', () => {
    expect(new AuthRefusedError(refused, 'request').message).toBe(
      'the user or password was refused — check the user and password',
    );
  });

  it('has no cause when none was given', () => {
    expect(new AuthRefusedError(refused, 'prepare').cause).toBe(undefined);
  });

  it('RF3: over a structuredClone of a classified refusal, still reads reason — hint', () => {
    const outcome = classifyOutcome(
      { ok: false, refusal: refused },
      providerFailed('request'),
    );
    if (outcome.ok) throw new Error('expected a refusal');
    const cloned: IAuthRefusal = structuredClone(outcome.refusal);
    expect(isMinted(cloned)).toBe(false);
    expect(new AuthRefusedError(cloned, 'request').message).toBe(
      'the user or password was refused — check the user and password',
    );
  });
});

describe('WireLogonError', () => {
  it('keeps the raw error as it arrived, the same object', () => {
    const raw = Object.assign(new Error('401'), { response: { status: 401 } });
    const error = new WireLogonError(raw, 401);
    expect(error.name).toBe('WireLogonError');
    expect(error.cause).toBe(raw);
    expect(error.status).toBe(401);
  });

  it('has no status when the wire has none', () => {
    expect(new WireLogonError('rfc said no').status).toBeUndefined();
  });
});

describe("connection's own refusals (I3–I5)", () => {
  it('I3: provider-threw, at the moment, in the words of today', () => {
    const error = providerFailed('logon');
    expect(isMinted(error)).toBe(true);
    expect(error.kind).toBe('connection');
    expect(error.facts).toStrictEqual({
      problem: 'provider-threw',
      at: 'logon',
    });
    expect(error.reason).toBe('the credential provider failed');
    expect(error.hint).toBeUndefined();
  });

  it('I4: refused-after-renewal, at the moment, in the words of today', () => {
    const error = refusedAgain('request');
    expect(isMinted(error)).toBe(true);
    expect(error.kind).toBe('connection');
    expect(error.facts).toStrictEqual({
      problem: 'refused-after-renewal',
      at: 'request',
    });
    expect(error.reason).toBe(
      'the credential was refused again after the provider renewed it',
    );
    expect(error.hint).toBeUndefined();
  });

  it('I5: no-credential, in the words of today', () => {
    expect(isMinted(NO_CREDENTIAL_TO_RENEW)).toBe(true);
    expect(NO_CREDENTIAL_TO_RENEW.kind).toBe('connection');
    expect(NO_CREDENTIAL_TO_RENEW.facts).toStrictEqual({
      problem: 'no-credential',
    });
    expect(NO_CREDENTIAL_TO_RENEW.reason).toBe(
      'this connection has no credential to renew',
    );
    expect(NO_CREDENTIAL_TO_RENEW.hint).toBeUndefined();
  });
});

describe('guarded', () => {
  it('passes Ok through', async () => {
    expect(await guarded(async () => ({ ok: true }), 'prepare')).toEqual({
      outcome: { ok: true },
    });
  });

  it('passes a refusal minted by the same auth-errors as the same object', async () => {
    const refusal = authError['credential-refused']({ credential: 'token' });
    const answer = await guarded(
      async () => ({ ok: false, refusal }),
      'request',
    );
    if (answer.outcome.ok) throw new Error('expected a refusal');
    expect(answer.outcome.refusal).toBe(refusal);
    expect('thrown' in answer).toBe(false);
  });

  it('re-mints a forged refusal from a JavaScript provider as provider-threw; the secret is in no message', async () => {
    const secret = 'password=hunter2';
    const answer = await guarded(
      answering({ ok: false, refusal: { reason: secret, hint: secret } }),
      'logon',
    );
    if (answer.outcome.ok) throw new Error('expected a refusal');
    expect(isMinted(answer.outcome.refusal)).toBe(true);
    expect(answer.outcome.refusal.kind).toBe('connection');
    expect(answer.outcome.refusal.facts).toStrictEqual({
      problem: 'provider-threw',
      at: 'logon',
    });
    const error = new AuthRefusedError(answer.outcome.refusal, 'logon');
    expect(error.message).toBe('the credential provider failed');
    expect(error.message).not.toContain('hunter2');
    expect(JSON.stringify(answer)).not.toContain('hunter2');
  });

  it('re-mints an answer that is no outcome at all as provider-threw', async () => {
    const answer = await guarded(answering('nonsense'), 'request');
    expect(answer.outcome).toStrictEqual({
      ok: false,
      refusal: providerFailed('request'),
    });
  });

  it('turns a throw into provider-threw at the moment and keeps the throw', async () => {
    const thrown = new Error('boom');
    const answer = await guarded(async () => {
      throw thrown;
    }, 'prepare');
    if (answer.outcome.ok) throw new Error('expected a refusal');
    expect(answer.outcome.refusal.kind).toBe('connection');
    expect(answer.outcome.refusal.facts).toStrictEqual({
      problem: 'provider-threw',
      at: 'prepare',
    });
    expect(answer.outcome.refusal.reason).toBe(
      'the credential provider failed',
    );
    expect(answer.thrown).toBe(thrown);
  });

  it('turns a synchronous throw into provider-threw too', async () => {
    const thrown = new Error('sync');
    const answer = await guarded(() => {
      throw thrown;
    }, 'request');
    expect(answer.outcome).toStrictEqual({
      ok: false,
      refusal: providerFailed('request'),
    });
    expect(answer.thrown).toBe(thrown);
  });
});
