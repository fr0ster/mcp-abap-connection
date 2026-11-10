/**
 * The session context: what a wire receives from the connection, and what the
 * connection does with a logon the system refuses.
 *
 * A real `OnPremHttpTransport` (or `CloudHttpTransport`) against a local SAP,
 * with a stub provider that records every call.
 */
import assert from 'node:assert/strict';
import type { AgentOptions } from 'node:https';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { authError } from '@mcp-abap-adt/auth-errors';
import type { AuthOutcome, ILogonTarget } from '@mcp-abap-adt/interfaces-auth';
import type { SapHttpConfig } from '../../config/sapConfig.js';
import { AdtCloudConnector } from '../../connection/AdtCloudConnector.js';
import { AdtOnPremConnector } from '../../connection/AdtOnPremConnector.js';
import { AuthRefusedError } from '../../connection/authErrors.js';
import { CloudHttpTransport } from '../../connection/CloudHttpTransport.js';
import { HttpTransport } from '../../connection/HttpTransport.js';
import { refusalOf } from '../../connection/IAdtTransport.js';
import { OnPremHttpTransport } from '../../connection/OnPremHttpTransport.js';
import { assertMatchObject, instanceOf } from '../helpers/assertions.js';
import {
  type HttpClientStub,
  httpClientStub,
} from '../helpers/httpClientStub.js';
import { type SapStub, startSapStub } from '../helpers/sapStub.js';
import { type StubScript, stubProvider } from '../helpers/stubProvider.js';

/** connection's `provider-threw` (I3), whatever the moment. */
const PROVIDER_FAILED = {
  kind: 'connection',
  facts: { problem: 'provider-threw' },
  reason: 'the credential provider failed',
};
/** connection's `refused-after-renewal` (I4), whatever the moment. */
const REFUSED_AGAIN = {
  kind: 'connection',
  facts: { problem: 'refused-after-renewal' },
  reason: 'the credential was refused again after the provider renewed it',
};

const DISCOVERY = '/sap/bc/adt/core/discovery';
const LOGOFF = '/sap/public/bc/icf/logoff';
const REFUSAL = authError['credential-refused']({ credential: 'token' });
const NO: AuthOutcome = { ok: false, refusal: REFUSAL };

let stub: SapStub;

beforeEach(async () => {
  stub = await startSapStub();
});

afterEach(async () => {
  await stub.close();
});

function onPremWith(script: StubScript = {}) {
  const config: SapHttpConfig = {
    url: stub.baseUrl,
    client: '100',
    authType: 'basic',
  };
  const provider = stubProvider(script);
  const transport = new OnPremHttpTransport(() => ({}), null, {
    client: '100',
    baseUrl: stub.baseUrl,
  });
  const conn = new AdtOnPremConnector(config, provider, transport, null);
  const rejections = () => provider.rejections;
  const order = () => provider.calls.map((call) => call.method);
  return { conn, provider, transport, rejections, order };
}

const discoveryRequests = () => stub.sentTo(DISCOVERY);

describe('connect() orders the credential around the wire', () => {
  it('prepares, then logs on, then authorizes the establishing request', async () => {
    const { conn, order } = onPremWith();

    await conn.connect();

    assert.deepStrictEqual(order().slice(0, 3), [
      'prepare',
      'establish',
      'authorize',
    ]);
    assert.strictEqual(conn.isConnected(), true);
  });

  it('sends nothing and never logs on when prepare says no', async () => {
    const { conn, order } = onPremWith({ prepare: [NO] });

    const error = await conn.connect().catch((e: unknown) => e);

    assert.ok(error instanceof AuthRefusedError);
    assert.strictEqual(instanceOf(error, AuthRefusedError).at, 'prepare');
    assert.deepStrictEqual(
      instanceOf(error, AuthRefusedError).refusal,
      REFUSAL,
    );
    assert.deepStrictEqual(order(), ['prepare']);
    assert.strictEqual(stub.requests.length, 0);
    assert.strictEqual(conn.isConnected(), false);
  });
});

