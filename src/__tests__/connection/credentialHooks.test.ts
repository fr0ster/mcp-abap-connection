/**
 * The lifecycle's three credential hooks, on a connector holding a stub
 * provider, and the base class that has no credential at all.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { authError } from '@mcp-abap-adt/auth-errors';
import { AbstractAbapConnection } from '../../connection/AbstractAbapConnection.js';
import { AdtOnPremConnector } from '../../connection/AdtOnPremConnector.js';
import {
  AuthRefusedError,
  NO_CREDENTIAL_TO_RENEW,
} from '../../connection/authErrors.js';
import { assertMatchObject } from '../helpers/assertions.js';
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
    assert.deepStrictEqual(Object.entries(headers), [
      ['Authorization', 'Stub 0'],
    ]);
    assert.deepStrictEqual(await conn.getAuthHeaders(), headers);
  });

  it('an authorize Oops is an AuthRefusedError at request with the provider refusal', async () => {
    const conn = connectorOn(stubProvider({ authorize: [NO] }));
    const error = await conn.getAuthHeaders().catch((e: unknown) => e);
    assert.ok(error instanceof AuthRefusedError);
    assert.strictEqual(error.at, 'request');
    assert.strictEqual(error.refusal, NO.refusal);
    assert.strictEqual(
      error.message,
      'the token was refused — obtain a new token',
    );
  });

  it('a prepare Oops is an AuthRefusedError at prepare', async () => {
    const conn = connectorOn(stubProvider({ prepare: [NO] }));
    const error = await conn.prepareCredential().catch((e: unknown) => e);
    assert.ok(error instanceof AuthRefusedError);
    assert.strictEqual(error.at, 'prepare');
    assert.strictEqual(error.refusal, NO.refusal);
  });

  it('an establish Oops is an AuthRefusedError at logon, and rejected is not asked', async () => {
    const provider = stubProvider({ establish: [NO] });
    const conn = connectorOn(provider);
    const error = await conn.logon({} as any).catch((e: unknown) => e);
    assert.ok(error instanceof AuthRefusedError);
    assert.strictEqual(error.at, 'logon');
    assert.strictEqual(error.refusal, NO.refusal);
    assert.deepStrictEqual(
      provider.calls.map((c) => c.method),
      ['establish'],
    );
  });

  it('hands the logon target to establish as it is', async () => {
    const provider = stubProvider();
    const target = {} as any;
    await connectorOn(provider).logon(target);
    assert.deepStrictEqual(provider.calls[0], {
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
    assert.deepStrictEqual(refused.outcome, NO);
    assert.strictEqual(refused.outcome.refusal, NO.refusal);
    assert.strictEqual('thrown' in refused, false);
    assert.strictEqual(provider.calls[0].argument, rejection);
    assert.deepStrictEqual(await conn.credentialRejected(rejection), {
      outcome: { ok: true },
    });
    assert.strictEqual(provider.renewals(), 1);
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
      assert.ok(error instanceof AuthRefusedError);
      assert.strictEqual(error.at, at);
      assertMatchObject(error.refusal, PROVIDER_FAILED);
      assert.strictEqual(error.refusal.facts.at, at);
      assert.strictEqual(error.cause, boom);
    }
    const answer = await conn.credentialRejected({ at: 'request', error: 1 });
    assertMatchObject(answer.outcome, {
      ok: false,
      refusal: {
        ...PROVIDER_FAILED,
        facts: { ...PROVIDER_FAILED.facts, at: 'request' },
      },
    });
    assert.strictEqual(answer.thrown, boom);
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
    assert.deepStrictEqual(await conn.getAuthHeaders(), {});
    assert.strictEqual(await conn.logon({}), undefined);
    assert.deepStrictEqual(
      await conn.credentialRejected({ at: 'request', error: 1 }),
      {
        outcome: { ok: false, refusal: NO_CREDENTIAL_TO_RENEW },
      },
    );
  });
});
