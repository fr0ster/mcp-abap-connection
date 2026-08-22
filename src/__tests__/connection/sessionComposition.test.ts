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
import { TokenAuthProvider } from '../../auth/providers.js';
import type { SapConfig } from '../../config/sapConfig.js';
import { AdtCloudConnector } from '../../connection/AdtCloudConnector.js';
import type { AdtOnPremConnector } from '../../connection/AdtOnPremConnector.js';
import { onPrem } from '../helpers/onPrem.js';

interface Stub {
  baseUrl: string;
  /** Session ids handed out, in order. */
  sessions: string[];
  /** While true, /discovery answers 401 — a stale credential, from the server. */
  rejectDiscovery: boolean;
  /** How many times /discovery was asked, refusals included. */
  readonly discoveryAttempts: number;
  close(): Promise<void>;
}

async function startStub(): Promise<Stub> {
  const sessions: string[] = [];
  const state = { rejectDiscovery: false, discoveryAttempts: 0 };
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url.includes('/discovery')) {
      state.discoveryAttempts += 1;
      if (state.rejectDiscovery) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('unauthorized');
        return;
      }
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
    // Actually slow, so "does not wait for an in-flight request" tests the
    // claim rather than the absence of I/O in disconnect(): every route used to
    // answer instantly, which made the ordering hold for the wrong reason.
    if (url.includes('/slow')) {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('');
      }, 300);
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
    get rejectDiscovery() {
      return state.rejectDiscovery;
    },
    set rejectDiscovery(v: boolean) {
      state.rejectDiscovery = v;
    },
    get discoveryAttempts() {
      return state.discoveryAttempts;
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

describe('session lifecycle composed into AdtOnPremConnector', () => {
  let stub: Stub;

  beforeEach(async () => {
    stub = await startStub();
  });

  afterEach(async () => {
    await stub.close();
  });

  it('starts disconnected, with no identity', () => {
    const conn = onPrem(configFor(stub.baseUrl), null);
    expect(conn.isConnected()).toBe(false);
    expect(conn.getSessionIdentity()).toBeNull();
  });

  it('publishes usability and the identity after connect()', async () => {
    const conn = onPrem(configFor(stub.baseUrl), null);
    await conn.connect();

    expect(conn.isConnected()).toBe(true);
    expect(conn.getSessionIdentity()).toBe('SAP_SESSIONID_STUB_100=S1');
  });

  // The CSRF cookie changes on a token refresh WITHIN one session, so folding
  // it into the identity would report an ordinary refresh as a new session.
  it('keeps the CSRF cookie out of the identity', async () => {
    const conn = onPrem(configFor(stub.baseUrl), null);
    await conn.connect();

    expect(conn.getSessionIdentity()).not.toContain('XSRF');
  });

  it('establishes once for concurrent connects, and once more is a no-op', async () => {
    const conn = onPrem(configFor(stub.baseUrl), null);

    await Promise.all([conn.connect(), conn.connect()]);
    expect(stub.sessions).toHaveLength(1);

    await conn.connect();
    expect(stub.sessions).toHaveLength(1);
  });

  it('reports not-connected and drops the identity after disconnect()', async () => {
    const conn = onPrem(configFor(stub.baseUrl), null);
    await conn.connect();

    await conn.disconnect();
    expect(conn.isConnected()).toBe(false);
    expect(conn.getSessionIdentity()).toBeNull();
  });

  it('connects again after a disconnect, on a fresh session', async () => {
    const conn = onPrem(configFor(stub.baseUrl), null);
    await conn.connect();
    await conn.disconnect();

    await conn.connect();

    expect(conn.isConnected()).toBe(true);
    expect(conn.getSessionIdentity()).toBe('SAP_SESSIONID_STUB_100=S2');
    expect(stub.sessions).toStrictEqual(['S1', 'S2']);
  });

  // Joining shares the answer, not just the execution. Building the report
  // outside the transition leaves every caller but the first reporting an empty
  // teardown — abandoned locks announced to nobody.
  it('tears down once for concurrent disconnects', async () => {
    const conn = onPrem(configFor(stub.baseUrl), null);
    await conn.connect();

    let cleared = 0;
    const realClear = (
      conn as unknown as { clearSessionState: () => void }
    ).clearSessionState.bind(conn);
    (conn as unknown as { clearSessionState: () => void }).clearSessionState =
      () => {
        cleared += 1;
        realClear();
      };

    await Promise.all([conn.disconnect(), conn.disconnect()]);

    // Callers of one kind join the tail, so the body runs once. There is no
    // report to share any more — a teardown that waits for nothing has nothing
    // to tell anyone.
    expect(cleared).toBe(1);
    expect(conn.isConnected()).toBe(false);
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

  // Two hazards live here, and the second replaced the first.
  //
  // The retry used to be establishSession calling itself after refreshing, and
  // an earlier version of it called connect() — which runs the establishment as
  // a joinable transition, so the nested call joined the one already in flight,
  // which was itself, and waited forever.
  //
  // establishSession no longer refreshes at all: fetchCsrfToken owns that, and
  // owns it alone (issue #30). So the subject is the same — an establishment
  // recovers from a 401 by refreshing once and finishing, rather than hanging —
  // but the owner has moved, and this test follows it.
  //
  // The 401 comes from the stub, not from a stubbed fetchCsrfToken. The earlier
  // version replaced fetchCsrfToken on the instance, which removed the very
  // method that now does the work, and would pass against a connection that had
  // no recovery in it at all.
  it('recovers from a 401 during establishment without waiting on itself', async () => {
    let refreshed = 0;
    stub.rejectDiscovery = true;

    const conn = new AdtCloudConnector(
      {
        url: stub.baseUrl,
        client: '100',
        authType: 'jwt',
        jwtToken: 'STALE',
      } as SapConfig,
      // The refresher IS the credential now: a token provider that renews is
      // what the connector is handed, rather than a fourth constructor slot.
      new TokenAuthProvider({
        getToken: async () => 'FRESH',
        refreshToken: async () => {
          refreshed += 1;
          // The credential is good from here on, which is what a refresh means.
          stub.rejectDiscovery = false;
          return 'FRESH';
        },
      }),
      null,
    );

    // The window is generous on purpose: the base retries the CSRF fetch
    // `retryCount` times with `retryDelay` between attempts, so the 401 takes
    // seconds to surface before the refresh even begins. A tight race here
    // reports "hung" for a connection that was merely being patient.
    const outcome = await Promise.race([
      conn.connect().then(() => 'settled'),
      new Promise((r) => setTimeout(() => r('hung'), 15000)),
    ]);

    expect(outcome).toBe('settled');
    expect(refreshed).toBe(1);
    // Refused at least once, then fetched again after the refresh.
    expect(stub.discoveryAttempts).toBeGreaterThanOrEqual(2);
    expect(conn.isConnected()).toBe(true);
  }, 20000);
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
    const conn = onPrem(configFor(stub.baseUrl), null);

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
    const conn = onPrem(configFor(stub.baseUrl), null);
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
    const conn = onPrem(
      configFor('http://127.0.0.1:1'), // nothing listens there
      null,
    );

    await expect(conn.connect()).rejects.toThrow();
    expect(conn.isConnected()).toBe(false);
  });

  // A rejection can still carry a Set-Cookie, and every subclass reads a cookie
  // as proof that auth is already settled — buildAuthorizationHeader() returns
  // '' once one exists. Left behind, that cookie mutes the credentials on the
  // NEXT connect(), which then fails for a reason unrelated to the first one.
  it('keeps nothing from a failed establishment', async () => {
    const rejecting = createServer((_req, res) => {
      res.writeHead(401, {
        'set-cookie': ['SAP_SESSIONID_STUB_100=DEBRIS; Path=/'],
      });
      res.end('');
    });
    await new Promise<void>((resolve) =>
      rejecting.listen(0, '127.0.0.1', resolve),
    );
    const { port } = rejecting.address() as { port: number };

    try {
      const conn = onPrem(configFor(`http://127.0.0.1:${port}`), null);
      await expect(conn.connect()).rejects.toThrow();

      expect(
        (conn as unknown as { getCookies(): string | null }).getCookies(),
      ).toBeNull();
      expect(conn.getSessionIdentity()).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) =>
        rejecting.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });

  // The reverse of what an earlier version asserted, and deliberately: waiting
  // for in-flight requests is what made a teardown unbounded, since a caller may
  // legitimately pass no timeout at all. The request is not aborted — it simply
  // no longer holds the teardown, or everything queued behind it, open.
  it('does not wait for an in-flight request', async () => {
    const conn = onPrem(configFor(stub.baseUrl), null);
    await conn.connect();

    const order: string[] = [];
    const request = conn
      .makeAdtRequest({ url: '/sap/bc/adt/slow', method: 'GET', timeout: 5000 })
      .then(() => order.push('request'))
      .catch(() => order.push('request'));
    const teardown = conn.disconnect().then(() => order.push('teardown'));

    await teardown;
    expect(order).toStrictEqual(['teardown']);

    await request;
    expect(conn.isConnected()).toBe(false);
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
    return new AdtCloudConnector(
      {
        url: stub.baseUrl,
        client: '100',
        authType: 'jwt',
        jwtToken: 'STALE',
      } as SapConfig,
      // The refresher IS the credential now: a token provider that renews is
      // what the connector is handed, rather than a fourth constructor slot.
      // The token genuinely CHANGES on renewal, because that is what the
      // surviving class retries on: a provider that answers the same thing was
      // not holding a stale token, and repeating it would only ask twice. The
      // per-credential class this replaces retried either way; the rule is
      // documented on `makeAdtRequest` and pinned by its own test.
      new TokenAuthProvider(
        (() => {
          let token = 'STALE';
          return {
            getToken: async () => token,
            refreshToken: async () => {
              refreshed.count += 1;
              token = 'FRESH';
              return token;
            },
          };
        })(),
      ),
      null,
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
    const realSend = (conn as any).transport.send.bind((conn as any).transport);
    (conn as any).transport.send = async (cfg: { url: string }) => {
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
      return realSend(cfg);
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

describe('a teardown requested during establishment', () => {
  let stub: Stub;

  beforeEach(async () => {
    stub = await startStub();
  });

  afterEach(async () => {
    await stub.close();
  });

  /** Holds establishment open until the test lets it finish. */
  function stallEstablishment(conn: AdtOnPremConnector) {
    let release!: () => void;
    let markStarted!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    // Resolves once establishment has actually begun, so a test can land its
    // teardown inside the window rather than before it.
    const started = new Promise<void>((r) => {
      markStarted = r;
    });
    // The wire establishes itself now, so that is where establishment can be
    // caught mid-flight.
    const original = (conn as any).transport.establish.bind(
      (conn as any).transport,
    );
    (conn as any).transport.establish = async (context: unknown) => {
      markStarted();
      await held;
      return original(context);
    };
    return { release, started };
  }

  // Checking the epoch only BEFORE establishment lets markConnected() run after
  // it, clearing the teardown state and handing back a session the caller had
  // already asked to close.
  it('does not publish a connect that finished after a disconnect was requested', async () => {
    const conn = onPrem(configFor(stub.baseUrl), null);
    await conn.connect();
    await conn.disconnect();

    const { release, started } = stallEstablishment(conn);
    const connecting = conn.connect();
    // Wait until establishment is genuinely IN FLIGHT: asking for the teardown
    // before it starts is caught by the check that runs before establishing,
    // which is the easy half and not the race under test.
    await started;
    const teardown = conn.disconnect();
    release();

    await expect(connecting).rejects.toMatchObject({
      code: 'ADT_NOT_CONNECTED',
    });
    await teardown;
    expect(conn.isConnected()).toBe(false);
    expect(conn.getSessionIdentity()).toBeNull();
  });

  it('does not publish a recovery that finished after a disconnect was requested', async () => {
    const conn = onPrem(configFor(stub.baseUrl), null);
    await conn.connect();
    const baseline = (conn as unknown as { teardownEpoch: number })
      .teardownEpoch;

    const { release, started } = stallEstablishment(conn);
    const recovering = (
      conn as unknown as { recoverSession: (e: number) => Promise<void> }
    ).recoverSession(baseline);
    await started;
    const teardown = conn.disconnect();
    release();

    await expect(recovering).rejects.toMatchObject({
      code: 'ADT_NOT_CONNECTED',
    });
    await teardown;
    expect(conn.isConnected()).toBe(false);
  });
});

describe('an abandoned establishment leaves in-flight work alone', () => {
  let stub: Stub;

  beforeEach(async () => {
    stub = await startStub();
  });

  afterEach(async () => {
    await stub.close();
  });

  // The guard that abandons a doomed establishment must not clear the session
  // itself — the queued teardown does that. What changed since: the teardown no
  // longer waits, so "the live request keeps its cookies" is gone as a
  // guarantee. What replaces it is fencing: the request runs to completion
  // untouched, and its result cannot reach the connection.
  it('leaves the clearing to the teardown, and fences the request', async () => {
    const conn = onPrem(configFor(stub.baseUrl), null);
    await conn.connect();

    // A request that will not finish until the test says so.
    let releaseRequest!: () => void;
    const requestHeld = new Promise<void>((r) => {
      releaseRequest = r;
    });
    const realSend = (conn as any).transport.send.bind((conn as any).transport);
    (conn as any).transport.send = async (cfg: { url: string }) => {
      if (cfg.url.includes('/slow')) await requestHeld;
      return realSend(cfg);
    };

    const inFlight = conn.makeAdtRequest({
      url: '/sap/bc/adt/slow',
      method: 'GET',
      timeout: 5000,
    });
    await new Promise((r) => setTimeout(r, 10));

    // An establishment already in flight, so the guard is reached at all: a
    // connect queued BEHIND the teardown could never run, since the teardown is
    // waiting on the request this test is holding.
    let releaseEstablishment!: () => void;
    const establishmentHeld = new Promise<void>((r) => {
      releaseEstablishment = r;
    });
    const originalEstablish = (conn as any).transport.establish.bind(
      (conn as any).transport,
    );
    (conn as any).transport.establish = async (context: unknown) => {
      await establishmentHeld;
      return originalEstablish(context);
    };
    const baseline = (conn as unknown as { teardownEpoch: number })
      .teardownEpoch;
    const recovering = (
      conn as unknown as { recoverSession: (e: number) => Promise<void> }
    ).recoverSession(baseline);
    await new Promise((r) => setTimeout(r, 10));

    // The caller asks to stop while establishment is in flight.
    const teardown = conn.disconnect();
    releaseEstablishment();
    await expect(recovering).rejects.toMatchObject({
      code: 'ADT_NOT_CONNECTED',
    });

    // The teardown does not wait, so by now the session is already gone. That is
    // the trade this design accepts: the in-flight request loses the state it
    // was using, rather than holding a teardown — and everything queued behind
    // it — open for as long as it likes.
    await teardown;
    expect(
      (conn as unknown as { getCookies(): string | null }).getCookies(),
    ).toBeNull();
    expect(conn.isConnected()).toBe(false);

    // It is not aborted, though. It settles on its own terms, and whatever it
    // returns cannot touch the connection: its lease belongs to a generation
    // that is no longer current.
    releaseRequest();
    await inFlight.catch(() => undefined);
    expect(conn.isConnected()).toBe(false);
    expect(
      (conn as unknown as { getCookies(): string | null }).getCookies(),
    ).toBeNull();
  });
});