describe('the HTTP logon target', () => {
  /** Runs one logon through `open` and returns what the provider was told. */
  async function logonWith(
    transport: HttpTransport,
    offer: (target: ILogonTarget) => AuthOutcome,
  ): Promise<AuthOutcome> {
    let outcome: AuthOutcome = { ok: true };
    await transport.open({
      authorize: async () => {},
      logon: async (target) => {
        outcome = offer(target);
      },
      observe: () => {},
    });
    return outcome;
  }

  it('takes TLS material', async () => {
    const transport = new HttpTransport(undefined, null, {
      baseUrl: stub.baseUrl,
    });

    const outcome = await logonWith(transport, (t) =>
      t.tlsMaterial({ cert: 'C', key: 'K' }),
    );

    assert.deepStrictEqual(outcome, { ok: true });
  });

  it('refuses logon parameters, in the fixed words', async () => {
    const transport = new HttpTransport(undefined, null, {
      baseUrl: stub.baseUrl,
    });

    const outcome = await logonWith(transport, (t) =>
      t.logonParameters({ snc_mode: '1' }),
    );

    assert.deepStrictEqual(outcome, {
      ok: false,
      refusal: authError['logon-target']({
        wire: 'http',
        refused: 'logon-parameters',
      }),
    });
    if (outcome.ok) throw new Error('expected a refusal');
    assert.strictEqual(outcome.refusal.kind, 'logon-target');
    assert.deepStrictEqual(outcome.refusal.facts, {
      wire: 'http',
      refused: 'logon-parameters',
    });
    assert.strictEqual(
      outcome.refusal.reason,
      'this wire takes no logon parameters (HTTP)',
    );
    assert.strictEqual(outcome.refusal.hint, undefined);
  });

  /** A wire whose client is the stub's: what it builds is what it records. */
  function wireWith(agentOptions?: () => AgentOptions): {
    transport: HttpTransport;
    client: HttpClientStub;
  } {
    const client = httpClientStub();
    const transport = new HttpTransport(agentOptions, null, {
      baseUrl: stub.baseUrl,
      httpClient: client,
    });
    return { transport, client };
  }

  /** One request, so the wire builds (or keeps) its client. */
  const request = (transport: HttpTransport) =>
    transport.send({ method: 'GET', url: '/sap/bc/adt/x' });

  /** The options of the HTTPS agent of the last client the wire built. */
  const agentOf = (client: HttpClientStub) => {
    const agents = client.built.at(-1);
    assert.ok(agents);
    return agents.httpsAgent.options;
  };

  it('builds the agent from the material the logon offered, over agentOptions', async () => {
    const { transport, client } = wireWith(() => ({
      ca: 'THE-CA',
      passphrase: 'from-options',
    }));

    await logonWith(transport, (t) =>
      t.tlsMaterial({ cert: 'THE-CERT', key: 'THE-KEY', passphrase: 'mine' }),
    );
    await request(transport);

    const options = agentOf(client);
    assert.strictEqual(options.ca, 'THE-CA');
    assert.strictEqual(options.cert, 'THE-CERT');
    assert.strictEqual(options.key, 'THE-KEY');
    assert.strictEqual(options.passphrase, 'mine');
  });

  it('takes only the material fields: an extra key or an explicit undefined does not override agentOptions', async () => {
    const { transport, client } = wireWith(() => ({
      ca: 'THE-CA',
      rejectUnauthorized: true,
      passphrase: 'from-options',
    }));

    // Not a literal: a value carrying keys beyond the material, as a caller
    // outside the type system could hand one.
    const material = {
      cert: 'THE-CERT',
      key: 'THE-KEY',
      passphrase: undefined,
      rejectUnauthorized: false,
      ca: 'NOT-THE-CA',
    };
    await logonWith(transport, (t) => t.tlsMaterial(material));
    await request(transport);

    const options = agentOf(client);
    assert.strictEqual(options.cert, 'THE-CERT');
    assert.strictEqual(options.key, 'THE-KEY');
    assert.strictEqual(options.ca, 'THE-CA');
    assert.strictEqual(options.rejectUnauthorized, true);
    assert.strictEqual(options.passphrase, 'from-options');
  });

  it('keeps the client when a first logon offers nothing but undefined fields', async () => {
    const { transport, client } = wireWith();
    await request(transport);

    await logonWith(transport, (t) => t.tlsMaterial({ cert: undefined }));
    await request(transport);

    assert.strictEqual(client.built.length, 1);
  });

  it('keeps the client for the same material, compared by value', async () => {
    const { transport, client } = wireWith();
    await logonWith(transport, (t) =>
      t.tlsMaterial({ pfx: Buffer.from('bytes'), passphrase: 'p' }),
    );
    await request(transport);

    await logonWith(transport, (t) =>
      t.tlsMaterial({ pfx: Buffer.from('bytes'), passphrase: 'p' }),
    );
    await request(transport);

    assert.strictEqual(client.built.length, 1);
  });

  it('rebuilds the client for different material, and the cookie jar survives', async () => {
    const { transport, client } = wireWith();
    await logonWith(transport, (t) => t.tlsMaterial({ cert: 'ONE', key: 'K' }));
    await request(transport);
    transport.ingest({ 'set-cookie': ['SAP_SESSIONID_X_100=S1; Path=/'] });
    transport.adoptCsrfToken('TOKEN');

    await logonWith(transport, (t) => t.tlsMaterial({ cert: 'TWO', key: 'K' }));
    await request(transport);

    assert.strictEqual(client.built.length, 2);
    assert.strictEqual(agentOf(client).cert, 'TWO');
    assert.strictEqual(transport.cookies(), 'SAP_SESSIONID_X_100=S1');
    assert.strictEqual(transport.csrfToken(), 'TOKEN');
  });
});

