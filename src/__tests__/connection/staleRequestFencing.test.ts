/**
 * A request that outlives its session must not act on the next one.
 *
 * Removing the teardown's wait made this ordinary: a request issued before a
 * `disconnect()` can settle after a later `connect()` has established a fresh
 * session. Fencing the response headers alone is not enough — everything on the
 * error path acts on the CONNECTION, not on the request, and each of these three
 * shapes reaches a different part of it.
 *
 * No SAP: a local stub, and the request is held open until the test says so.
 */
import { createServer, type Server } from 'node:http';
import type { SapConfig } from '../../config/sapConfig.js';
import { BaseAbapConnection } from '../../connection/BaseAbapConnection.js';

interface Stub {
  baseUrl: string;
  sessions: string[];
  /** Status the held /work request answers with once released. */
  workStatus: number;
  /** Body for that answer — a CSRF complaint or a dead-session message. */
  workBody: string;
  workHeaders: Record<string, string>;
  close(): Promise<void>;
}

async function startStub(): Promise<Stub> {
  const sessions: string[] = [];
  const stub = {
    workStatus: 200,
    workBody: '',
    workHeaders: {} as Record<string, string>,
  };
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url.includes('/discovery')) {
      const id = `S${sessions.length + 1}`;
      sessions.push(id);
      res.writeHead(200, {
        'content-type': 'application/atomsvc+xml',
        'x-csrf-token': `TOKEN-${id}`,
        'set-cookie': [`SAP_SESSIONID_STUB_100=${id}; Path=/`],
      });
      res.end('<service/>');
      return;
    }
    res.writeHead(stub.workStatus, {
      'content-type': 'text/plain',
      ...stub.workHeaders,
    });
    res.end(stub.workBody);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    sessions,
    get workStatus() {
      return stub.workStatus;
    },
    set workStatus(v: number) {
      stub.workStatus = v;
    },
    get workBody() {
      return stub.workBody;
    },
    set workBody(v: string) {
      stub.workBody = v;
    },
    get workHeaders() {
      return stub.workHeaders;
    },
    set workHeaders(v: Record<string, string>) {
      stub.workHeaders = v;
    },
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

/** Holds any /work request until the returned release() is called. */
function holdWork(conn: BaseAbapConnection) {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const real = (
    conn as unknown as { getAxiosInstance: () => (cfg: unknown) => unknown }
  ).getAxiosInstance.bind(conn);
  (conn as unknown as { getAxiosInstance: () => unknown }).getAxiosInstance =
    () => {
      const instance = real();
      return async (cfg: { url: string }) => {
        if (cfg.url.includes('/work')) await held;
        return (instance as (c: unknown) => unknown)(cfg);
      };
    };
  return release;
}

describe('a request that settles after its session was replaced', () => {
  let stub: Stub;

  beforeEach(async () => {
    stub = await startStub();
  });

  afterEach(async () => {
    await stub.close();
  });

  /**
   * Sets up the dangerous ordering: request issued on S1, held; disconnect;
   * connect (S2); then the request is let go and answers with `status`.
   */
  async function staleRequest(status: number, body: string, method = 'GET') {
    const conn = new BaseAbapConnection(configFor(stub.baseUrl), null);
    await conn.connect();

    const release = holdWork(conn);
    const inFlight = conn
      .makeAdtRequest({
        url: '/sap/bc/adt/work',
        method: method as 'GET',
        timeout: 5000,
        ...(method === 'GET' ? {} : { data: 'x' }),
      })
      .catch((e) => e);

    await new Promise((r) => setTimeout(r, 10));
    await conn.disconnect();
    await conn.connect();
    expect(stub.sessions).toStrictEqual(['S1', 'S2']);

    stub.workStatus = status;
    stub.workBody = body;
    release();
    await inFlight;
    return conn;
  }

  // The identity comparison cannot see this one: the cookie is unchanged, so
  // only the state can tell — and acting on it would tear down S2 because S1
  // is gone, which it is, and which is no longer anybody's problem.
  it('does not raise a session-lost teardown from a dead-session answer', async () => {
    const conn = await staleRequest(400, 'Session not found');

    expect(conn.isConnected()).toBe(true);
    expect(conn.getSessionIdentity()).toBe('SAP_SESSIONID_STUB_100=S2');
  });

  // The 403 path calls invalidateSession(), fetches a token and RETRIES. On a
  // stale request that means clearing the live session's state and re-issuing
  // its work inside it.
  it('does not invalidate or refetch on a late CSRF complaint', async () => {
    const conn = await staleRequest(403, 'CSRF token validation failed', 'PUT');

    expect(conn.isConnected()).toBe(true);
    // Exactly the two the connects made: no third /discovery, so nothing went
    // looking for a fresh token on the live session's behalf.
    expect(stub.sessions).toStrictEqual(['S1', 'S2']);
    expect(conn.getSessionIdentity()).toBe('SAP_SESSIONID_STUB_100=S2');
  });

  // The worst of the three: a mutation from a dead session replayed inside the
  // live one. The retry would go out on the CURRENT axios instance, with the
  // current cookies, and the server would see a legitimate-looking write.
  it('does not replay a stale mutation in the new session', async () => {
    const conn = await staleRequest(401, 'unauthorized', 'PUT');

    expect(conn.isConnected()).toBe(true);
    expect(stub.sessions).toStrictEqual(['S1', 'S2']);
  });
});
