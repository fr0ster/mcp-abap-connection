/**
 * What a response says about the session, and what the connection does about it.
 *
 * Two things can cost the session mid-flight and neither is visible the same
 * way: a swapped cookie is visible to comparison and invisible to the server's
 * answer; a dead session is the exact opposite — the cookie is unchanged, so
 * only the answer tells. Both must end the same way for a caller holding a lock.
 */
import { createServer, type Server } from 'node:http';
import type { SapConfig } from '../../config/sapConfig.js';
import { BaseAbapConnection } from '../../connection/BaseAbapConnection.js';

interface Stub {
  baseUrl: string;
  /** Set to rotate the session cookie on the next non-discovery response. */
  rotateSession: boolean;
  /** Status the rotating response carries; a replacement counts on any of them. */
  rotateStatus: number;
  /** Set to answer the next non-discovery request as a dead session. */
  deadSession: boolean;
  close(): Promise<void>;
}

async function startStub(): Promise<Stub> {
  const state = {
    rotateSession: false,
    rotateStatus: 200,
    deadSession: false,
    issued: 0,
  };
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url.includes('/discovery')) {
      state.issued += 1;
      res.writeHead(200, {
        'content-type': 'application/atomsvc+xml',
        'x-csrf-token': 'TOKEN',
        'set-cookie': [`SAP_SESSIONID_STUB_100=S${state.issued}; Path=/`],
      });
      res.end('<service/>');
      return;
    }
    if (state.deadSession) {
      // The observed shape: the cookie is untouched, only the answer tells.
      res.writeHead(400, {
        'content-type': 'text/html',
      });
      res.end('<html><body>Session not found</body></html>');
      return;
    }
    if (state.rotateSession) {
      state.rotateSession = false;
      state.issued += 1;
      // The status is the point: a replacement arriving on an ERROR response is
      // just as much a replacement, and the error path used to swallow it.
      res.writeHead(state.rotateStatus, {
        'content-type': 'text/plain',
        'set-cookie': [`SAP_SESSIONID_STUB_100=S${state.issued}; Path=/`],
      });
      res.end('');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get rotateSession() {
      return state.rotateSession;
    },
    set rotateSession(v: boolean) {
      state.rotateSession = v;
    },
    get rotateStatus() {
      return state.rotateStatus;
    },
    set rotateStatus(v: number) {
      state.rotateStatus = v;
    },
    get deadSession() {
      return state.deadSession;
    },
    set deadSession(v: boolean) {
      state.deadSession = v;
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

const get = (conn: BaseAbapConnection, url = '/sap/bc/adt/work') =>
  conn.makeAdtRequest({ url, method: 'GET', timeout: 5000 });

describe('a replaced session cookie', () => {
  let stub: Stub;

  beforeEach(async () => {
    stub = await startStub();
  });

  afterEach(async () => {
    await stub.close();
  });

  it('is fatal', async () => {
    const conn = new BaseAbapConnection(configFor(stub.baseUrl), null);
    await conn.connect();

    stub.rotateSession = true;

    await expect(get(conn)).rejects.toMatchObject({
      code: 'ADT_SESSION_REPLACED',
    });
    // and the session is gone, not merely reported: admission is shut
    expect(conn.isConnected()).toBe(false);
  });

  // An earlier version tolerated a replacement "when no lock is held", deciding
  // from the connection's own lock windows. Those are gone: this layer does not
  // know a lock exists, what object it covers or what would release it, so the
  // rule is written from what it CAN know — the session we were speaking to is
  // not the one we are speaking to now.
  it('is fatal even with nothing obviously at stake', async () => {
    const conn = new BaseAbapConnection(configFor(stub.baseUrl), null);
    await conn.connect();

    stub.rotateSession = true;

    await expect(get(conn)).rejects.toMatchObject({
      code: 'ADT_SESSION_REPLACED',
    });
    expect(conn.isConnected()).toBe(false);
  });

  // The decision must not rest on the wire header either: another handler can
  // flip it back to stateless while a lock is genuinely open, and a batch never
  // sets it at all.
  it('is fatal regardless of the session mode', async () => {
    const conn = new BaseAbapConnection(configFor(stub.baseUrl), null);
    await conn.connect();
    conn.setSessionType('stateless');

    stub.rotateSession = true;

    await expect(get(conn)).rejects.toMatchObject({
      code: 'ADT_SESSION_REPLACED',
    });
  });
});

describe('a replacement arriving on a non-200 response', () => {
  let stub: Stub;

  beforeEach(async () => {
    stub = await startStub();
  });

  afterEach(async () => {
    await stub.close();
  });

  // updateCookiesFromResponse() MUTATES the fingerprint, so a call site that
  // discards its classification absorbs the replacement silently and every
  // later check reads `unchanged`. The error path did exactly that.
  it('is fatal too', async () => {
    const conn = new BaseAbapConnection(configFor(stub.baseUrl), null);
    await conn.connect();

    stub.rotateSession = true;
    stub.rotateStatus = 404;

    await expect(get(conn)).rejects.toMatchObject({
      code: 'ADT_SESSION_REPLACED',
    });
    expect(conn.isConnected()).toBe(false);
  });
});

describe('a session verdict raised during a retry', () => {
  let stub: Stub;

  beforeEach(async () => {
    stub = await startStub();
  });

  afterEach(async () => {
    await stub.close();
  });

  // The CSRF retry catch rethrows the ORIGINAL error, which used to bury a
  // SESSION_REPLACED raised while observing the retry's own response. A caller
  // can retry a 403 itself; it cannot learn from a 403 that its lock is dead.
  it('reaches the caller instead of the error that started the retry', async () => {
    const conn = new BaseAbapConnection(configFor(stub.baseUrl), null);
    await conn.connect();

    let attempts = 0;
    const realAxios = (
      conn as unknown as { getAxiosInstance: () => (cfg: unknown) => unknown }
    ).getAxiosInstance.bind(conn);
    (conn as unknown as { getAxiosInstance: () => unknown }).getAxiosInstance =
      () => {
        const instance = realAxios();
        return async (cfg: { url: string }) => {
          if (!cfg.url.includes('/work')) {
            return (instance as (c: unknown) => unknown)(cfg);
          }
          attempts += 1;
          if (attempts === 1) {
            // A CSRF rejection: the connector refetches the token and retries.
            const { AxiosError } = await import('axios');
            throw new AxiosError('forbidden', 'ERR', undefined, null, {
              status: 403,
              statusText: 'Forbidden',
              data: 'CSRF token validation failed',
              headers: {},
              // biome-ignore lint/suspicious/noExplicitAny: minimal shape
              config: {} as any,
            });
          }
          // …and the retry comes back on a DIFFERENT session.
          return {
            status: 200,
            statusText: 'OK',
            data: '',
            headers: {
              'set-cookie': ['SAP_SESSIONID_STUB_100=S-OTHER; Path=/'],
            },
            config: {},
          };
        };
      };

    await expect(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/work',
        method: 'PUT',
        timeout: 5000,
        data: 'x',
      }),
    ).rejects.toMatchObject({ code: 'ADT_SESSION_REPLACED' });

    // One attempt, not two: the replacement is now detected at the token
    // refetch, before the retry goes out. Sending a write into a session
    // already known to be gone would be the internal retry this design
    // forbids, so stopping earlier is the stricter answer, not a weaker one.
    expect(attempts).toBe(1);
  });
});

