/**
 * `createConnection`: the four combinations that exist, each built from what
 * the caller states; every other combination refused at construction.
 *
 * No network: constructing a connection sends nothing, and the RFC wire loads
 * its SDK only when a conversation is opened.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BasicAuthProvider } from '@mcp-abap-adt/auth-providers';
import type { SapConfig } from '../config/sapConfig.js';
import { AdtCloudConnector } from '../connection/AdtCloudConnector.js';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import { CloudHttpTransport } from '../connection/CloudHttpTransport.js';
import { createConnection } from '../connection/createConnection.js';
import { LegacyOnPremHttpTransport } from '../connection/LegacyOnPremHttpTransport.js';
import { OnPremHttpTransport } from '../connection/OnPremHttpTransport.js';
import { RfcTransport } from '../connection/RfcTransport.js';
import { createConnection as exported } from '../index.js';

const config: SapConfig = {
  url: 'https://sap.example.com:44300',
  authType: 'basic',
  username: 'u',
  password: 'p',
  client: '200',
};
const credential = new BasicAuthProvider('u', 'p');

/** What the HTTP wire was told: its client and base URL. */
function address(transport: unknown) {
  return (transport as { options: { client?: string; baseUrl?: string } })
    .options;
}

describe('createConnection', () => {
  it('is exported from the package index', () => {
    assert.strictEqual(exported, createConnection);
  });

  it('cloud + http: the cloud connector over the cloud HTTP wire', () => {
    const conn = createConnection({
      system: 'cloud',
      transport: 'http',
      config,
      credential,
    });
    assert.ok(conn instanceof AdtCloudConnector);
    assert.ok(conn.transport instanceof CloudHttpTransport);
    assert.strictEqual(conn.transport.kind, new CloudHttpTransport().kind);
    assert.deepStrictEqual(address(conn.transport), {
      client: '200',
      baseUrl: 'https://sap.example.com:44300',
    });
    assert.strictEqual(conn.credential, credential);
  });

  it('onprem + http: the on-prem connector over the on-prem HTTP wire', () => {
    const conn = createConnection({
      system: 'onprem',
      transport: 'http',
      config,
      credential,
    });
    assert.ok(conn instanceof AdtOnPremConnector);
    assert.ok(conn.transport instanceof OnPremHttpTransport);
    assert.ok(!(conn.transport instanceof LegacyOnPremHttpTransport));
    assert.deepStrictEqual(address(conn.transport), {
      client: '200',
      baseUrl: 'https://sap.example.com:44300',
    });
  });

  it('onprem + legacy-http: the on-prem connector over the BASIS 7.40 wire', () => {
    const conn = createConnection({
      system: 'onprem',
      transport: 'legacy-http',
      config,
      credential,
    });
    assert.ok(conn instanceof AdtOnPremConnector);
    assert.ok(conn.transport instanceof LegacyOnPremHttpTransport);
    assert.deepStrictEqual(address(conn.transport), {
      client: '200',
      baseUrl: 'https://sap.example.com:44300',
    });
  });

  it('onprem + rfc: the on-prem connector over the RFC wire, its options passed through', () => {
    const rfcConfig: SapConfig = {
      ...config,
      url: 'http://saphost:8000',
    };
    const options = { logWire: true, maxLoggedBodyChars: 10 };
    const conn = createConnection({
      system: 'onprem',
      transport: 'rfc',
      config: rfcConfig,
      credential,
      rfc: options,
    });
    assert.ok(conn instanceof AdtOnPremConnector);
    assert.ok(conn.transport instanceof RfcTransport);
    assert.strictEqual(conn.transport.kind, 'rfc');
    assert.strictEqual(
      (conn.transport as unknown as { options: unknown }).options,
      options,
    );
  });

  it('passes the agent options, the wire logger and the session id through as given', () => {
    const agentOptions = () => ({ rejectUnauthorized: true });
    const wireLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    const conn = createConnection({
      system: 'onprem',
      transport: 'http',
      config,
      credential,
      agentOptions,
      wireLogger,
      sessionId: 'my-conversation',
    });
    const wire = conn.transport as unknown as {
      agentOptions: unknown;
      logger: unknown;
    };
    assert.strictEqual(wire.agentOptions, agentOptions);
    assert.strictEqual(wire.logger, wireLogger);
    assert.strictEqual(conn.getSessionId(), 'my-conversation');
  });

  for (const [system, transport] of [
    ['cloud', 'rfc'],
    ['cloud', 'legacy-http'],
    ['onprem', 'websocket'],
    ['mainframe', 'http'],
    [undefined, undefined],
  ]) {
    it(`refuses ${system} + ${transport} at construction, in fixed words`, () => {
      assert.throws(
        () =>
          createConnection({ system, transport, config, credential } as never),
        (e: unknown) =>
          (e as Error).message.includes(
            "createConnection: no such combination of system and transport. ABAP Cloud has one wire, 'http'; on-prem takes 'http', 'legacy-http' or 'rfc'. Both are stated by the caller, never inferred.",
          ),
      );
    });
  }

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

  it('infers nothing from the config: connectionType does not pick the wire', () => {
    const conn = createConnection({
      system: 'onprem',
      transport: 'http',
      config: { ...config, connectionType: 'rfc' } as SapConfig,
      credential,
    });
    assert.ok(conn.transport instanceof OnPremHttpTransport);
  });
});