describe('a 401 while establishing', () => {
  it('asks rejected at logon with the status; Ok logs on again and connects', async () => {
    const { conn, rejections } = onPremWith();
    stub.discovery.push(401);

    await conn.connect();

    assert.strictEqual(rejections().length, 1);
    assertMatchObject(rejections()[0], { at: 'logon', status: 401 });
    assert.deepStrictEqual(
      discoveryRequests().map((r) => r.status),
      [401, 200],
    );
    assert.strictEqual(discoveryRequests()[1].headers.authorization, 'Stub 1');
    assert.strictEqual(conn.isConnected(), true);
  });

  it('logs on once per attempt: the renewed credential meets a fresh logon', async () => {
    const { conn, order } = onPremWith();
    stub.discovery.push(401);

    await conn.connect();

    assert.strictEqual(order().filter((m) => m === 'establish').length, 2);
  });

  it('raises the provider’s words at logon when it says no, keeping the wire’s error', async () => {
    const { conn, rejections } = onPremWith({ rejected: [NO] });
    stub.discovery.push(401);

    const error = await conn.connect().catch((e: unknown) => e);

    assert.ok(error instanceof AuthRefusedError);
    assert.strictEqual(instanceOf(error, AuthRefusedError).at, 'logon');
    assert.deepStrictEqual(
      instanceOf(error, AuthRefusedError).refusal,
      REFUSAL,
    );
    assertMatchObject(instanceOf(error, AuthRefusedError).cause, {
      response: { status: 401 },
    });
    assert.strictEqual(rejections().length, 1);
    assert.strictEqual(conn.isConnected(), false);
  });

  it('a rejected() that throws is PROVIDER_FAILED at logon, the throw as cause', async () => {
    const boom = new Error('boom');
    const { conn, rejections } = onPremWith({
      rejected: [
        () => {
          throw boom;
        },
      ],
    });
    stub.discovery.push(401);

    const error = await conn.connect().catch((e: unknown) => e);

    assert.ok(error instanceof AuthRefusedError);
    assert.strictEqual(instanceOf(error, AuthRefusedError).at, 'logon');
    assertMatchObject(
      instanceOf(error, AuthRefusedError).refusal,
      PROVIDER_FAILED,
    );
    assert.strictEqual(instanceOf(error, AuthRefusedError).cause, boom);
    assert.strictEqual(rejections().length, 1);
    assert.strictEqual(conn.isConnected(), false);
  });

  it('is refused again after Ok: the verdict, and rejected was asked once', async () => {
    const { conn, rejections } = onPremWith();
    stub.discovery.push(401, 401);

    const error = await conn.connect().catch((e: unknown) => e);

    assert.ok(error instanceof AuthRefusedError);
    assertMatchObject(
      instanceOf(error, AuthRefusedError).refusal,
      REFUSED_AGAIN,
    );
    assertMatchObject(instanceOf(error, AuthRefusedError).refusal, {
      facts: { at: 'logon' },
    });
    assert.strictEqual(instanceOf(error, AuthRefusedError).at, 'logon');
    assert.strictEqual(rejections().length, 1);
    assert.strictEqual(conn.isConnected(), false);
  });

  it('a 500 is its own error: connect() rejects with it, unretried, and never asks rejected', async () => {
    const { conn, rejections } = onPremWith();
    stub.discovery.push(500);

    const error = await conn.connect().catch((e: unknown) => e);

    assert.strictEqual(refusalOf(error)?.status, 500);
    assert.strictEqual(rejections().length, 0);
    assert.deepStrictEqual(
      discoveryRequests().map((r) => r.status),
      [500],
    );
    assert.strictEqual(conn.isConnected(), false);
  });

  it('lets the provider’s refusal to authorize through untouched, unretried', {
    timeout: 10000,
  }, async () => {
    // authorize says no on the establishing request itself.
    const { conn, rejections } = onPremWith({ authorize: [NO] });

    const error = await conn.connect().catch((e: unknown) => e);

    assert.ok(error instanceof AuthRefusedError);
    assert.strictEqual(instanceOf(error, AuthRefusedError).at, 'request');
    assert.strictEqual(discoveryRequests().length, 0);
    assert.strictEqual(rejections().length, 0);
  });
});

