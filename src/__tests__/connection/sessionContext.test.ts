/**
 * The session context: what a wire receives from the connection, and what the
 * connection does with a logon the system refuses.
 *
 * A real `OnPremHttpTransport` (or `CloudHttpTransport`) against a local SAP,
 * with a stub provider that records every call.
 */
import type {
  AuthOutcome,
  IAuthRejection,
  ILogonTarget,
} from '@mcp-abap-adt/interfaces-auth';
import type { SapConfig } from '../../config/sapConfig.js';
import { AdtCloudConnector } from '../../connection/AdtCloudConnector.js';
import { AdtOnPremConnector } from '../../connection/AdtOnPremConnector.js';
import {
  AuthRefusedError,
  REFUSED_AGAIN,
} from '../../connection/authErrors.js';
import { CloudHttpTransport } from '../../connection/CloudHttpTransport.js';
import { HttpTransport } from '../../connection/HttpTransport.js';
import { OnPremHttpTransport } from '../../connection/OnPremHttpTransport.js';
import { type SapStub, startSapStub } from '../helpers/sapStub.js';
import { type StubScript, stubProvider } from '../helpers/stubProvider.js';

const DISCOVERY = '/sap/bc/adt/core/discovery';
const LOGOFF = '/sap/public/bc/icf/logoff';
const REFUSAL = { reason: 'the stub says no', hint: 'ask it nicely' };
const NO: AuthOutcome = { ok: false, refusal: REFUSAL };

let stub: SapStub;

beforeEach(async () => {
  stub = await startSapStub();
});

afterEach(async () => {
  await stub.close();
});

function onPremWith(script: StubScript = {}) {
  const config = {
    url: stub.baseUrl,
    client: '100',
    authType: 'basic',
  } as SapConfig;
  const provider = stubProvider(script);
  const transport = new OnPremHttpTransport(() => ({}), null, {
    client: '100',
    baseUrl: stub.baseUrl,
  });
  const conn = new AdtOnPremConnector(config, provider, transport, null);
  const rejections = () =>
    provider.calls
      .filter((call) => call.method === 'rejected')
      .map((call) => call.argument as IAuthRejection);
  const order = () => provider.calls.map((call) => call.method);
  return { conn, provider, transport, rejections, order };
}

const discoveryRequests = () => stub.sentTo(DISCOVERY);

