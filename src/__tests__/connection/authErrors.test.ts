import {
  AuthRefusedError,
  guarded,
  NO_CREDENTIAL_TO_RENEW,
  PROVIDER_FAILED,
  REFUSED_AGAIN,
  WireLogonError,
} from '../../connection/authErrors.js';

describe('AuthRefusedError', () => {
  it('carries the refusal, the moment and the cause', () => {
    const cause = new Error('wire');
    const error = new AuthRefusedError(
      { reason: 'the password was refused' },
      'logon',
      cause,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AuthRefusedError');
    expect(error.refusal).toEqual({ reason: 'the password was refused' });
    expect(error.at).toBe('logon');
    expect(error.cause).toBe(cause);
  });

  it('words its message as the reason alone when there is no hint', () => {
    expect(new AuthRefusedError({ reason: 'no' }, 'prepare').message).toBe(
      'no',
    );
  });

  it('adds the hint after the reason', () => {
    const error = new AuthRefusedError(
      { reason: 'no certificate', hint: 'log on in the client' },
      'request',
    );
    expect(error.message).toBe('no certificate — log on in the client');
  });

  it('has no cause when none was given', () => {
    expect(new AuthRefusedError({ reason: 'x' }, 'prepare').cause).toBe(
      undefined,
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

describe('fixed refusals', () => {
  it('use the wordings of the spec', () => {
    expect(PROVIDER_FAILED.reason).toBe('the credential provider failed');
    expect(REFUSED_AGAIN.reason).toBe(
      'the credential was refused again after the provider renewed it',
    );
    expect(NO_CREDENTIAL_TO_RENEW.reason).toBe(
      'this connection has no credential to renew',
    );
  });
});

describe('guarded', () => {
  it('passes an outcome through', async () => {
    const refusal = { reason: 'nope', hint: 'try again' };
    expect(await guarded(async () => ({ ok: true }))).toEqual({
      outcome: { ok: true },
    });
    expect(await guarded(async () => ({ ok: false, refusal }))).toEqual({
      outcome: { ok: false, refusal },
    });
  });

  it('turns a throw into PROVIDER_FAILED and keeps the throw', async () => {
    const thrown = new Error('boom');
    const result = await guarded(async () => {
      throw thrown;
    });
    expect(result.outcome).toEqual({ ok: false, refusal: PROVIDER_FAILED });
    expect(result.thrown).toBe(thrown);
  });

  it('turns a synchronous throw into PROVIDER_FAILED too', async () => {
    const thrown = new Error('sync');
    const result = await guarded((() => {
      throw thrown;
    }) as never);
    expect(result.outcome).toEqual({ ok: false, refusal: PROVIDER_FAILED });
    expect(result.thrown).toBe(thrown);
  });
});
