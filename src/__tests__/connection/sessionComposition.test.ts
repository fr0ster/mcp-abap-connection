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

  // Joining shares the answer, not just the execution. Building the report
  // outside the transition leaves every caller but the first reporting an empty
  // teardown — abandoned locks announced to nobody.
  it('gives concurrent disconnects the same report', async () => {
    const conn = new BaseAbapConnection(configFor(stub.baseUrl), null);
    await conn.connect();
    conn.beginWindow('Class/ZCL_ABANDONED');
    // Never closed: the drain gives up on it and names it.
    (
      conn as unknown as { lifecycle: { drain: () => Promise<unknown> } }
    ).lifecycle.drain = async () => ({
      abandonedWindows: ['Class/ZCL_ABANDONED'],
    });

    const [first, second] = await Promise.all([
      conn.disconnect(),
      conn.disconnect(),
    ]);

    expect(first.abandonedWindows).toStrictEqual(['Class/ZCL_ABANDONED']);
    expect(second).toStrictEqual(first);
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

describe('JwtAbapConnection establishment retry', () => {
  let stub: Stub;

  beforeEach(async () => {
    stub = await startStub();
  });

  afterEach(async () => {
    await stub.close();
  });

  // The retry used to call connect(), which runs the establishment as a
  // joinable transition — so the nested call joined the transition already in
  // flight, which was itself, and waited forever.
  it('does not wait on itself when retrying after a token refresh', async () => {
    const { JwtAbapConnection } = await import(
      '../../connection/JwtAbapConnection.js'
    );
    let refreshed = 0;
    const conn = new JwtAbapConnection(
      {
        url: stub.baseUrl,
        client: '100',
        authType: 'jwt',
        jwtToken: 'STALE',
      } as SapConfig,
      null,
      undefined,
      {
        getToken: async () => 'FRESH',
        refreshToken: async () => {
          refreshed += 1;
          return 'FRESH';
        },
      },
    );

    // First establishment fails with 401, the refresher succeeds, and the retry
    // must run rather than deadlock.
    let attempts = 0;
    (
      conn as unknown as { fetchCsrfToken: (u: string) => Promise<string> }
    ).fetchCsrfToken = async () => {
      attempts += 1;
      if (attempts === 1) {
        // A real AxiosError: the retry path checks `instanceof`, so a lookalike
        // would sail past it and the test would prove nothing.
        const { AxiosError } = await import('axios');
        throw new AxiosError(
          'unauthorized',
          'ERR_BAD_REQUEST',
          undefined,
          null,
          {
            status: 401,
            statusText: 'Unauthorized',
            data: '',
            headers: {},
            // biome-ignore lint/suspicious/noExplicitAny: minimal axios response shape
            config: {} as any,
          },
        );
      }
      return 'TOKEN-AFTER-REFRESH';
    };

    const outcome = await Promise.race([
      conn.connect().then(() => 'settled'),
      new Promise((r) => setTimeout(() => r('hung'), 2000)),
    ]);

    expect(outcome).toBe('settled');
    expect(refreshed).toBe(1);
    expect(attempts).toBe(2);
  });
});

describe('explicit connect is required', () => {
  let stub: Stub;

  beforeEach(async () => {
    stub = await startStub();
  });

  afterEach(async () => {
    await stub.close();
  });

  it('refuses a request when connect() was never called', async () => {
    const conn = new BaseAbapConnection(configFor(stub.baseUrl), null);

    await expect(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/x',
        method: 'GET',
        timeout: 5000,
      }),
    ).rejects.toMatchObject({ code: 'ADT_NOT_CONNECTED' });
    // and nothing reached the server: the refusal is local
    expect(stub.sessions).toStrictEqual([]);
  });

  it('serves requests after connect(), and refuses them after disconnect()', async () => {
    const conn = new BaseAbapConnection(configFor(stub.baseUrl), null);
    await conn.connect();

    await expect(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/x',
        method: 'GET',
        timeout: 5000,
      }),
    ).resolves.toMatchObject({ status: 200 });

    await conn.disconnect();

    await expect(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/x',
        method: 'GET',
        timeout: 5000,
      }),
    ).rejects.toMatchObject({ code: 'ADT_NOT_CONNECTED' });
  });

  // The swallow used to hide this: connect() resolved over a broken system and
  // the failure surfaced later, on a request, as something else entirely.
  it('rejects when the session cannot be established', async () => {
    const conn = new BaseAbapConnection(
      configFor('http://127.0.0.1:1'), // nothing listens there
      null,
    );

    await expect(conn.connect()).rejects.toThrow();
    expect(conn.isConnected()).toBe(false);
  });

  it('lets an in-flight request finish before a teardown clears the session', async () => {
    const conn = new BaseAbapConnection(configFor(stub.baseUrl), null);
    await conn.connect();

    const order: string[] = [];
    const request = conn
      .makeAdtRequest({ url: '/sap/bc/adt/slow', method: 'GET', timeout: 5000 })
      .then(() => order.push('request'));
    const teardown = conn.disconnect().then(() => order.push('teardown'));

    await Promise.all([request, teardown]);

    expect(order).toStrictEqual(['request', 'teardown']);
  });
});

describe('JWT request recovery after a token refresh', () => {
  let stub: Stub;

  beforeEach(async () => {
    stub = await startStub();
  });

  afterEach(async () => {
    await stub.close();
  });

  async function jwtConnection(refreshed: { count: number }) {
    const { JwtAbapConnection } = await import(
      '../../connection/JwtAbapConnection.js'
    );
    return new JwtAbapConnection(
      {
        url: stub.baseUrl,
        client: '100',
        authType: 'jwt',
        jwtToken: 'STALE',
      } as SapConfig,
      null,
      undefined,
      {
        getToken: async () => 'FRESH',
        refreshToken: async () => {
          refreshed.count += 1;
          return 'FRESH';
        },
      },
    );
  }

  // The renewal discards the session, and admission then refuses the retry
  // unless the session is re-established first. Without recoverSession() the
  // request fails with NOT_CONNECTED having never reached the server again.
  it('re-establishes the session and retries, rather than refusing itself', async () => {
    const refreshed = { count: 0 };
    const conn = await jwtConnection(refreshed);
    await conn.connect();

    let attempts = 0;
    const realAxios = (
      conn as unknown as { getAxiosInstance: () => (cfg: unknown) => unknown }
    ).getAxiosInstance.bind(conn);
    (conn as unknown as { getAxiosInstance: () => unknown }).getAxiosInstance =
      () => {
        const instance = realAxios();
        return async (cfg: { url: string }) => {
          if (cfg.url.includes('/sap/bc/adt/work')) {
            attempts += 1;
            if (attempts === 1) {
              const { AxiosError } = await import('axios');
              throw new AxiosError('unauthorized', 'ERR', undefined, null, {
                status: 401,
                statusText: 'Unauthorized',
                data: '',
                headers: {},
                // biome-ignore lint/suspicious/noExplicitAny: minimal shape
                config: {} as any,
              });
            }
          }
          return (instance as (c: unknown) => unknown)(cfg);
        };
      };

    const response = await conn.makeAdtRequest({
      url: '/sap/bc/adt/work',
      method: 'GET',
      timeout: 5000,
    });

    expect(response.status).toBe(200);
    expect(refreshed.count).toBe(1);
    expect(attempts).toBe(2); // the retry actually reached the server
    expect(conn.isConnected()).toBe(true);
    expect(stub.sessions.length).toBeGreaterThan(1); // a NEW session was opened
  });
});
