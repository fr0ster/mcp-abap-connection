/**
 * The lifecycle's three credential hooks, on a connector holding a stub
 * provider, and the base class that has no credential at all.
 */
import { authError } from '@mcp-abap-adt/auth-errors';
import { AbstractAbapConnection } from '../../connection/AbstractAbapConnection.js';
import { AdtOnPremConnector } from '../../connection/AdtOnPremConnector.js';
import {
  AuthRefusedError,
  NO_CREDENTIAL_TO_RENEW,
} from '../../connection/authErrors.js';
import { onPremHttpTransport } from '../helpers/onPrem.js';
import { stubProvider } from '../helpers/stubProvider.js';

/** connection's `provider-threw` (I3), whatever the moment. */
const PROVIDER_FAILED = {
  kind: 'connection',
  facts: { problem: 'provider-threw' },
  reason: 'the credential provider failed',
};

const config = {
  url: 'https://h:44300',
  authType: 'basic',
  client: '100',
} as any;

const NO = {
  ok: false,
  refusal: authError['credential-refused']({ credential: 'token' }),
} as const;

function connectorOn(provider: ReturnType<typeof stubProvider>) {
  return new AdtOnPremConnector(
    config,
    provider,
    onPremHttpTransport(config),
    null,
  ) as any;
}

describe('the credential hooks on a connector', () => {
  it('credentialHeaders writes the provider header and not the client', async () => {
    // The client is the wire's to address (`sap-client`); `X-SAP-Client` was
    // written here and ABAP ignores it.
    const conn = connectorOn(stubProvider());
    const headers: Record<string, string> = {};
    await conn.credentialHeaders(headers);
    expect(Object.entries(headers)).toEqual([['Authorization', 'Stub 0']]);
    expect(await conn.getAuthHeaders()).toEqual(headers);
  });

  it('an authorize Oops is an AuthRefusedError at request with the provider refusal', async () => {
    const conn = connectorOn(stubProvider({ authorize: [NO] }));
    const error = await conn.getAuthHeaders().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthRefusedError);
    expect(error.at).toBe('request');
    expect(error.refusal).toBe(NO.refusal);
    expect(error.message).toBe('the token was refused — obtain a new token');
  });

  it('a prepare Oops is an AuthRefusedError at prepare', async () => {
    const conn = connectorOn(stubProvider({ prepare: [NO] }));
    const error = await conn.prepareCredential().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthRefusedError);
    expect(error.at).toBe('prepare');
    expect(error.refusal).toBe(NO.refusal);
  });

  it('an establish Oops is an AuthRefusedError at logon, and rejected is not asked', async () => {
    const provider = stubProvider({ establish: [NO] });
    const conn = connectorOn(provider);
    const error = await conn.logon({} as any).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthRefusedError);
    expect(error.at).toBe('logon');
    expect(error.refusal).toBe(NO.refusal);
    expect(provider.calls.map((c) => c.method)).toEqual(['establish']);
  });

  it('hands the logon target to establish as it is', async () => {
    const provider = stubProvider();
    const target = {} as any;
    await connectorOn(provider).logon(target);
    expect(provider.calls[0]).toEqual({
      method: 'establish',
      argument: target,
    });
  });

  it('credentialRejected hands the rejection over unchanged and returns the answer', async () => {
    const provider = stubProvider({ rejected: [NO, { ok: true }] });
    const conn = connectorOn(provider);
    const rejection = { at: 'request', status: 401, error: new Error('x') };
    const refused = await conn.credentialRejected(rejection);
    // The answer re-checked by classifyOutcome: a new outcome, the same refusal.
    expect(refused.outcome).toStrictEqual(NO);
    expect(refused.outcome.refusal).toBe(NO.refusal);
    expect('thrown' in refused).toBe(false);
    expect(provider.calls[0].argument).toBe(rejection);
    expect(await conn.credentialRejected(rejection)).toEqual({
      outcome: { ok: true },
    });
    expect(provider.renewals()).toBe(1);
  });

  it('a provider that throws is PROVIDER_FAILED, the throw kept as cause', async () => {
    const boom = new Error('boom');
    const throwing = () => {
      throw boom;
    };
    const conn = connectorOn(
      stubProvider({
        prepare: [throwing],
        establish: [throwing],
        authorize: [throwing],
        rejected: [throwing],
      }),
    );
    for (const [call, at] of [
      [() => conn.prepareCredential(), 'prepare'],
      [() => conn.logon({}), 'logon'],
      [() => conn.getAuthHeaders(), 'request'],
    ] as const) {
      const error = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AuthRefusedError);
      expect(error.at).toBe(at);
      expect(error.refusal).toMatchObject(PROVIDER_FAILED);
      expect(error.refusal.facts.at).toBe(at);
      expect(error.cause).toBe(boom);
    }
    const answer = await conn.credentialRejected({ at: 'request', error: 1 });
    expect(answer.outcome).toMatchObject({
      ok: false,
      refusal: {
        ...PROVIDER_FAILED,
        facts: { ...PROVIDER_FAILED.facts, at: 'request' },
      },
    });
    expect(answer.thrown).toBe(boom);
  });
});

describe('the base class alone', () => {
  class Bare extends (AbstractAbapConnection as any) {
    async connect() {}
  }
  const bare = () =>
    new (Bare as unknown as new (...a: unknown[]) => any)(
      config,
      onPremHttpTransport(config),
      null,
    );

  it('writes nothing and answers NO_CREDENTIAL_TO_RENEW', async () => {
    const conn = bare();
    expect(await conn.getAuthHeaders()).toEqual({});
    await expect(conn.logon({})).resolves.toBeUndefined();
    expect(await conn.credentialRejected({ at: 'request', error: 1 })).toEqual({
      outcome: { ok: false, refusal: NO_CREDENTIAL_TO_RENEW },
    });
  });
});
