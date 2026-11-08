/**
 * `createConnection`: the four combinations that exist, each built from what
 * the caller states; every other combination refused at construction.
 *
 * No network: constructing a connection sends nothing, and the RFC wire loads
 * its SDK only when a conversation is opened.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';
import { BasicAuthProvider } from '@mcp-abap-adt/auth-providers';
import type {
  ISapHttpConfig,
  ISapRfcConfig,
} from '@mcp-abap-adt/interfaces-auth-sap';
import { AdtCloudConnector } from '../connection/AdtCloudConnector.js';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import { CloudHttpTransport } from '../connection/CloudHttpTransport.js';
import { createConnection } from '../connection/createConnection.js';
import { LegacyOnPremHttpTransport } from '../connection/LegacyOnPremHttpTransport.js';
import { OnPremHttpTransport } from '../connection/OnPremHttpTransport.js';
import {
  type IRfcConversation,
  RfcTransport,
} from '../connection/RfcTransport.js';
import { createConnection as exported } from '../index.js';
import { assertMatchObject } from './helpers/assertions.js';
import { withModuleAsync } from './helpers/moduleCache.js';
import { type SapStub, startSapStub } from './helpers/sapStub.js';

/** The SDK's client, standing in: opens, answers every call 200, closes. */
class AnsweringConversation implements IRfcConversation {
  alive = false;
  async open(): Promise<void> {
    this.alive = true;
  }
  async close(): Promise<void> {
    this.alive = false;
  }
  async call(): Promise<Record<string, unknown>> {
    return {
      RESPONSE: {
        STATUS_LINE: { STATUS_CODE: 200, REASON_PHRASE: 'OK' },
        HEADER_FIELDS: [],
        MESSAGE_BODY: Buffer.from('<ok/>', 'utf-8'),
      },
    };
  }
}

const config: ISapHttpConfig = {
  url: 'https://sap.example.com:44300',
  authType: 'basic',
  username: 'u',
  password: 'p',
  client: '200',
};
const credential = new BasicAuthProvider('u', 'p');

/** An RFC destination: its address stated, no URL. */
const rfcConfig: ISapRfcConfig = {
  connectionType: 'rfc',
  authType: 'basic',
  ashost: 'saphost',
  sysnr: '00',
  client: '200',
  language: 'EN',
};

let stand: SapStub;
before(async () => {
  stand = await startSapStub();
});
after(async () => {
  await stand.close();
});

/** The stand's address, as a config's URL. */
const atStand = (): ISapHttpConfig => ({ ...config, url: stand.baseUrl });

/**
 * What the HTTP wire was told, seen where it shows: a path it sends reaches
 * the config's URL, carrying the config's client.
 */
async function assertAddressed(transport: {
  send: (request: { method: string; url: string }) => Promise<unknown>;
}): Promise<void> {
  stand.requests.length = 0;
  await transport.send({ method: 'GET', url: '/sap/bc/adt/x' });
  assertMatchObject(
    stand.requests.map((request) => ({
      path: request.path,
      client: request.headers['sap-client'],
    })),
    [{ path: '/sap/bc/adt/x', client: '200' }],
  );
}

