/**
 * SessionLifecycle composed into an HTTP connection.
 *
 * Runs the real connection against a local stub — no SAP, no credentials — and
 * checks the wiring the unit tests cannot see: that connect() publishes
 * usability only on a real establishment, that the identity comes from the
 * session cookie and ignores the CSRF one, and that a teardown drains before it
 * clears anything.
 *
 * Admission is NOT enforced yet (that is the breaking switch), so a request on
 * an unconnected connection still goes through here.
 */
import { createServer, type Server } from 'node:http';
import type { SapConfig } from '../../config/sapConfig.js';
import { BaseAbapConnection } from '../../connection/BaseAbapConnection.js';

interface Stub {
  baseUrl: string;
  /** Session ids handed out, in order. */
  sessions: string[];
  close(): Promise<void>;
}

async function startStub(): Promise<Stub> {
  const sessions: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url.includes('/discovery')) {
      const id = `S${sessions.length + 1}`;
      sessions.push(id);
      res.writeHead(200, {
        'content-type': 'application/atomsvc+xml',
        'x-csrf-token': `TOKEN-${id}`,
        // Two cookies on purpose: only the session one may reach the identity.
        'set-cookie': [
          `SAP_SESSIONID_STUB_100=${id}; Path=/`,
          `sap-XSRF_STUB_100=X${sessions.length}; Path=/`,
        ],
      });
      res.end('<service/>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('stub did not bind');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    sessions,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}

const configFor = (baseUrl: string): SapConfig => ({
  url: baseUrl,
  client: '100',
  authType: 'basic',
  username: 'STUB',
  password: 'STUB',
});

describe('session lifecycle composed into BaseAbapConnection', () => {
  let stub: Stub;

  beforeEach(async () => {
    stub = await startStub();
  });

  afterEach(async () => {
    await stub.close();
  });

  it('starts disconnected, with no identity', () => {
    const conn = new BaseAbapConnection(configFor(stub.baseUrl), null);
    expect(conn.isConnected()).toBe(false);
    expect(conn.getSessionIdentity()).toBeNull();
  });

  it('publishes usability and the identity after connect()', async () => {
    const conn = new BaseAbapConnection(configFor(stub.baseUrl), null);
    await conn.connect();

    expect(conn.isConnected()).toBe(true);
    expect(conn.getSessionIdentity()).toBe('SAP_SESSIONID_STUB_100=S1');
  });

  // The CSRF cookie changes on a token refresh WITHIN one session, so folding
  // it into the identity would report an ordinary refresh as a new session.
  it('keeps the CSRF cookie out of the identity', async () => {
    const conn = new BaseAbapConnection(configFor(stub.baseUrl), null);
    await conn.connect();

    expect(conn.getSessionIdentity()).not.toContain('XSRF');
  });

  it('establishes once for concurrent connects, and once more is a no-op', async () => {
    const conn = new BaseAbapConnection(configFor(stub.baseUrl), null);

    await Promise.all([conn.connect(), conn.connect()]);
    expect(stub.sessions).toHaveLength(1);

    await conn.connect();
    expect(stub.sessions).toHaveLength(1);
  });

  it('reports not-connected and drops the identity after disconnect()', async () => {
    const conn = new BaseAbapConnection(configFor(stub.baseUrl), null);
    await conn.connect();

    const report = await conn.disconnect();

    expect(report).toStrictEqual({
      abandonedWindows: [],
      releasePending: false,
    });
    expect(conn.isConnected()).toBe(false);
    expect(conn.getSessionIdentity()).toBeNull();
  });

  it('connects again after a disconnect, on a fresh session', async () => {
    const conn = new BaseAbapConnection(configFor(stub.baseUrl), null);
    await conn.connect();
    await conn.disconnect();

    await conn.connect();

    expect(conn.isConnected()).toBe(true);
    expect(conn.getSessionIdentity()).toBe('SAP_SESSIONID_STUB_100=S2');
    expect(stub.sessions).toStrictEqual(['S1', 'S2']);
  });

  it('waits for an open window before tearing down, and reports nothing abandoned', async () => {
    const conn = new BaseAbapConnection(configFor(stub.baseUrl), null);
    await conn.connect();
    const token = conn.beginWindow('Class/ZCL_A');

    const order: string[] = [];
    const teardown = conn.disconnect().then((r) => {
      order.push('disconnected');
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toStrictEqual([]);
    // the session must still be intact while the window finishes
    expect(conn.getSessionIdentity()).toBe('SAP_SESSIONID_STUB_100=S1');

    order.push('window closed');
    conn.endWindow(token);
    const report = await teardown;

    expect(order).toStrictEqual(['window closed', 'disconnected']);
    expect(report.abandonedWindows).toStrictEqual([]);
  });

  it('refuses a new window once a teardown is pending', async () => {
    const conn = new BaseAbapConnection(configFor(stub.baseUrl), null);
    await conn.connect();
    const token = conn.beginWindow('Class/ZCL_A');
    const teardown = conn.disconnect();

    expect(() => conn.beginWindow('Class/ZCL_B')).toThrow(
      expect.objectContaining({ code: 'ADT_NOT_CONNECTED' }),
    );

    conn.endWindow(token);
    await teardown;
  });

  it('leaves the connection unusable when reset() discards the session', async () => {
    const conn = new BaseAbapConnection(configFor(stub.baseUrl), null);
    await conn.connect();

    conn.reset();

    expect(conn.isConnected()).toBe(false);
    // reset() returns immediately; the cleanup it queued settles after
    await new Promise((r) => setTimeout(r, 20));
    expect(conn.getSessionIdentity()).toBeNull();
  });
});
