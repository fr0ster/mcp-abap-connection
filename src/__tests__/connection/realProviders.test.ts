/**
 * The contract over the real providers.
 *
 * `@mcp-abap-adt/auth-providers` writes the providers this connection serves;
 * these cases run them through the connection, HTTP against the local SAP stub
 * and RFC against a fake conversation, and nothing here branches on which
 * provider it is: a case is a provider, a wire and what should happen, and the
 * one body runs them all.
 */
import {
  BasicAuthProvider,
  CertificateAuthProvider,
  type ISncLibraryLocator,
  SncLogonProvider,
  TokenAuthProvider,
} from '@mcp-abap-adt/auth-providers';
import type { IAuthProvider } from '@mcp-abap-adt/interfaces-auth';
import type { SapConfig } from '../../config/sapConfig.js';
import { AdtOnPremConnector } from '../../connection/AdtOnPremConnector.js';
import { AuthRefusedError } from '../../connection/authErrors.js';
import { OnPremHttpTransport } from '../../connection/OnPremHttpTransport.js';
import {
  type IRfcConversation,
  RfcTransport,
} from '../../connection/RfcTransport.js';
import { type SapStub, startSapStub } from '../helpers/sapStub.js';

const WORK = '/sap/bc/adt/work';

// ── HTTP ────────────────────────────────────────────────────────────────────

let stub: SapStub;

beforeEach(async () => {
  stub = await startSapStub();
});

afterEach(async () => {
  await stub.close();
});

async function overHttp(provider: IAuthProvider) {
  const config = {
    url: stub.baseUrl,
    client: '100',
    authType: 'basic',
  } as SapConfig;
  const transport = new OnPremHttpTransport(() => ({}), null, {
    client: '100',
    baseUrl: stub.baseUrl,
  });
  const conn = new AdtOnPremConnector(config, provider, transport, null);
  await conn.connect();
  return { conn, transport };
}

const getWork = (conn: AdtOnPremConnector) =>
  conn.makeAdtRequest({ url: WORK, method: 'GET', timeout: 5000 });

const BASIC = `Basic ${Buffer.from('DEVELOPER:secret').toString('base64')}`;

const httpCases: {
  name: string;
  provider: () => IAuthProvider;
  header: string;
  refusal: string;
}[] = [
  {
    name: 'basic',
    provider: () => new BasicAuthProvider('DEVELOPER', 'secret'),
    header: BASIC,
    refusal: 'the user or password was refused',
  },
  {
    name: 'a fixed token',
    provider: () => TokenAuthProvider.fixed('T-1'),
    header: 'Bearer T-1',
    refusal: 'the token was refused',
  },
];

describe.each(httpCases)('over HTTP: $name', (c) => {
  it('connects, and the work request carries its header', async () => {
    const { conn } = await overHttp(c.provider());

    const response = await getWork(conn);

    expect(response.status).toBe(200);
    const sent = stub.sentTo(WORK);
    expect(sent).toHaveLength(1);
    expect(sent[0].headers.authorization).toBe(c.header);
  });

  it('three 401s end in the provider’s own refusal', async () => {
    const { conn } = await overHttp(c.provider());
    stub.work(WORK, [401, 401, 401]);

    const error = await getWork(conn).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthRefusedError);
    expect((error as AuthRefusedError).at).toBe('request');
    expect((error as AuthRefusedError).refusal.reason).toBe(c.refusal);
  });
});

describe('over HTTP: a certificate', () => {
  it('its material reaches the agent at logon', async () => {
    const provider = new CertificateAuthProvider(
      {
        load: async () => ({
          cert: 'THE-CERT',
          key: 'THE-KEY',
          passphrase: 'pp',
        }),
      },
      {} as never,
    );

    const { transport } = await overHttp(provider);

    const agent = (transport as any).client().defaults.httpsAgent as {
      options: Record<string, unknown>;
    };
    expect(agent.options.cert).toBe('THE-CERT');
    expect(agent.options.key).toBe('THE-KEY');
    expect(agent.options.passphrase).toBe('pp');
  });
});

describe('over HTTP: a token renewed through refreshToken', () => {
  it('asks the refresher once, and the one resend carries the new token', async () => {
    let current = 'OLD';
    let refreshes = 0;
    const provider = TokenAuthProvider.from({
      getToken: async () => current,
      refreshToken: async () => {
        refreshes += 1;
        current = 'NEW';
        return current;
      },
    });
    const { conn } = await overHttp(provider);
    // The wire retries a GET 401 itself once, so two 401s reach the provider.
    stub.work(WORK, [401, 401]);

    const response = await getWork(conn);

    expect(response.status).toBe(200);
    expect(refreshes).toBe(1);
    const sent = stub.sentTo(WORK);
    expect(sent).toHaveLength(3);
    expect(sent[0].headers.authorization).toBe('Bearer OLD');
    expect(sent[2].headers.authorization).toBe('Bearer NEW');
  });
});

// ── RFC ─────────────────────────────────────────────────────────────────────

const rfcConfig: SapConfig = {
  url: 'http://saphost:8000',
  authType: 'basic',
  client: '100',
};