describe('connect() orders the credential around the wire', () => {
  it('prepares, then logs on, then authorizes the establishing request', async () => {
    const { conn, order } = onPremWith();

    await conn.connect();

    expect(order().slice(0, 3)).toStrictEqual([
      'prepare',
      'establish',
      'authorize',
    ]);
    expect(conn.isConnected()).toBe(true);
  });

  it('sends nothing and never logs on when prepare says no', async () => {
    const { conn, order } = onPremWith({ prepare: [NO] });

    const error = await conn.connect().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthRefusedError);
    expect((error as AuthRefusedError).at).toBe('prepare');
    expect((error as AuthRefusedError).refusal).toStrictEqual(REFUSAL);
    expect(order()).toStrictEqual(['prepare']);
    expect(stub.requests).toHaveLength(0);
    expect(conn.isConnected()).toBe(false);
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
      baseUrl: stub.baseUrl,
      authorize: async () => {},
      logon: async (target) => {
        outcome = offer(target);
      },
      observe: () => {},
    });
    return outcome;
  }

  it('takes TLS material', async () => {
    const transport = new HttpTransport();

    const outcome = await logonWith(transport, (t) =>
      t.tlsMaterial({ cert: 'C', key: 'K' }),
    );

    expect(outcome).toStrictEqual({ ok: true });
  });

  it('refuses logon parameters, in the fixed words', async () => {
    const transport = new HttpTransport();

    const outcome = await logonWith(transport, (t) =>
      t.logonParameters({ snc_mode: '1' }),
    );

    expect(outcome).toStrictEqual({
      ok: false,
      refusal: { reason: 'this wire takes no logon parameters (HTTP)' },
    });
  });

  const agentOf = (transport: HttpTransport) =>
    // biome-ignore lint/suspicious/noExplicitAny: reads the client under test
    (transport as any).client().defaults.httpsAgent as {
      options: Record<string, unknown>;
    };

  it('builds the agent from the material the logon offered, over agentOptions', async () => {
    const transport = new HttpTransport(() => ({
      ca: 'THE-CA',
      passphrase: 'from-options',
    }));

    await logonWith(transport, (t) =>
      t.tlsMaterial({ cert: 'THE-CERT', key: 'THE-KEY', passphrase: 'mine' }),
    );

    const options = agentOf(transport).options;
    expect(options.ca).toBe('THE-CA');
    expect(options.cert).toBe('THE-CERT');
    expect(options.key).toBe('THE-KEY');
    expect(options.passphrase).toBe('mine');
  });

  it('takes only the material fields: an extra key or an explicit undefined does not override agentOptions', async () => {
    const transport = new HttpTransport(() => ({
      ca: 'THE-CA',
      rejectUnauthorized: true,
      passphrase: 'from-options',
    }));

    await logonWith(transport, (t) =>
      t.tlsMaterial({
        cert: 'THE-CERT',
        key: 'THE-KEY',
        passphrase: undefined,
        rejectUnauthorized: false,
        ca: 'NOT-THE-CA',
      } as unknown as Parameters<ILogonTarget['tlsMaterial']>[0]),
    );

    const options = agentOf(transport).options;
    expect(options.cert).toBe('THE-CERT');
    expect(options.key).toBe('THE-KEY');
    expect(options.ca).toBe('THE-CA');
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.passphrase).toBe('from-options');
  });

  it('keeps the client when a first logon offers nothing but undefined fields', async () => {
    const transport = new HttpTransport();
    const first = (transport as any).client();

    await logonWith(transport, (t) => t.tlsMaterial({ cert: undefined }));

    expect((transport as any).client()).toBe(first);
  });

  it('keeps the client for the same material, compared by value', async () => {
    const transport = new HttpTransport();
    await logonWith(transport, (t) =>
      t.tlsMaterial({ pfx: Buffer.from('bytes'), passphrase: 'p' }),
    );
    // biome-ignore lint/suspicious/noExplicitAny: reads the client under test
    const first = (transport as any).client();

    await logonWith(transport, (t) =>
      t.tlsMaterial({ pfx: Buffer.from('bytes'), passphrase: 'p' }),
    );

    // biome-ignore lint/suspicious/noExplicitAny: reads the client under test
    expect((transport as any).client()).toBe(first);
  });

  it('rebuilds the client for different material, and the cookie jar survives', async () => {
    const transport = new HttpTransport();
    await logonWith(transport, (t) => t.tlsMaterial({ cert: 'ONE', key: 'K' }));
    // biome-ignore lint/suspicious/noExplicitAny: reads the client under test
    const first = (transport as any).client();
    transport.ingest({ 'set-cookie': ['SAP_SESSIONID_X_100=S1; Path=/'] });
    transport.adoptCsrfToken('TOKEN');

    await logonWith(transport, (t) => t.tlsMaterial({ cert: 'TWO', key: 'K' }));

    // biome-ignore lint/suspicious/noExplicitAny: reads the client under test
    const second = (transport as any).client();
    expect(second).not.toBe(first);
    expect(agentOf(transport).options.cert).toBe('TWO');
    expect(transport.cookies()).toBe('SAP_SESSIONID_X_100=S1');
    expect(transport.csrfToken()).toBe('TOKEN');
  });
});