describe('a dead session', () => {
  let stub: Stub;

  beforeEach(async () => {
    stub = await startStub();
  });

  afterEach(async () => {
    await stub.close();
  });

  it('is reported as a lost session, with the cookie untouched', async () => {
    const conn = new BaseAbapConnection(configFor(stub.baseUrl), null);
    await conn.connect();
    const identityBefore = conn.getSessionIdentity();

    stub.deadSession = true;

    await expect(get(conn)).rejects.toMatchObject({
      code: 'ADT_SESSION_REPLACED',
    });
    // Comparison could never have seen this: nothing about the cookie changed.
    expect(identityBefore).toBe('SAP_SESSIONID_STUB_100=S1');
    expect(conn.isConnected()).toBe(false);
  });

  it('does not retry the request internally', async () => {
    const conn = new BaseAbapConnection(configFor(stub.baseUrl), null);
    await conn.connect();

    let attempts = 0;
    const realAxios = (
      conn as unknown as { getAxiosInstance: () => (cfg: unknown) => unknown }
    ).getAxiosInstance.bind(conn);
    (conn as unknown as { getAxiosInstance: () => unknown }).getAxiosInstance =
      () => {
        const instance = realAxios();
        return async (cfg: { url: string }) => {
          if (cfg.url.includes('/work')) attempts += 1;
          return (instance as (c: unknown) => unknown)(cfg);
        };
      };

    stub.deadSession = true;
    await expect(get(conn)).rejects.toMatchObject({
      code: 'ADT_SESSION_REPLACED',
    });

    // A blind retry here is what produced further locks in the field.
    expect(attempts).toBe(1);
  });
});
