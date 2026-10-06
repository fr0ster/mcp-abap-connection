/**
 * The RFC wire logs on with what the provider writes.
 *
 * A fake conversation factory records the parameters of every open and refuses
 * chosen ones with a raw error; a stub provider writes the logon parameters.
 */
import { authError } from '@mcp-abap-adt/auth-errors';
import type { AuthOutcome, ILogonTarget } from '@mcp-abap-adt/interfaces-auth';
import type { SapConfig } from '../config/sapConfig.js';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import { AuthRefusedError, WireLogonError } from '../connection/authErrors.js';
import type { IAdtSessionContext } from '../connection/IAdtTransport.js';
import {
  type IRfcConversation,
  RfcTransport,
} from '../connection/RfcTransport.js';
import { rfcConversationFrom } from '../connection/rfcConversation.js';
import { stubProvider } from './helpers/stubProvider.js';

/** connection's `refused-after-renewal` (I4), whatever the moment. */
const REFUSED_AGAIN = {
  kind: 'connection',
  facts: { problem: 'refused-after-renewal' },
  reason: 'the credential was refused again after the provider renewed it',
};

const OK_RESPONSE = {
  RESPONSE: {
    STATUS_LINE: { STATUS_CODE: 200, REASON_PHRASE: 'OK' },
    HEADER_FIELDS: [],
    MESSAGE_BODY: Buffer.from('<service/>', 'utf-8'),
  },
};

const RAW = Object.assign(new Error('Logon failed: password incorrect'), {
  key: 'RFC_LOGON_FAILURE',
});

const config: SapConfig = {
  url: 'http://saphost:8000',
  authType: 'basic',
  client: '100',
};

/** `refuse` is asked with the 1-based number of the open; a returned error refuses it. */
function fakeFactory(refuse: (n: number) => unknown = () => undefined) {
  const opens: Record<string, string>[] = [];
  let opened = 0;
  const factory = (logon: Readonly<Record<string, string>>) => {
    opens.push({ ...logon });
    const conversation: IRfcConversation = {
      alive: false,
      open: async () => {
        opened += 1;
        const refusal = refuse(opened);
        if (refusal !== undefined) throw refusal;
        (conversation as { alive: boolean }).alive = true;
      },
      close: async () => {
        (conversation as { alive: boolean }).alive = false;
      },
      call: async () => OK_RESPONSE,
    };
    return conversation;
  };
  return { factory, opens };
}

const writes =
  (parameters: Record<string, string>) =>
  (target: ILogonTarget): AuthOutcome =>
    target.logonParameters(parameters);

/** Drives `open(context)` with a context whose logon runs `offer`. */
function contextOffering(
  offer: (target: ILogonTarget) => AuthOutcome,
  seen: AuthOutcome[] = [],
): IAdtSessionContext {
  return {
    baseUrl: 'http://saphost:8000',
    authorize: async () => {},
    logon: async (target) => {
      seen.push(offer(target));
    },
    observe: () => {},
  };
}

describe('the RFC wire opens with what the provider wrote', () => {
  it('puts user and passwd into the open', async () => {
    const { factory, opens } = fakeFactory();
    const transport = new RfcTransport(factory, null);

    await transport.open(contextOffering(writes({ user: 'U', passwd: 'P' })));

    expect(opens).toStrictEqual([{ user: 'U', passwd: 'P' }]);
  });

  it('passes the four SNC keys unchanged', async () => {
    const snc = {
      snc_mode: '1',
      snc_partnername: 'p:CN=SAP',
      snc_qop: '9',
      snc_lib: '/opt/libsapcrypto.so',
    };
    const { factory, opens } = fakeFactory();
    const transport = new RfcTransport(factory, null);

    await transport.open(contextOffering(writes(snc)));

    expect(opens).toStrictEqual([snc]);
  });

  it('refuses TLS material in the fixed words', async () => {
    const { factory } = fakeFactory();
    const transport = new RfcTransport(factory, null);
    const seen: AuthOutcome[] = [];

    await transport.open(
      contextOffering((t) => t.tlsMaterial({ cert: 'C', key: 'K' }), seen),
    );

    expect(seen).toStrictEqual([
      {
        ok: false,
        refusal: authError['logon-target']({
          wire: 'rfc',
          refused: 'tls-material',
        }),
      },
    ]);
    const [outcome] = seen;
    if (outcome === undefined || outcome.ok) {
      throw new Error('expected a refusal');
    }
    expect(outcome.refusal.kind).toBe('logon-target');
    expect(outcome.refusal.facts).toStrictEqual({
      wire: 'rfc',
      refused: 'tls-material',
    });
    expect(outcome.refusal.reason).toBe(
      'this wire carries no TLS material (RFC)',
    );
    expect(outcome.refusal.hint).toBeUndefined();
  });

  it('throws the raw error inside a WireLogonError when the open fails', async () => {
    const { factory } = fakeFactory(() => RAW);
    const transport = new RfcTransport(factory, null);

    const error = await transport
      .open(contextOffering(writes({ user: 'U' })))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WireLogonError);
    expect((error as WireLogonError).cause).toBe(RAW);
    expect((error as Error).message).not.toMatch(/Failed to open RFC/);
  });

  it('logs on once per open: a per-call conversation asks the provider too', async () => {
    const { factory, opens } = fakeFactory();
    const transport = new RfcTransport(factory, null);
    const asked: number[] = [];
    let n = 0;
    await transport.open(
      contextOffering((t) => {
        asked.push(++n);
        return t.logonParameters({ user: `U${n}` });
      }),
    );

    // The fake has no resetServerContext, so a non-stateful call opens its own.
    await transport.send({ method: 'GET', url: '/sap/bc/adt/x', headers: {} });

    expect(asked).toStrictEqual([1, 2]);
    expect(opens).toStrictEqual([{ user: 'U1' }, { user: 'U2' }]);
  });

  it('throws the raw error inside a WireLogonError when a per-call open fails', async () => {
    const { factory } = fakeFactory((n) => (n === 2 ? RAW : undefined));
    const transport = new RfcTransport(factory, null);
    await transport.open(contextOffering(writes({ user: 'U' })));

    const error = await transport
      .send({ method: 'GET', url: '/sap/bc/adt/x', headers: {} })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WireLogonError);
    expect((error as WireLogonError).cause).toBe(RAW);
  });

  it('can be driven without a lifecycle: open() takes no context', async () => {
    const { factory, opens } = fakeFactory();
    const transport = new RfcTransport(factory, null);

    await transport.open();
    await transport.send({ method: 'GET', url: '/sap/bc/adt/x', headers: {} });

    expect(opens).toStrictEqual([{}, {}]);
  });
});