describe('a 401 while establishing', () => {
  it('asks rejected at logon with the status; Ok logs on again and connects', async () => {
    const { conn, rejections } = onPremWith();
    stub.discovery.push(401);

    await conn.connect();

    expect(rejections()).toHaveLength(1);
    expect(rejections()[0]).toMatchObject({ at: 'logon', status: 401 });
    expect(discoveryRequests().map((r) => r.status)).toStrictEqual([401, 200]);
    expect(discoveryRequests()[1].headers.authorization).toBe('Stub 1');
    expect(conn.isConnected()).toBe(true);
  });

  it('logs on once per attempt: the renewed credential meets a fresh logon', async () => {
    const { conn, order } = onPremWith();
    stub.discovery.push(401);

    await conn.connect();

    expect(order().filter((m) => m === 'establish')).toHaveLength(2);
  });

  it('raises the provider’s words at logon when it says no, keeping the wire’s error', async () => {
    const { conn, rejections } = onPremWith({ rejected: [NO] });
    stub.discovery.push(401);

    const error = await conn.connect().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthRefusedError);
    expect((error as AuthRefusedError).at).toBe('logon');
    expect((error as AuthRefusedError).refusal).toStrictEqual(REFUSAL);
    expect(
      ((error as AuthRefusedError).cause as { response?: { status?: number } })
        .response?.status,
    ).toBe(401);
    expect(rejections()).toHaveLength(1);
    expect(conn.isConnected()).toBe(false);
  });

  it('is refused again after Ok: the verdict, and rejected was asked once', async () => {
    const { conn, rejections } = onPremWith();
    stub.discovery.push(401, 401);

    const error = await conn.connect().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthRefusedError);
    expect((error as AuthRefusedError).refusal).toStrictEqual(REFUSED_AGAIN);
    expect((error as AuthRefusedError).at).toBe('logon');
    expect(rejections()).toHaveLength(1);
    expect(conn.isConnected()).toBe(false);
  });

  it('leaves a 500 to the wire’s own retry, and never asks rejected', async () => {
    const { conn, rejections } = onPremWith();
    stub.discovery.push(500);

    await conn.connect();

    expect(rejections()).toHaveLength(0);
    expect(discoveryRequests().map((r) => r.status)).toStrictEqual([500, 200]);
  }, 10000);

  it('lets the provider’s refusal to authorize through untouched, unretried', async () => {
    // authorize says no on the establishing request itself.
    const { conn, rejections } = onPremWith({ authorize: [NO] });

    const error = await conn.connect().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthRefusedError);
    expect((error as AuthRefusedError).at).toBe('request');
    expect(discoveryRequests()).toHaveLength(0);
    expect(rejections()).toHaveLength(0);
  }, 10000);
});

describe('the wire’s establishment', () => {
  it('lets the provider’s refusal to authorize through at once, whatever isFatal says', async () => {
    const transport = new HttpTransport();
    let asked = 0;
    const refusal = new AuthRefusedError(REFUSAL, 'request');

    const error = await transport
      .establish({
        baseUrl: stub.baseUrl,
        authorize: async () => {
          asked += 1;
          throw refusal;
        },
        logon: async () => {},
        observe: () => {},
        retries: 3,
        retryDelayMs: 0,
        isFatal: () => false,
      })
      .catch((e: unknown) => e);

    expect(error).toBe(refusal);
    expect(asked).toBe(1);
  });
});

describe('the goodbye', () => {
  it('is authorized', async () => {
    const { conn, provider } = onPremWith();
    await conn.connect();
    const before = provider.calls.filter(
      (c) => c.method === 'authorize',
    ).length;

    await conn.disconnect();
    await conn.flushGoodbye();

    expect(stub.sentTo(LOGOFF)).toHaveLength(1);
    expect(stub.sentTo(LOGOFF)[0].headers.authorization).toBe('Stub 0');
    expect(
      provider.calls.filter((c) => c.method === 'authorize').length,
    ).toBeGreaterThan(before);
  });

  it('stays silent when the provider will not authorize it', async () => {
    const { conn } = onPremWith({
      authorize: [{ ok: true }, NO],
    });
    await conn.connect();

    await expect(conn.disconnect()).resolves.toBeUndefined();
    await expect(conn.flushGoodbye()).resolves.toBeUndefined();

    expect(stub.sentTo(LOGOFF)).toHaveLength(0);
  });
});

describe('the cloud wire', () => {
  function cloudWith(script: StubScript = {}) {
    const config = {
      url: stub.baseUrl,
      client: '100',
      authType: 'jwt',
    } as SapConfig;
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

    expect(error).toBeInstanceOf(AuthRefusedError);
    expect((error as AuthRefusedError).at).toBe('logon');
    expect(stub.requests).toHaveLength(0);
    expect(provider.calls.map((c) => c.method)).toStrictEqual([
      'prepare',
      'establish',
    ]);
  });

  it('lets a request the provider will not authorize through the preflight', async () => {
    const { conn } = cloudWith({ authorize: [NO, { ok: true }] });

    const error = await conn.connect().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthRefusedError);
    expect((error as AuthRefusedError).at).toBe('request');
    expect(stub.requests).toHaveLength(0);
  });

  it('still swallows a preflight the system fails, as before', async () => {
    const { conn } = cloudWith();
    stub.work('/sap/bc/adt/core/http/sessions', [500]);

    await conn.connect();

    expect(conn.isConnected()).toBe(true);
  });
});