describe('the wire’s establishment', () => {
  it('lets the provider’s refusal to authorize through at once', async () => {
    const transport = new HttpTransport(undefined, null, {
      baseUrl: stub.baseUrl,
    });
    let asked = 0;
    const refusal = new AuthRefusedError(REFUSAL, 'request');

    const error = await transport
      .establish({
        authorize: async () => {
          asked += 1;
          throw refusal;
        },
        logon: async () => {},
        observe: () => {},
      })
      .catch((e: unknown) => e);

    assert.strictEqual(error, refusal);
    assert.strictEqual(asked, 1);
  });
});

/**
 * The logoff carries the session's cookie and nothing that logs on, as Eclipse
 * ADT 3.60.3 sends it: the service answers `sap-authenticated: not required`,
 * so a credential would only be handed to a public endpoint that ignores it.
 */
describe('the goodbye', () => {
  it('carries the cookie, not the credential, and does not ask the provider', async () => {
    const { conn, provider } = onPremWith();
    await conn.connect();
    const before = provider.calls.filter(
      (c) => c.method === 'authorize',
    ).length;

    await conn.disconnect();
    await conn.flushGoodbye();

    assert.strictEqual(stub.sentTo(LOGOFF).length, 1);
    assert.strictEqual(stub.sentTo(LOGOFF)[0].headers.authorization, undefined);
    assert.ok(stub.sentTo(LOGOFF)[0].headers.cookie.includes('SAP_SESSIONID'));
    assert.strictEqual(
      provider.calls.filter((c) => c.method === 'authorize').length,
      before,
    );
  });

  it('goes out even when the provider would not authorize a request', async () => {
    const { conn } = onPremWith({
      authorize: [{ ok: true }, NO],
    });
    await conn.connect();

    assert.strictEqual(await conn.disconnect(), undefined);
    assert.strictEqual(await conn.flushGoodbye(), undefined);

    assert.strictEqual(stub.sentTo(LOGOFF).length, 1);
  });
});

describe('the cloud wire', () => {
  function cloudWith(script: StubScript = {}) {
    const config: SapHttpConfig = {
      url: stub.baseUrl,
      client: '100',
      authType: 'jwt',
    };
    const provider = stubProvider(script);
    const transport = new CloudHttpTransport(() => ({}), null, {
      client: '100',
      baseUrl: stub.baseUrl,
    });
    const conn = new AdtCloudConnector(config, provider, transport, null);
    return { conn, provider };
  }

  it('lets a logon the provider refuses through the preflight, before anything is sent', async () => {
    const { conn, provider } = cloudWith({ establish: [NO] });

    const error = await conn.connect().catch((e: unknown) => e);

    assert.ok(error instanceof AuthRefusedError);
    assert.strictEqual(instanceOf(error, AuthRefusedError).at, 'logon');
    assert.strictEqual(stub.requests.length, 0);
    assert.deepStrictEqual(
      provider.calls.map((c) => c.method),
      ['prepare', 'establish'],
    );
  });

  it('lets a request the provider will not authorize through the preflight', async () => {
    const { conn } = cloudWith({ authorize: [NO, { ok: true }] });

    const error = await conn.connect().catch((e: unknown) => e);

    assert.ok(error instanceof AuthRefusedError);
    assert.strictEqual(instanceOf(error, AuthRefusedError).at, 'request');
    assert.strictEqual(stub.requests.length, 0);
  });

  it('still swallows a preflight the system fails, as before', async () => {
    const { conn } = cloudWith();
    stub.work('/sap/bc/adt/core/http/sessions', [500]);

    await conn.connect();

    assert.strictEqual(conn.isConnected(), true);
  });
});