describe('the RFC factory from the config', () => {
  it('spreads the logon over the address', () => {
    const constructed: Record<string, unknown>[] = [];
    jest.doMock(
      '@mcp-abap-adt/sap-rfc-lite',
      () => ({
        Client: class {
          constructor(params: Record<string, unknown>) {
            constructed.push(params);
          }
        },
      }),
      { virtual: true },
    );
    try {
      rfcConversationFrom(config)({ user: 'U', passwd: 'P' });
    } finally {
      jest.dontMock('@mcp-abap-adt/sap-rfc-lite');
    }

    expect(constructed).toStrictEqual([
      {
        ashost: 'saphost',
        sysnr: '00',
        client: '100',
        lang: 'EN',
        user: 'U',
        passwd: 'P',
      },
    ]);
  });
});

describe('through a connector', () => {
  function connectorWith(
    refuse: (n: number) => unknown,
    script: Parameters<typeof stubProvider>[0],
  ) {
    const { factory, opens } = fakeFactory(refuse);
    const provider = stubProvider(script);
    const transport = new RfcTransport(factory, null);
    const conn = new AdtOnPremConnector(config, provider, transport, null);
    const rejections = () =>
      provider.calls.filter((c) => c.method === 'rejected');
    return { conn, provider, opens, rejections };
  }

  const writesUser = (target: ILogonTarget): AuthOutcome =>
    target.logonParameters({ user: 'U', passwd: 'P' });

  it('a refused open at connect goes to rejected at logon with the raw error; Ok opens once more', async () => {
    const { conn, opens, rejections } = connectorWith(
      (n) => (n === 1 ? RAW : undefined),
      { establish: [writesUser] },
    );

    await conn.connect();

    expect(rejections()).toHaveLength(1);
    expect(rejections()[0].argument).toMatchObject({ at: 'logon' });
    expect((rejections()[0].argument as { error: unknown }).error).toBe(RAW);
    expect(opens).toHaveLength(2);
    expect(conn.isConnected()).toBe(true);
  });

  it('an Oops from rejected ends the connect in the provider’s words', async () => {
    const refusal = authError['credential-refused']({
      credential: 'user-password',
    });
    const { conn } = connectorWith(() => RAW, {
      establish: [writesUser],
      rejected: [{ ok: false, refusal }],
    });

    const error = await conn.connect().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthRefusedError);
    expect((error as AuthRefusedError).refusal).toStrictEqual(refusal);
    expect((error as AuthRefusedError).at).toBe('logon');
  });

  it('refused again after Ok is REFUSED_AGAIN', async () => {
    const { conn, rejections } = connectorWith(() => RAW, {
      establish: [writesUser],
    });

    const error = await conn.connect().catch((e: unknown) => e);

    expect((error as AuthRefusedError).refusal).toMatchObject(REFUSED_AGAIN);
    expect(rejections()).toHaveLength(1);
  });

  it('a per-call open refused after connect goes to rejected with the raw error, then one resend answers 200', async () => {
    // Open 1 is the session's; open 2 (connect's per-call requests, if any)
    // is left alone by counting from the connect.
    let armed = false;
    const { conn, opens, rejections } = connectorWith(
      () => {
        if (!armed) return undefined;
        armed = false;
        return RAW;
      },
      { establish: [writesUser] },
    );
    await conn.connect();
    const before = opens.length;
    armed = true;

    const response = await conn.makeAdtRequest({
      url: '/sap/bc/adt/oo/classes/zcl_x',
      method: 'GET',
      timeout: 30000,
    });

    expect(response.status).toBe(200);
    expect(rejections()).toHaveLength(1);
    expect(rejections()[0].argument).toMatchObject({ at: 'logon' });
    expect((rejections()[0].argument as { error: unknown }).error).toBe(RAW);
    expect(opens.length).toBeGreaterThan(before);
  });

  it('an establish Oops ends the connect in its words; rejected is never asked', async () => {
    const refusal = authError['logon-target']({
      wire: 'rfc',
      refused: 'tls-material',
    });
    const { conn, rejections } = connectorWith(() => undefined, {
      establish: [{ ok: false, refusal }],
    });

    const error = await conn.connect().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthRefusedError);
    expect((error as AuthRefusedError).refusal).toStrictEqual(refusal);
    expect(rejections()).toHaveLength(0);
  });
});