const OK_RESPONSE = {
  RESPONSE: {
    STATUS_LINE: { STATUS_CODE: 200, REASON_PHRASE: 'OK' },
    HEADER_FIELDS: [],
    MESSAGE_BODY: Buffer.from('<service/>', 'utf-8'),
  },
};

const LOGON_FAILURE = Object.assign(new Error('Logon failed'), {
  key: 'RFC_LOGON_FAILURE',
});
const NO_SNC_CREDENTIAL = Object.assign(
  new Error('Initialization of the SNC failed: GSS-API(maj): A2200019'),
  { key: 'RFC_COMMUNICATION_FAILURE' },
);

/** An RFC that refuses an open when `refuse(logon)` returns an error. */
function overRfc(
  provider: IAuthProvider,
  refuse: (logon: Record<string, string>) => unknown = () => undefined,
) {
  const opens: Record<string, string>[] = [];
  const transport = new RfcTransport((logon) => {
    const seen = { ...logon };
    opens.push(seen);
    const conversation: IRfcConversation = {
      alive: false,
      open: async () => {
        const refusal = refuse(seen);
        if (refusal !== undefined) throw refusal;
        (conversation as { alive: boolean }).alive = true;
      },
      close: async () => {
        (conversation as { alive: boolean }).alive = false;
      },
      call: async () => OK_RESPONSE,
    };
    return conversation;
  }, null);
  const conn = new AdtOnPremConnector(rfcConfig, provider, transport, null);
  return { conn, opens };
}

const locator: ISncLibraryLocator = {
  locate: async () => ({ path: '/opt/libsapcrypto.so', archs: ['x64'] }),
};

/** Refuses an open that carries neither a user nor SNC, as the SDK does. */
const wantsLogon = (logon: Record<string, string>) =>
  logon.user === undefined && logon.snc_mode === undefined
    ? LOGON_FAILURE
    : undefined;

describe('over RFC', () => {
  it('basic: the open gets user and passwd', async () => {
    const { conn, opens } = overRfc(new BasicAuthProvider('DEVELOPER', 'pw'));

    await conn.connect();

    expect(opens[0]).toStrictEqual({ user: 'DEVELOPER', passwd: 'pw' });
  });

  it('basic: a refused open ends in “the user or password was refused”', async () => {
    const { conn } = overRfc(
      new BasicAuthProvider('DEVELOPER', 'wrong'),
      () => LOGON_FAILURE,
    );

    const error = await conn.connect().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthRefusedError);
    expect((error as AuthRefusedError).at).toBe('logon');
    expect((error as AuthRefusedError).refusal.reason).toBe(
      'the user or password was refused',
    );
  });

  it('a certificate is refused at logon in its words: this wire carries no TLS material', async () => {
    const provider = new CertificateAuthProvider(
      { load: async () => ({ cert: 'C', key: 'K' }) },
      {} as never,
    );
    const { conn, opens } = overRfc(provider);

    const error = await conn.connect().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthRefusedError);
    expect((error as AuthRefusedError).refusal.reason).toBe(
      'this wire carries no TLS material (RFC)',
    );
    expect(opens).toHaveLength(0);
  });

  it('a bearer token: the open gets no parameters, and the connect ends in AuthRefusedError', async () => {
    const { conn, opens } = overRfc(TokenAuthProvider.fixed('T-1'), wantsLogon);

    const error = await conn.connect().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthRefusedError);
    expect(opens.length).toBeGreaterThan(0);
    for (const open of opens) expect(open).toStrictEqual({});
  });

  it('SNC: the open gets the four keys, and snc_myname when given', async () => {
    const provider = new SncLogonProvider({
      partnerName: 'p:CN=SAP',
      myName: 'p:CN=ME',
      locator,
      probes: [],
    });
    const { conn, opens } = overRfc(provider);

    await conn.connect();

    expect(opens[0]).toStrictEqual({
      snc_mode: '1',
      snc_partnername: 'p:CN=SAP',
      snc_qop: '9',
      snc_lib: '/opt/libsapcrypto.so',
      snc_myname: 'p:CN=ME',
    });
  });

  it('SNC: without myName there is no snc_myname, and the qop given is passed', async () => {
    const provider = new SncLogonProvider({
      partnerName: 'p:CN=SAP',
      qop: '3',
      locator,
      probes: [],
    });
    const { conn, opens } = overRfc(provider);

    await conn.connect();

    expect(opens[0]).toStrictEqual({
      snc_mode: '1',
      snc_partnername: 'p:CN=SAP',
      snc_qop: '3',
      snc_lib: '/opt/libsapcrypto.so',
    });
  });

  it('SNC: a refused open with A2200019 is explained in the provider’s words, from the raw SDK error', async () => {
    const provider = new SncLogonProvider({
      partnerName: 'p:CN=SAP',
      locator,
      probes: [],
    });
    const { conn } = overRfc(provider, () => NO_SNC_CREDENTIAL);

    const error = await conn.connect().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthRefusedError);
    expect((error as AuthRefusedError).at).toBe('logon');
    expect((error as AuthRefusedError).refusal.reason).toBe(
      'the SNC library has no credential to present (A2200019)',
    );
  });
});