describe('createConnection', () => {
  it('is exported from the package index', () => {
    assert.strictEqual(exported, createConnection);
  });

  it('cloud + http: the cloud connector over the cloud HTTP wire', async () => {
    const conn = createConnection({
      system: 'cloud',
      transport: 'http',
      config: atStand(),
      credential,
    });
    assert.ok(conn instanceof AdtCloudConnector);
    assert.ok(conn.transport instanceof CloudHttpTransport);
    assert.strictEqual(
      conn.transport.kind,
      new CloudHttpTransport(undefined, null, { baseUrl: 'https://h' }).kind,
    );
    await assertAddressed(conn.transport);
    assert.strictEqual(conn.credential, credential);
  });

  it('onprem + http: the on-prem connector over the on-prem HTTP wire', async () => {
    const conn = createConnection({
      system: 'onprem',
      transport: 'http',
      config: atStand(),
      credential,
    });
    assert.ok(conn instanceof AdtOnPremConnector);
    assert.ok(conn.transport instanceof OnPremHttpTransport);
    assert.ok(!(conn.transport instanceof LegacyOnPremHttpTransport));
    await assertAddressed(conn.transport);
  });

  it('onprem + legacy-http: the on-prem connector over the BASIS 7.40 wire', async () => {
    const conn = createConnection({
      system: 'onprem',
      transport: 'legacy-http',
      config: atStand(),
      credential,
    });
    assert.ok(conn instanceof AdtOnPremConnector);
    assert.ok(conn.transport instanceof LegacyOnPremHttpTransport);
    await assertAddressed(conn.transport);
  });

  it('onprem + rfc: the on-prem connector over the RFC wire, its options passed through', async () => {
    // The options show in what the wire logs: `logWire` adds the body line,
    // `maxLoggedBodyChars` clips it.
    const lines: string[] = [];
    const record = (message: string) => {
      lines.push(message);
    };
    const conn = createConnection({
      system: 'onprem',
      transport: 'rfc',
      config: rfcConfig,
      credential,
      wireLogger: { debug: record, info: record, warn: record, error: record },
      rfc: { logWire: true, maxLoggedBodyChars: 10 },
    });
    assert.ok(conn instanceof AdtOnPremConnector);
    assert.ok(conn.transport instanceof RfcTransport);
    assert.strictEqual(conn.transport.kind, 'rfc');

    await withModuleAsync(
      '@mcp-abap-adt/sap-rfc-lite',
      { Client: AnsweringConversation },
      async () => {
        await conn.connect();
        await conn.makeAdtRequest({
          url: '/sap/bc/adt/x',
          method: 'POST',
          timeout: 1000,
          data: 'x'.repeat(50),
        });
      },
    );

    const body = lines.find((line) => line.startsWith('RFC BODY (50 chars): '));
    assert.ok(body, 'logWire: the body line');
    assert.ok(body.includes('x'.repeat(10)));
    assert.ok(!body.includes('x'.repeat(11)), 'clipped at 10');
  });

  it('passes the agent options, the wire logger and the session id through as given', async () => {
    // Seen where each shows: the wire asks the agent options when it builds
    // its client, and says on its own logger that verification is off.
    const agentOptions = mock.fn(() => ({ rejectUnauthorized: false }));
    const wireLines: string[] = [];
    const record = (message: string) => {
      wireLines.push(message);
    };
    const conn = createConnection({
      system: 'onprem',
      transport: 'http',
      config: atStand(),
      credential,
      agentOptions,
      wireLogger: { debug: record, info: record, warn: record, error: record },
      sessionId: 'my-conversation',
    });

    await conn.transport.send({ method: 'GET', url: '/sap/bc/adt/x' });

    assert.strictEqual(agentOptions.mock.callCount(), 1);
    assert.ok(
      wireLines.includes(
        'TLS: the server certificate is not verified (explicit opt-out)',
      ),
    );
    assert.strictEqual(conn.getSessionId(), 'my-conversation');
  });

  it('admits no other combination of system and transport (checked by compiling)', () => {
    // Never run: each call below must not compile, and the build fails the
    // moment one does.
    const noOtherCombination = () => {
      // @ts-expect-error ABAP Cloud has one wire, 'http'
      createConnection({
        system: 'cloud',
        transport: 'rfc',
        config: rfcConfig,
        credential,
      });
      // @ts-expect-error ABAP Cloud has no BASIS 7.40 wire
      createConnection({
        system: 'cloud',
        transport: 'legacy-http',
        config,
        credential,
      });
      createConnection({
        system: 'onprem',
        // @ts-expect-error no such wire
        transport: 'websocket',
        config,
        credential,
      });
      createConnection({
        // @ts-expect-error no such system
        system: 'mainframe',
        transport: 'http',
        config,
        credential,
      });
      // @ts-expect-error neither stated
      createConnection({ config, credential });
    };
    assert.strictEqual(typeof noOtherCombination, 'function');
  });

  it('gives a new instance, with a wire of its own, on every call', () => {
    const spec = {
      system: 'onprem',
      transport: 'http',
      config,
      credential,
    } as const;
    const first = createConnection(spec);
    const second = createConnection(spec);
    assert.notStrictEqual(second, first);
    assert.notStrictEqual(second.transport, first.transport);
  });
});

describe('the base URL a created connection answers', () => {
  it('cloud + http: the origin of the configured URL', async () => {
    const conn = createConnection({
      system: 'cloud',
      transport: 'http',
      config: { ...config, url: 'https://sap.example.com:44300/some/path' },
      credential,
    });
    assert.strictEqual(
      await conn.getBaseUrl(),
      'https://sap.example.com:44300',
    );
  });

  it('onprem + http: the origin of the configured URL', async () => {
    const conn = createConnection({
      system: 'onprem',
      transport: 'http',
      config,
      credential,
    });
    assert.strictEqual(
      await conn.getBaseUrl(),
      'https://sap.example.com:44300',
    );
  });

  it('onprem + legacy-http: the origin of the configured URL', async () => {
    const conn = createConnection({
      system: 'onprem',
      transport: 'legacy-http',
      config,
      credential,
    });
    assert.strictEqual(
      await conn.getBaseUrl(),
      'https://sap.example.com:44300',
    );
  });

  it('onprem + rfc: undefined, from a config that states no URL', async () => {
    const conn = createConnection({
      system: 'onprem',
      transport: 'rfc',
      config: rfcConfig,
      credential,
    });
    assert.strictEqual(await conn.getBaseUrl(), undefined);
  });
});
