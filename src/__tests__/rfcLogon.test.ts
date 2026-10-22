/**
 * The RFC wire logs on with what the provider writes.
 *
 * A fake conversation factory records the parameters of every open and refuses
 * chosen ones with a raw error; a stub provider writes the logon parameters.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
import { assertMatchObject } from './helpers/assertions.js';
import { withModule } from './helpers/moduleCache.js';
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

    assert.deepStrictEqual(opens, [{ user: 'U', passwd: 'P' }]);
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

    assert.deepStrictEqual(opens, [snc]);
  });

  it('refuses TLS material in the fixed words', async () => {
    const { factory } = fakeFactory();
    const transport = new RfcTransport(factory, null);
    const seen: AuthOutcome[] = [];

    await transport.open(
      contextOffering((t) => t.tlsMaterial({ cert: 'C', key: 'K' }), seen),
    );

    assert.deepStrictEqual(seen, [
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
    assert.strictEqual(outcome.refusal.kind, 'logon-target');
    assert.deepStrictEqual(outcome.refusal.facts, {
      wire: 'rfc',
      refused: 'tls-material',
    });
    assert.strictEqual(
      outcome.refusal.reason,
      'this wire carries no TLS material (RFC)',
    );
    assert.strictEqual(outcome.refusal.hint, undefined);
  });

  it('throws the raw error inside a WireLogonError when the open fails', async () => {
    const { factory } = fakeFactory(() => RAW);
    const transport = new RfcTransport(factory, null);

    const error = await transport
      .open(contextOffering(writes({ user: 'U' })))
      .catch((e: unknown) => e);

    assert.ok(error instanceof WireLogonError);
    assert.strictEqual((error as WireLogonError).cause, RAW);
    assert.doesNotMatch((error as Error).message, /Failed to open RFC/);
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

    assert.deepStrictEqual(asked, [1, 2]);
    assert.deepStrictEqual(opens, [{ user: 'U1' }, { user: 'U2' }]);
  });

  it('throws the raw error inside a WireLogonError when a per-call open fails', async () => {
    const { factory } = fakeFactory((n) => (n === 2 ? RAW : undefined));
    const transport = new RfcTransport(factory, null);
    await transport.open(contextOffering(writes({ user: 'U' })));

    const error = await transport
      .send({ method: 'GET', url: '/sap/bc/adt/x', headers: {} })
      .catch((e: unknown) => e);

    assert.ok(error instanceof WireLogonError);
    assert.strictEqual((error as WireLogonError).cause, RAW);
  });

  it('can be driven without a lifecycle: open() takes no context', async () => {
    const { factory, opens } = fakeFactory();
    const transport = new RfcTransport(factory, null);

    await transport.open();
    await transport.send({ method: 'GET', url: '/sap/bc/adt/x', headers: {} });

    assert.deepStrictEqual(opens, [{}, {}]);
  });
});

describe('the RFC factory from the config', () => {
  it('spreads the logon over the address', () => {
    const constructed: Record<string, unknown>[] = [];
    withModule(
      '@mcp-abap-adt/sap-rfc-lite',
      {
        Client: class {
          constructor(params: Record<string, unknown>) {
            constructed.push(params);
          }
        },
      },
      () => {
        rfcConversationFrom(config)({ user: 'U', passwd: 'P' });
      },
    );

    assert.deepStrictEqual(constructed, [
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

    assert.strictEqual(rejections().length, 1);
    assertMatchObject(rejections()[0].argument, { at: 'logon' });
    assert.strictEqual(
      (rejections()[0].argument as { error: unknown }).error,
      RAW,
    );
    assert.strictEqual(opens.length, 2);
    assert.strictEqual(conn.isConnected(), true);
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

    assert.ok(error instanceof AuthRefusedError);
    assert.deepStrictEqual((error as AuthRefusedError).refusal, refusal);
    assert.strictEqual((error as AuthRefusedError).at, 'logon');
  });

  it('refused again after Ok is REFUSED_AGAIN', async () => {
    const { conn, rejections } = connectorWith(() => RAW, {
      establish: [writesUser],
    });

    const error = await conn.connect().catch((e: unknown) => e);

    assertMatchObject((error as AuthRefusedError).refusal, REFUSED_AGAIN);
    assertMatchObject((error as AuthRefusedError).refusal, {
      facts: { at: 'logon' },
    });
    assert.strictEqual(rejections().length, 1);
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

    assert.strictEqual(response.status, 200);
    assert.strictEqual(rejections().length, 1);
    assertMatchObject(rejections()[0].argument, { at: 'logon' });
    assert.strictEqual(
      (rejections()[0].argument as { error: unknown }).error,
      RAW,
    );
    assert.ok(opens.length > before);
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

    assert.ok(error instanceof AuthRefusedError);
    assert.deepStrictEqual((error as AuthRefusedError).refusal, refusal);
    assert.strictEqual(rejections().length, 0);
  });
});

describe('an open() that throws instead of rejecting', () => {
  it('is a refused logon, like one that rejects', async () => {
    const transport = new RfcTransport(
      () =>
        ({
          alive: false,
          open: () => {
            throw new Error('the SDK threw at once');
          },
          close: async () => {},
          call: async () => ({}),
        }) as never,
      null,
    );
    await assert.rejects(
      transport.open(),
      (e: unknown) => e instanceof WireLogonError,
    );
  });
});
