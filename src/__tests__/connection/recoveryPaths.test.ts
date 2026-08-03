/**
 * The two recovery paths that re-establish a session mid-request.
 *
 * C — a login-form 401 on a mutation while a CSRF token is cached: the
 *     connector invalidates the session and fetches a new one.
 * D — a 401 on a GET: it retries with the cookies it has, or fetches a token
 *     to get some.
 *
 * Neither has any code of its own for the session rules. The claim under test
 * is that they do not need any: whatever they re-establish is observed like any
 * other response, so a replacement is fatal while a lock is held and
 * transparent when none is. An assumption until this file says otherwise.
 */
import { createServer, type Server } from 'node:http';
import type { SapConfig } from '../../config/sapConfig.js';
import { BaseAbapConnection } from '../../connection/BaseAbapConnection.js';

interface Stub {
  baseUrl: string;
  /** Status for the next work request; 401 drives both recovery paths. */
  nextWorkStatus: number;
  /** Body for that response — the login-form shape drives path C. */
  nextWorkBody: string;
  close(): Promise<void>;
}

async function startStub(): Promise<Stub> {
  const state = { nextWorkStatus: 200, nextWorkBody: '', issued: 0 };
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url.includes('/discovery')) {
      state.issued += 1;
      res.writeHead(200, {
        'content-type': 'application/atomsvc+xml',
        'x-csrf-token': `TOKEN-${state.issued}`,
        'set-cookie': [`SAP_SESSIONID_STUB_100=S${state.issued}; Path=/`],
      });
      res.end('<service/>');
      return;
    }
    const status = state.nextWorkStatus;
    const body = state.nextWorkBody;
    state.nextWorkStatus = 200;
    state.nextWorkBody = '';
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get nextWorkStatus() {
      return state.nextWorkStatus;
    },
    set nextWorkStatus(v: number) {
      state.nextWorkStatus = v;
    },
    get nextWorkBody() {
      return state.nextWorkBody;
    },
    set nextWorkBody(v: string) {
      state.nextWorkBody = v;
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

describe('path C — a login-form 401 on a mutation', () => {
  let stub: Stub;

  beforeEach(async () => {
    stub = await startStub();
  });

  afterEach(async () => {
    await stub.close();
  });

  it('recovers transparently when no lock is held', async () => {
    const conn = new BaseAbapConnection(configFor(stub.baseUrl), null);
    await conn.connect();
    expect(conn.getSessionIdentity()).toBe('SAP_SESSIONID_STUB_100=S1');

    stub.nextWorkStatus = 401;
    const response = await conn.makeAdtRequest({
      url: '/sap/bc/adt/work',
      method: 'PUT',
      timeout: 5000,
      data: 'x',
    });

    expect(response.status).toBe(200);
    // A new session was established, and it is not a "replacement": WE
    // discarded the old one. invalidateSession() drops the tracked identity
    // with the cookies, so the next fingerprint reads as established rather
    // than as a session taken from under us — which, since a replacement is now
    // always fatal, would otherwise make our own re-authentication tear the
    // connection down. The pair of tests here used to differ only by whether a
    // lock window was open; with windows gone the distinction that survives is
    // "did we cause this".
    expect(conn.getSessionIdentity()).toBe('SAP_SESSIONID_STUB_100=S2');
    expect(conn.isConnected()).toBe(true);
  });
});

describe('path D — a 401 on a GET', () => {
  let stub: Stub;

  beforeEach(async () => {
    stub = await startStub();
  });

  afterEach(async () => {
    await stub.close();
  });

  // The first branch retries with the cookies already held: same session, so
  // nothing to report.
  it('retries on the same session when it still has cookies', async () => {
    const conn = new BaseAbapConnection(configFor(stub.baseUrl), null);
    await conn.connect();

    stub.nextWorkStatus = 401;
    const response = await conn.makeAdtRequest({
      url: '/sap/bc/adt/work',
      method: 'GET',
      timeout: 5000,
    });

    expect(response.status).toBe(200);
    expect(conn.getSessionIdentity()).toBe('SAP_SESSIONID_STUB_100=S1');
    expect(conn.isConnected()).toBe(true);
  });
});
