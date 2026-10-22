/**
 * `disconnect()` resolves once the logoff is WRITTEN — its bytes on the
 * socket — not when SAP answers it.
 *
 * Measured on an on-premise system (2026-10-12): with a long request still running in the same
 * stateful session, SAP queues the logoff behind it and answers it only
 * afterwards (~96 s through the connector; no answer in six minutes sent raw
 * from a second thread), yet once the logoff has arrived the session's locks
 * go with it — even when the client is killed while the answer is pending. A
 * connection dropped without a logoff keeps its locks. So the point a caller
 * about to exit needs is "the logoff has left"; `flushGoodbye()` stays the
 * wait for the answer.
 *
 * Against a real HTTP stand-in on loopback: the wire's own node request, its
 * own `finish`.
 */
import assert from 'node:assert/strict';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { afterEach, describe, it } from 'node:test';
import { TokenAuthProvider } from '@mcp-abap-adt/auth-providers';
import type { SapConfig } from '../config/sapConfig.js';
import { AdtCloudConnector } from '../connection/AdtCloudConnector.js';
import { OnPremHttpTransport } from '../connection/OnPremHttpTransport.js';
import type { ILogger } from '../logger.js';
import { assertMatchObject } from './helpers/assertions.js';
import {
  cloudHttpTransport,
  onPrem,
  onPremHttpTransport,
} from './helpers/onPrem.js';

const SESSION_DOCUMENT =
  '<http:session xmlns:http="http://www.sap.com/adt/http" xmlns:atom="http://www.w3.org/2005/Atom">' +
  '<atom:link href="/sap/bc/adt/core/http/sessions/ABC" rel="http://www.sap.com/adt/categories/core/http/sessions/securitysession"/>' +
  '<atom:link href="/sap/public/bc/icf/logoff" rel="http://www.sap.com/adt/categories/core/http/sessions/logoff"/>' +
  '</http:session>';

/** A session document that publishes the session and no logoff link. */
const NO_LOGOFF_DOCUMENT =
  '<http:session xmlns:http="http://www.sap.com/adt/http" xmlns:atom="http://www.w3.org/2005/Atom">' +
  '<atom:link href="/sap/bc/adt/core/http/sessions/ABC" rel="http://www.sap.com/adt/categories/core/http/sessions/securitysession"/>' +
  '</http:session>';

interface StandIn {
  baseUrl: string;
  /** Settles when the logoff request has reached the server. */
  logoffArrived: Promise<IncomingMessage>;
  /** The `Cookie` header of each logoff, in arrival order. */
  logoffCookies: () => string[];
  /** How many logoff requests reached the server. */
  logoffs: () => number;
  /** How many establishing (discovery) requests reached the server. */
  establishments: () => number;
  /** The `Cookie` header of each request to the fallback discovery. */
  fallbackCookies: () => string[];
  /** The socket the establishment came on. */
  establishedOn: () => Socket | undefined;
  /** Sends the held answer to the logoff. */
  answerLogoff: () => void;
  close: () => Promise<void>;
}

/**
 * Answers the establishment (and a cloud session document), and HOLDS its
 * answer to the logoff — unless `logoffStatus` is given, which it answers at
 * once. `sessionCookie: false` issues no `SAP_SESSIONID`: a server that
 * authenticated the request and opened no ABAP session.
 */
async function standIn(
  options: {
    sessionCookie?: boolean;
    logoffStatus?: number;
    /** Answers the establishment with this status instead of a token. */
    discoveryStatus?: number;
    /** The cookies every answer but the logoff's sets, instead of the default. */
    cookies?: string[];
    /**
     * Answers `/sap/bc/adt/core/discovery` with `discoveryStatus` and the
     * fallback `/sap/bc/adt/discovery` with this one (200: a token).
     */
    fallbackStatus?: number;
    /** Paths answered 200, each with the `Set-Cookie` given. */
    routes?: Record<string, string[]>;
    /** The status a path of `routes` is answered with, instead of 200. */
    routeStatus?: Record<string, number>;
    /** The cloud session document, instead of one that links a logoff. */
    sessionDocument?: string;
  } = {},
): Promise<StandIn> {
  const sessionCookie = options.sessionCookie ?? true;
  let arrived!: (request: IncomingMessage) => void;
  const logoffArrived = new Promise<IncomingMessage>((resolve) => {
    arrived = resolve;
  });
  let held: ServerResponse | undefined;
  let establishment: Socket | undefined;
  const cookies =
    options.cookies ??
    (sessionCookie
      ? ['SAP_SESSIONID_STUB_100=S1; Path=/']
      : ['sap-XSRF_STUB_100=X1; Path=/']);
  let logoffs = 0;
  const logoffCookies: string[] = [];
  let establishments = 0;
  const fallbackCookies: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    if (url.includes('/logoff')) {
      logoffs += 1;
      logoffCookies.push(String(req.headers.cookie ?? ''));
      arrived(req);
      if (options.logoffStatus !== undefined) {
        res.writeHead(options.logoffStatus, { location: '/goodbye' });
        res.end('');
        return;
      }
      held = res;
      return;
    }
    const route = options.routes?.[url.split('?')[0] ?? ''];
    if (route) {
      const status = options.routeStatus?.[url.split('?')[0] ?? ''] ?? 200;
      res.writeHead(status, {
        'content-type': 'text/plain',
        'set-cookie': route,
      });
      res.end('');
      return;
    }
    if (url.includes('/core/http/sessions')) {
      res.writeHead(200, {
        'content-type': 'application/vnd.sap.adt.core.http.session.v3+xml',
        'set-cookie': cookies,
      });
      res.end(options.sessionDocument ?? SESSION_DOCUMENT);
      return;
    }
    establishment = req.socket;
    establishments += 1;
    const fallback = !url.includes('/core/');
    if (fallback) fallbackCookies.push(String(req.headers.cookie ?? ''));
    const status =
      fallback && options.fallbackStatus !== undefined
        ? options.fallbackStatus
        : options.discoveryStatus;
    if (status !== undefined && status !== 200) {
      res.writeHead(status, {
        'content-type': 'text/plain',
        'set-cookie': cookies,
      });
      res.end('refused');
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/atomsvc+xml',
      'x-csrf-token': 'TOKEN',
      'set-cookie': cookies,
    });
    res.end('<service/>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    logoffArrived,
    logoffCookies: () => logoffCookies,
    logoffs: () => logoffs,
    establishments: () => establishments,
    fallbackCookies: () => fallbackCookies,
    establishedOn: () => establishment,
    answerLogoff: () => {
      held?.writeHead(200, { 'content-type': 'text/html' });
      held?.end('<html>goodbye</html>');
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const configFor = (url: string): SapConfig => ({
  url,
  authType: 'basic',
  username: 'u',
  password: 'p',
  client: '100',
});

function watched(promise: Promise<unknown>) {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
}

const drained = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));

async function turns(count: number, until?: () => boolean): Promise<void> {
  for (let turn = 0; turn < count && !until?.(); turn += 1) await drained();
}

/**
 * Sends the wire's logoffs over a socket that accepts nothing: every write
 * stays pending, so no request's `finish` comes. Destroying it fails them.
 */
function bytesNeverTaken(transport: unknown): {
  fail: () => void;
  /** Settles when the wire has opened its logoff request. */
  requested: Promise<void>;
  /** The options of every logoff request the wire opened, in order. */
  logoffs: Record<string, unknown>[];
} {
  const logoffs: Record<string, unknown>[] = [];
  let opened!: () => void;
  const requested = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const socket = new Duplex({
    read() {},
    write(_chunk, _encoding, _done) {
      // never done
    },
  });
  Object.assign(socket, {
    setNoDelay: () => socket,
    setKeepAlive: () => socket,
    setTimeout: () => socket,
    ref: () => socket,
    unref: () => socket,
  });
  (
    transport as {
      logoffRequest: (
        options: Record<string, unknown>,
        onResponse: (response: IncomingMessage) => void,
      ) => unknown;
    }
  ).logoffRequest = (options, onResponse) => {
    logoffs.push(options);
    opened();
    return httpRequest(
      { ...options, agent: undefined, createConnection: () => socket } as never,
      onResponse,
    );
  };
  return {
    fail: () => socket.destroy(new Error('the server never took the bytes')),
    requested,
    logoffs,
  };
}

function recordingLogger(): ILogger & { lines: string[] } {
  const lines: string[] = [];
  const record = (message: string) => {
    lines.push(message);
  };
  return { lines, debug: record, info: record, warn: record, error: record };
}

describe('disconnect() resolves once the logoff is written', () => {
  let server: StandIn;
  afterEach(async () => {
    await server.close();
  });

  it('has resolved while the server holds its answer; flushGoodbye() has not', async () => {
    server = await standIn();
    const conn = onPrem(configFor(server.baseUrl), null);
    await conn.connect();

    const disconnected = watched(conn.disconnect());
    await server.logoffArrived;
    await drained();
    // The logoff is on the server, unanswered: disconnect() is done with it.
    assert.strictEqual(disconnected(), true);

    // flushGoodbye() is the wait for the answer, and the answer is held.
    const flushed = watched(conn.flushGoodbye(60_000));
    await turns(2);
    assert.strictEqual(flushed(), false);

    server.answerLogoff();
    await conn.flushGoodbye(60_000);
    assert.strictEqual(conn.isConnected(), false);
  });

  it('a server that never takes the bytes: disconnect() waits for the write, and resolves when the socket fails', async () => {
    server = await standIn();
    const conn = onPrem(configFor(server.baseUrl), null);
    await conn.connect();
    const wire = bytesNeverTaken(conn.transport);

    const disconnected = watched(conn.disconnect());
    await turns(20);
    // Nothing written: disconnect() has not resolved, and no timer of its own
    // will make it.
    assert.strictEqual(disconnected(), false);
    assert.strictEqual(conn.isConnected(), false);

    // The socket fails: the failure is logged, not thrown, and the teardown
    // completes.
    wire.fail();
    await turns(20, disconnected);
    assert.strictEqual(disconnected(), true);
    assert.strictEqual(await conn.flushGoodbye(60_000), undefined);
  });

  describe('disconnect() is called once', () => {
    const NOT_CONNECTED = {
      code: 'ADT_NOT_CONNECTED',
      message:
        'disconnect() was already called for this connection; call it once per instance',
    };

    it('a second call while the first is writing rejects; the first still resolves on the write', async () => {
      server = await standIn();
      const conn = onPrem(configFor(server.baseUrl), null);
      await conn.connect();
      const wire = bytesNeverTaken(conn.transport);

      const first = conn.disconnect();
      const firstDone = watched(first);
      await assert.rejects(conn.disconnect(), (e: unknown) => {
        assertMatchObject(e, NOT_CONNECTED);
        return true;
      });
      await turns(20);
      assert.strictEqual(firstDone(), false);

      wire.fail();
      assert.strictEqual(await first, undefined);
    });

    it('a second call after the first has settled rejects', async () => {
      server = await standIn();
      const conn = onPrem(configFor(server.baseUrl), null);
      await conn.connect();
      await conn.disconnect();
      await server.logoffArrived;
      server.answerLogoff();
      await conn.flushGoodbye(60_000);

      await assert.rejects(conn.disconnect(), (e: unknown) => {
        assertMatchObject(e, NOT_CONNECTED);
        return true;
      });
    });
  });

  describe('a failed connect() that logged off, and every establishment attempt', () => {
    it('cloud: a preflight session, then a renewable 401 at discovery — one logoff, no second establishment, the original failure', async () => {
      server = await standIn({ discoveryStatus: 401 });
      const config = {
        ...configFor(server.baseUrl),
        authType: 'jwt',
        jwtToken: 'TOKEN',
      } as SapConfig;
      const { stubProvider } = await import('./helpers/stubProvider.js');
      const provider = stubProvider();
      const conn = new AdtCloudConnector(
        config,
        provider,
        cloudHttpTransport(config, null),
        null,
      );

      const error = await conn.connect().catch((e: unknown) => e);
      assert.notStrictEqual(error, undefined);
      assert.strictEqual(conn.isConnected(), false);
      // The preflight's session was logged off, and nothing was renewed or
      // established again on the spent instance.
      await server.logoffArrived;
      assert.strictEqual(server.logoffs(), 1);
      assert.strictEqual(server.establishments(), 1);
      assert.deepStrictEqual(
        provider.calls.filter((c) => c.method === 'rejected'),
        [],
      );
      await assert.rejects(conn.connect(), (e: unknown) => {
        assertMatchObject(e, {
          code: 'ADT_NOT_CONNECTED',
        });
        return true;
      });
      server.answerLogoff();
    });

    it('a connect() queued behind a disconnect() establishes nothing: every attempt checks the instance', async () => {
      server = await standIn();
      const conn = onPrem(configFor(server.baseUrl), null);
      await conn.connect();
      const establishments = server.establishments();

      // Called together: connect() passes its entry check before the
      // disconnect's transition has run, and must still open nothing.
      const disconnecting = conn.disconnect();
      const connecting = conn.connect();
      await assert.rejects(connecting, (e: unknown) => {
        assertMatchObject(e, {
          code: 'ADT_NOT_CONNECTED',
        });
        return true;
      });
      await disconnecting;
      assert.strictEqual(server.establishments(), establishments);
      assert.strictEqual(conn.isConnected(), false);
      server.answerLogoff();
    });
  });

  describe('a lost session spends the instance; the consumer decides what next', () => {
    const SPENT_CODE = { code: 'ADT_NOT_CONNECTED' };
    const work = (url: string) => ({ url, method: 'GET', timeout: 5000 });

    /** Every call on a spent instance throws; disconnect() is still owed once. */
    async function spentAfterLoss(conn: ReturnType<typeof onPrem>) {
      await assert.rejects(conn.connect(), (e: unknown) => {
        assertMatchObject(e, SPENT_CODE);
        return true;
      });
      await assert.rejects(
        conn.makeAdtRequest(work('/sap/bc/adt/other')),
        (e: unknown) => {
          assertMatchObject(e, SPENT_CODE);
          return true;
        },
      );
      assert.strictEqual(await conn.disconnect(), undefined);
      await assert.rejects(conn.disconnect(), (e: unknown) => {
        assertMatchObject(e, SPENT_CODE);
        return true;
      });
    }

    it('a dead session (400 "session not found"): SESSION_REPLACED, then the instance is spent', async () => {
      server = await standIn();
      const conn = onPrem(configFor(server.baseUrl), null);
      await conn.connect();
      const send = conn.transport.send.bind(conn.transport);
      conn.transport.send = async (request) => {
        if (request.url.includes('/gone')) {
          const error = new Error('status 400') as Error & {
            response: unknown;
          };
          error.response = {
            status: 400,
            statusText: 'Session not found',
            headers: {},
            data: 'Session not found',
          };
          throw error;
        }
        return send(request);
      };
      const establishments = server.establishments();

      // Detected and reported as in 15.0.1.
      await assert.rejects(
        conn.makeAdtRequest(work('/sap/bc/adt/gone')),
        (e: unknown) => {
          assertMatchObject(e, { code: 'ADT_SESSION_REPLACED' });
          return true;
        },
      );
      await spentAfterLoss(conn);
      assert.strictEqual(server.establishments(), establishments);
      // 15.0.1's session-loss cleanup cleared the jar, so disconnect() held
      // no SAP_SESSIONID to log off (scope line 5).
      await turns(5);
      assert.strictEqual(server.logoffs(), 0);
    });

    it('a replaced SAP_SESSIONID: SESSION_REPLACED, then the instance is spent', async () => {
      server = await standIn({
        routes: { '/sap/bc/adt/work': ['SAP_SESSIONID_STUB_100=S2; Path=/'] },
      });
      const conn = onPrem(configFor(server.baseUrl), null);
      await conn.connect();
      const establishments = server.establishments();

      await assert.rejects(
        conn.makeAdtRequest(work('/sap/bc/adt/work')),
        (e: unknown) => {
          assertMatchObject(e, { code: 'ADT_SESSION_REPLACED' });
          return true;
        },
      );
      await server.logoffArrived;
      server.answerLogoff();
      await spentAfterLoss(conn);
      assert.strictEqual(server.establishments(), establishments);
      await turns(5);
      // The replacing session's logoff, and nothing more: disconnect() found
      // the jar cleared and sent none of its own.
      assert.strictEqual(server.logoffs(), 1);
    });

    it("a replaced SAP_SESSIONID: the replacing session is logged off — its cookie, no sap-contextid — and flushGoodbye() waits for that logoff's answer", async () => {
      server = await standIn({
        routes: {
          '/sap/bc/adt/work': [
            'SAP_SESSIONID_STUB_100=S2; Path=/',
            'sap-contextid=CTX2; Path=/',
          ],
        },
      });
      const conn = onPrem(configFor(server.baseUrl), null);
      await conn.connect();

      await assert.rejects(
        conn.makeAdtRequest(work('/sap/bc/adt/work')),
        (e: unknown) => {
          assertMatchObject(e, { code: 'ADT_SESSION_REPLACED' });
          return true;
        },
      );
      // Sent at the loss, without waiting for disconnect().
      await server.logoffArrived;
      assert.strictEqual(server.logoffs(), 1);
      const [cookie] = server.logoffCookies();
      assert.ok(cookie.includes('SAP_SESSIONID_STUB_100=S2'));
      assert.ok(!cookie.includes('S1'));
      assert.ok(!cookie.includes('sap-contextid'));

      // The answer is held: flushGoodbye() has not resolved.
      const flushed = watched(conn.flushGoodbye());
      await turns(5);
      assert.strictEqual(flushed(), false);
      server.answerLogoff();
      await conn.flushGoodbye();

      // disconnect() owes nothing more: the cookies were forgotten.
      assert.strictEqual(await conn.disconnect(), undefined);
      await turns(5);
      assert.strictEqual(server.logoffs(), 1);
    });

    it('cloud: a replaced SAP_SESSIONID logs the replacing session off through the linked logoff, with its cookie and no sap-contextid', async () => {
      server = await standIn({
        routes: {
          '/sap/bc/adt/work': [
            'SAP_SESSIONID_STUB_100=S2; Path=/',
            'sap-contextid=CTX2; Path=/',
          ],
        },
      });
      const config = {
        ...configFor(server.baseUrl),
        authType: 'jwt',
        jwtToken: 'TOKEN',
      } as SapConfig;
      const conn = new AdtCloudConnector(
        config,
        TokenAuthProvider.fixed('TOKEN'),
        cloudHttpTransport(config, null),
        null,
      );
      await conn.connect();

      await assert.rejects(
        conn.makeAdtRequest(work('/sap/bc/adt/work')),
        (e: unknown) => {
          assertMatchObject(e, { code: 'ADT_SESSION_REPLACED' });
          return true;
        },
      );
      const logoff = await server.logoffArrived;
      assert.strictEqual(logoff.url, '/sap/public/bc/icf/logoff');
      assert.strictEqual(logoff.headers['x-sap-security-session'], 'use');
      const [cookie] = server.logoffCookies();
      assert.ok(cookie.includes('SAP_SESSIONID_STUB_100=S2'));
      assert.ok(!cookie.includes('S1'));
      assert.ok(!cookie.includes('sap-contextid'));

      const flushed = watched(conn.flushGoodbye());
      await turns(5);
      assert.strictEqual(flushed(), false);
      server.answerLogoff();
      await conn.flushGoodbye();
      assert.strictEqual(await conn.disconnect(), undefined);
      await turns(5);
      assert.strictEqual(server.logoffs(), 1);
    });

    it('a session replaced while connect() establishes it: one logoff, for the replacing session, written before connect() rejects', {
      timeout: 30_000,
    }, async () => {
      // Core discovery answers 404 in session S1; its fallback, which runs in
      // the same session, comes back naming S2.
      server = await standIn({
        discoveryStatus: 404,
        routes: {
          '/sap/bc/adt/discovery': ['SAP_SESSIONID_STUB_100=S2; Path=/'],
        },
      });
      const conn = onPrem(configFor(server.baseUrl), null);
      const wire = bytesNeverTaken(conn.transport);

      const connecting = conn.connect();
      const rejected = watched(connecting);
      await wire.requested;
      await turns(20);
      // The logoff is not written yet: connect() has not rejected.
      assert.strictEqual(rejected(), false);
      wire.fail();
      await assert.rejects(connecting, (e: unknown) => {
        assertMatchObject(e, {
          code: 'ADT_SESSION_REPLACED',
        });
        return true;
      });
      assert.strictEqual(await conn.disconnect(), undefined);
      await conn.flushGoodbye();
      await turns(5);
      // One logoff and only one: the replacement's. The failed connect()
      // found the cookies already forgotten and sent none of its own.
      assert.strictEqual(server.logoffs(), 0);
      assert.strictEqual(wire.logoffs.length, 1);
      const headers = (wire.logoffs[0]?.headers ?? {}) as Record<
        string,
        unknown
      >;
      const cookie = String(headers.Cookie ?? headers.cookie ?? '');
      assert.ok(cookie.includes('SAP_SESSIONID_STUB_100=S2'));
      assert.ok(!cookie.includes('S1'));
    });

    it('a 401 answering a request is no replacement: no logoff is sent for it, and disconnect() logs the session off once', async () => {
      server = await standIn({
        routes: { '/sap/bc/adt/refused': ['sap-XSRF_STUB_100=X2; Path=/'] },
        routeStatus: { '/sap/bc/adt/refused': 401 },
        logoffStatus: 200,
      });
      const conn = onPrem(configFor(server.baseUrl), null);
      await conn.connect();

      await assert.rejects(
        conn.makeAdtRequest(work('/sap/bc/adt/refused')),
        (e: unknown) => e !== undefined,
      );
      await turns(5);
      assert.strictEqual(server.logoffs(), 0);

      await conn.disconnect();
      await conn.flushGoodbye();
      assert.strictEqual(server.logoffs(), 1);
      assert.ok(
        server.logoffCookies()[0].includes('SAP_SESSIONID_STUB_100=S1'),
      );
    });

    it('after a plain disconnect(), a request throws NOT_CONNECTED', async () => {
      server = await standIn();
      const conn = onPrem(configFor(server.baseUrl), null);
      await conn.connect();
      await conn.disconnect();
      await assert.rejects(
        conn.makeAdtRequest(work('/sap/bc/adt/other')),
        (e: unknown) => {
          assertMatchObject(e, SPENT_CODE);
          return true;
        },
      );
      server.answerLogoff();
    });
  });

  describe('one instance is one session', () => {
    const SPENT = {
      code: 'ADT_NOT_CONNECTED',
      message:
        "This connection's SAP session has ended (it was disconnected, logged off or lost); one connection instance is one session. Create a new connection for a new session.",
    };

    it('connect() after disconnect() is refused, and nothing is sent', async () => {
      server = await standIn();
      const conn = onPrem(configFor(server.baseUrl), null);
      await conn.connect();
      const establishments = server.establishments();
      await conn.disconnect();
      await server.logoffArrived;

      await assert.rejects(conn.connect(), (e: unknown) => {
        assertMatchObject(e, SPENT);
        return true;
      });
      assert.strictEqual(server.establishments(), establishments);
      assert.strictEqual(server.logoffs(), 1);
      server.answerLogoff();
    });

    it('connect() on a spent instance asks the credential nothing', async () => {
      server = await standIn();
      const { stubProvider } = await import('./helpers/stubProvider.js');
      const { AdtOnPremConnector } = await import(
        '../connection/AdtOnPremConnector.js'
      );
      const provider = stubProvider();
      const conn = new AdtOnPremConnector(
        configFor(server.baseUrl),
        provider,
        onPremHttpTransport(configFor(server.baseUrl)),
        null,
      );
      await conn.disconnect();
      await assert.rejects(conn.connect(), (e: unknown) => {
        assertMatchObject(e, SPENT);
        return true;
      });
      assert.deepStrictEqual(
        provider.calls.filter((c) => c.method === 'prepare'),
        [],
      );
    });

    it('connect() called in the same turn as disconnect(), after it, asks the credential nothing', async () => {
      server = await standIn();
      const { stubProvider } = await import('./helpers/stubProvider.js');
      const { AdtOnPremConnector } = await import(
        '../connection/AdtOnPremConnector.js'
      );
      const provider = stubProvider();
      const conn = new AdtOnPremConnector(
        configFor(server.baseUrl),
        provider,
        onPremHttpTransport(configFor(server.baseUrl)),
        null,
      );
      await conn.connect();
      const prepares = () =>
        provider.calls.filter((c) => c.method === 'prepare').length;
      assert.strictEqual(prepares(), 1);
      const establishments = server.establishments();

      // Not awaited in between: the instance is spent only when the
      // disconnect's transition runs, after connect()'s check at entry.
      const disconnected = conn.disconnect();
      const reconnected = assert.rejects(conn.connect(), (e: unknown) => {
        assertMatchObject(e, SPENT);
        return true;
      });
      await disconnected;
      await reconnected;

      assert.strictEqual(prepares(), 1);
      assert.strictEqual(server.establishments(), establishments);
    });

    it('connect() after disconnect() on an instance that never connected is refused too', async () => {
      server = await standIn();
      const conn = onPrem(configFor(server.baseUrl), null);
      await conn.disconnect();
      await assert.rejects(conn.connect(), (e: unknown) => {
        assertMatchObject(e, SPENT);
        return true;
      });
      assert.strictEqual(server.establishments(), 0);
    });

    it('connect() after a failed connect() that logged off is refused', {
      timeout: 30_000,
    }, async () => {
      server = await standIn({ discoveryStatus: 404, fallbackStatus: 404 });
      const conn = onPrem(configFor(server.baseUrl), null);
      await assert.rejects(conn.connect(), (e: unknown) => e !== undefined);
      await server.logoffArrived;
      const establishments = server.establishments();

      await assert.rejects(conn.connect(), (e: unknown) => {
        assertMatchObject(e, SPENT);
        return true;
      });
      assert.strictEqual(server.establishments(), establishments);
      server.answerLogoff();
    });

    it("after a failed connect() that logged off, disconnect() then flushGoodbye() waits for that logoff's answer", {
      timeout: 30_000,
    }, async () => {
      server = await standIn({ discoveryStatus: 404, fallbackStatus: 404 });
      const conn = onPrem(configFor(server.baseUrl), null);
      await assert.rejects(conn.connect(), (e: unknown) => e !== undefined);
      await server.logoffArrived;

      assert.strictEqual(await conn.disconnect(), undefined);
      const flushed = watched(conn.flushGoodbye());
      await turns(5);
      // The instance's one logoff is the failed connect's, still unanswered.
      assert.strictEqual(flushed(), false);
      server.answerLogoff();
      await conn.flushGoodbye();
      assert.strictEqual(server.logoffs(), 1);
    });

    it('connect() after a failed connect() that sent no logoff (401) may be retried', async () => {
      // A 401 creates no security session, so it carries no SAP_SESSIONID.
      server = await standIn({
        discoveryStatus: 401,
        cookies: ['sap-XSRF_STUB_100=X1; Path=/'],
      });
      const conn = onPrem(configFor(server.baseUrl), null);
      await assert.rejects(conn.connect(), (e: unknown) => e !== undefined);
      assert.strictEqual(server.logoffs(), 0);
      const establishments = server.establishments();

      // Retried: it asks the server again rather than refusing.
      await assert.rejects(conn.connect(), (e: unknown) => e !== undefined);
      assert.ok(server.establishments() > establishments);
      await conn.disconnect();
    });
  });

  describe('a failed connect() rejects only once its own goodbye is written', () => {
    it('no session, through a custom wire whose close() does send: connect() rejects once that goodbye is written', async () => {
      server = await standIn();
      const { holdsNoSession } = await import('./helpers/transportStub.js');
      const { AdtOnPremConnector } = await import(
        '../connection/AdtOnPremConnector.js'
      );
      const { BasicAuthProvider } = await import(
        '@mcp-abap-adt/auth-providers'
      );
      let write!: () => void;
      const writing = new Promise<void>((resolve) => {
        write = resolve;
      });
      const transport = {
        ...holdsNoSession,
        kind: 'custom',
        system: 'onprem' as const,
        send: async () => ({ status: 200, headers: {}, data: '' }),
        // Its own rule: it has something to say goodbye to, and says it.
        close: async (_context: unknown, written?: () => void) => {
          await writing;
          written?.();
          await new Promise<never>(() => undefined);
        },
      };
      const conn = new AdtOnPremConnector(
        configFor(server.baseUrl),
        new BasicAuthProvider('u', 'p'),
        transport as never,
        null,
      );

      const connecting = conn.connect();
      const settled = watched(connecting);
      await turns(20);
      assert.strictEqual(settled(), false);

      write();
      await assert.rejects(connecting, (e: unknown) =>
        /opened no ABAP session/.test((e as Error).message),
      );
    });

    it('the establishment failing after the cloud preflight opened a session', async () => {
      // A refused establishment fails at once, with no retry to wait out.
      server = await standIn({ discoveryStatus: 401 });
      const config = {
        ...configFor(server.baseUrl),
        authType: 'jwt',
        jwtToken: 'TOKEN',
      } as SapConfig;
      const conn = new AdtCloudConnector(
        config,
        TokenAuthProvider.fixed('TOKEN'),
        cloudHttpTransport(config, null),
        null,
      );
      const wire = bytesNeverTaken(conn.transport);

      const connecting = conn.connect();
      const settled = watched(connecting);
      await wire.requested;
      await turns(20);
      assert.strictEqual(settled(), false);

      wire.fail();
      await assert.rejects(connecting, (e: unknown) => e !== undefined);
    });
  });

  describe('the logoff is sent if and only if the wire holds a SAP_SESSIONID it received', () => {
    // The establishment retries a refused GET, with its own delay between
    // attempts: these take a few seconds of the wire's retries.
    const RETRIES = 30_000;

    for (const status of [404, 403]) {
      it(`connect() answered ${status} after logon, with SAP_SESSIONID: the logoff is sent, and connect() rejects once it is written`, {
        timeout: RETRIES,
      }, async () => {
        server = await standIn({ discoveryStatus: status });
        const conn = onPrem(configFor(server.baseUrl), null);

        await assert.rejects(conn.connect(), (e: unknown) => e !== undefined);
        // It rejected after the write: the logoff is on its way or arrived.
        const logoff = await server.logoffArrived;
        assert.ok(logoff.headers.cookie?.includes('SAP_SESSIONID_STUB_100=S1'));
        assert.strictEqual(server.logoffs(), 1);
        server.answerLogoff();
      });
    }

    it('core discovery 404 with SAP_SESSIONID, fallback 200: connect() resolves, no logoff, the fallback ran in the same session', {
      timeout: RETRIES,
    }, async () => {
      server = await standIn({ discoveryStatus: 404, fallbackStatus: 200 });
      const conn = onPrem(configFor(server.baseUrl), null);

      assert.strictEqual(await conn.connect(), undefined);
      assert.strictEqual(server.logoffs(), 0);
      assert.ok(
        server.fallbackCookies()[0].includes('SAP_SESSIONID_STUB_100=S1'),
      );

      // The normal path: nothing until disconnect().
      await conn.disconnect();
      await server.logoffArrived;
      assert.strictEqual(server.logoffs(), 1);
      server.answerLogoff();
    });

    it('core discovery 404 and fallback 404, both with SAP_SESSIONID: one logoff, then connect() rejects', {
      timeout: RETRIES,
    }, async () => {
      server = await standIn({ discoveryStatus: 404, fallbackStatus: 404 });
      const conn = onPrem(configFor(server.baseUrl), null);

      await assert.rejects(conn.connect(), (e: unknown) => e !== undefined);
      await server.logoffArrived;
      assert.strictEqual(server.logoffs(), 1);
      assert.ok(server.fallbackCookies().length > 0);
      server.answerLogoff();
    });

    it('connect() answered 401 with a debris cookie: nothing is sent', async () => {
      server = await standIn({
        discoveryStatus: 401,
        cookies: ['sap-XSRF_STUB_100=X1; Path=/'],
      });
      const conn = onPrem(configFor(server.baseUrl), null);

      await assert.rejects(conn.connect(), (e: unknown) => e !== undefined);
      assert.strictEqual(await conn.disconnect(), undefined);
      await turns(5);
      assert.strictEqual(server.logoffs(), 0);
    });

    it('connect() answered 200 with only sap-XSRF_* (no session): nothing is sent, on connect() nor on disconnect()', async () => {
      server = await standIn({ sessionCookie: false });
      const conn = onPrem(configFor(server.baseUrl), null);

      await assert.rejects(conn.connect(), (e: unknown) =>
        /opened no ABAP session/.test((e as Error).message),
      );
      assert.strictEqual(await conn.disconnect(), undefined);
      await turns(5);
      assert.strictEqual(server.logoffs(), 0);
    });

    it('a deleting Set-Cookie (expiry in the past, or Max-Age=0) removes SAP_SESSIONID: no session, nothing is sent', async () => {
      server = await standIn();
      const transport = onPremHttpTransport(configFor(server.baseUrl));
      const context = {
        baseUrl: server.baseUrl,
        authorize: async () => {},
        logon: async () => {},
        observe: () => {},
      };
      for (const deletion of [
        // Exactly what SAP's logoff answers with (on-premise, 2026-10-13): a
        // one-character value and an expiry in 1980.
        'SAP_SESSIONID_STUB_100=X; path=/; expires=Tue, 01-Jan-1980 00:00:01 GMT',
        'SAP_SESSIONID_STUB_100=S1; Max-Age=0; Path=/',
        'SAP_SESSIONID_STUB_100=S1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/',
      ]) {
        transport.ingest({
          'set-cookie': ['SAP_SESSIONID_STUB_100=S1; Path=/'],
        });
        assert.strictEqual(transport.sessionEstablished(), true);
        transport.ingest({ 'set-cookie': [deletion] });
        assert.strictEqual(transport.sessionFingerprint().size, 0);
        assert.strictEqual(transport.sessionEstablished(), false);
        // Nor does the deleted cookie ride on the next request.
        assert.ok(!(transport.cookies() ?? '').includes('SAP_SESSIONID'));
        await transport.close(context);
      }
      // A wire with no client asserts no cookie of its own: the deletion
      // leaves it holding nothing, and it says so.
      const bare = new OnPremHttpTransport(() => ({}), null, {
        baseUrl: server.baseUrl,
      });
      bare.ingest({ 'set-cookie': ['SAP_SESSIONID_STUB_100=S1; Path=/'] });
      bare.ingest({
        'set-cookie': [
          'SAP_SESSIONID_STUB_100=X; path=/; expires=Tue, 01-Jan-1980 00:00:01 GMT',
        ],
      });
      assert.strictEqual(bare.cookies(), null);
      await turns(5);
      assert.strictEqual(server.logoffs(), 0);
    });

    it("SAP's whole logoff answer deletes every cookie it set", () => {
      const transport = onPremHttpTransport(configFor('http://saphost:8000'));
      transport.ingest({
        'set-cookie': [
          'SAP_SESSIONID_STUB_100=0123456789012345678901234567890123456789012345; path=/; HttpOnly',
          'sap-contextid=CTX; path=/sap/bc/adt; HttpOnly',
          'sap-usercontext=sap-client=100; path=/',
        ],
      });
      assert.strictEqual(transport.sessionEstablished(), true);
      const gone = 'expires=Tue, 01-Jan-1980 00:00:01 GMT';
      transport.ingest({
        'set-cookie': [
          `sap-contextid=X; path=/sap/bc/adt; ${gone}`,
          `sap-usercontext=X; path=/; ${gone}`,
          `SAP_SESSIONID_STUB_100=X; path=/; ${gone}`,
          `sap-XSRF_STUB_100=X; path=/; ${gone}`,
          `SPNegoTokenRequested=X; path=/; ${gone}`,
          `OIDCTokenRequested=X; path=/; ${gone}`,
        ],
      });
      assert.strictEqual(transport.sessionEstablished(), false);
      const sent = transport.cookies() ?? '';
      assert.ok(!sent.includes('SAP_SESSIONID'));
      assert.ok(!sent.includes('sap-contextid'));
    });

    it('an empty SAP_SESSIONID value names no session: nothing is sent', async () => {
      server = await standIn();
      const transport = onPremHttpTransport(configFor(server.baseUrl));
      transport.ingest({ 'set-cookie': ['SAP_SESSIONID_STUB_100=; Path=/'] });
      assert.strictEqual(transport.sessionEstablished(), false);
      await transport.close({
        baseUrl: server.baseUrl,
        authorize: async () => {},
        logon: async () => {},
        observe: () => {},
      });
      await turns(5);
      assert.strictEqual(server.logoffs(), 0);
    });

    it('cloud: a preflight session document without SAP_SESSIONID: nothing is sent', async () => {
      server = await standIn({ sessionCookie: false });
      const config = {
        ...configFor(server.baseUrl),
        authType: 'jwt',
        jwtToken: 'TOKEN',
      } as SapConfig;
      const conn = new AdtCloudConnector(
        config,
        TokenAuthProvider.fixed('TOKEN'),
        cloudHttpTransport(config, null),
        null,
      );

      await assert.rejects(conn.connect(), (e: unknown) =>
        /opened no ABAP session/.test((e as Error).message),
      );
      assert.strictEqual(await conn.disconnect(), undefined);
      await turns(5);
      assert.strictEqual(server.logoffs(), 0);
    });

    it("the failing answer's cookie is the one the goodbye carries, snapshot before the clearing", {
      timeout: 30_000,
    }, async () => {
      server = await standIn({ discoveryStatus: 404 });
      const conn = onPrem(configFor(server.baseUrl), null);

      await assert.rejects(conn.connect(), (e: unknown) => e !== undefined);
      // Cleared by now: the goodbye took its cookie before that.
      assert.strictEqual(conn.transport.cookies(), null);
      const logoff = await server.logoffArrived;
      assert.ok(logoff.headers.cookie?.includes('SAP_SESSIONID_STUB_100=S1'));
      server.answerLogoff();
    });
  });

  describe('the logoff never carries sap-contextid', () => {
    // Measured on an on-premise system (2026-10-13, bare HTTP): a logoff without the context
    // cookie ended the context and released its lock; one carrying a stale
    // (deleted) sap-contextid got 400 and closed nothing.
    const STALE = 'sap-contextid=STALE; path=/sap/bc/adt';

    it('on-prem: a context in the jar stays off the logoff', async () => {
      server = await standIn();
      const conn = onPrem(configFor(server.baseUrl), null);
      await conn.connect();
      conn.transport.ingest({ 'set-cookie': [STALE] });

      await conn.disconnect();
      const logoff = await server.logoffArrived;
      const cookie = String(logoff.headers.cookie ?? '');
      assert.ok(cookie.includes('SAP_SESSIONID_STUB_100=S1'));
      assert.ok(cookie.includes('sap-usercontext='));
      assert.ok(!cookie.includes('sap-contextid'));
      server.answerLogoff();
    });

    it('cloud: a session whose document linked no logoff gets the platform logoff, without sap-contextid, and disconnect() resolves on its write', async () => {
      server = await standIn({
        sessionDocument: NO_LOGOFF_DOCUMENT,
        cookies: [
          'SAP_SESSIONID_STUB_100=S1; Path=/',
          'sap-contextid=CTX; Path=/',
        ],
      });
      const config = {
        ...configFor(server.baseUrl),
        authType: 'jwt',
        jwtToken: 'TOKEN',
      } as SapConfig;
      const conn = new AdtCloudConnector(
        config,
        TokenAuthProvider.fixed('TOKEN'),
        cloudHttpTransport(config, null),
        null,
      );
      await conn.connect();

      const disconnected = watched(conn.disconnect());
      const logoff = await server.logoffArrived;
      // The answer is held: disconnect() resolved on the write alone.
      await drained();
      assert.strictEqual(disconnected(), true);
      assert.strictEqual(logoff.url, '/sap/public/bc/icf/logoff');
      const cookie = String(logoff.headers.cookie ?? '');
      assert.ok(cookie.includes('SAP_SESSIONID_STUB_100=S1'));
      assert.ok(!cookie.includes('sap-contextid'));
      // Exactly as the on-prem wire sends it: no session header of the
      // cloud's own, and no credential.
      assert.strictEqual(logoff.headers['x-sap-security-session'], undefined);
      assert.strictEqual(logoff.headers.authorization, undefined);
      assert.strictEqual(server.logoffs(), 1);
      server.answerLogoff();
      await conn.flushGoodbye(60_000);
    });

    it('cloud: connect() failing after a preflight session with no logoff link sends the platform logoff before it rejects', {
      timeout: 30_000,
    }, async () => {
      server = await standIn({
        sessionDocument: NO_LOGOFF_DOCUMENT,
        discoveryStatus: 404,
        fallbackStatus: 404,
      });
      const config = {
        ...configFor(server.baseUrl),
        authType: 'jwt',
        jwtToken: 'TOKEN',
      } as SapConfig;
      const conn = new AdtCloudConnector(
        config,
        TokenAuthProvider.fixed('TOKEN'),
        cloudHttpTransport(config, null),
        null,
      );

      await assert.rejects(conn.connect(), (e: unknown) => e !== undefined);
      // It rejected after the write: the logoff is on its way or arrived.
      const logoff = await server.logoffArrived;
      assert.strictEqual(logoff.url, '/sap/public/bc/icf/logoff');
      assert.ok(
        String(logoff.headers.cookie ?? '').includes(
          'SAP_SESSIONID_STUB_100=S1',
        ),
      );
      assert.strictEqual(server.logoffs(), 1);
      server.answerLogoff();
    });

    it('cloud: a context in the jar stays off the logoff', async () => {
      server = await standIn();
      const config = {
        ...configFor(server.baseUrl),
        authType: 'jwt',
        jwtToken: 'TOKEN',
      } as SapConfig;
      const conn = new AdtCloudConnector(
        config,
        TokenAuthProvider.fixed('TOKEN'),
        cloudHttpTransport(config, null),
        null,
      );
      await conn.connect();
      conn.transport.ingest({ 'set-cookie': [STALE] });

      await conn.disconnect();
      const logoff = await server.logoffArrived;
      const cookie = String(logoff.headers.cookie ?? '');
      assert.ok(cookie.includes('SAP_SESSIONID_STUB_100=S1'));
      assert.ok(!cookie.includes('sap-contextid'));
      server.answerLogoff();
    });
  });

  it('goes out on a connection of its own, closed after it', async () => {
    server = await standIn();
    const conn = onPrem(configFor(server.baseUrl), null);
    await conn.connect();
    const establishedOn = server.establishedOn();
    assert.notStrictEqual(establishedOn, undefined);

    await conn.disconnect();
    const logoff = await server.logoffArrived;
    // Not the establishment's keep-alive socket, which the server may close
    // at any time: a write to that one could succeed and still be lost.
    assert.notStrictEqual(logoff.socket, establishedOn);
    assert.strictEqual(logoff.headers.connection, 'close');
    server.answerLogoff();
    await conn.flushGoodbye(60_000);
  });

  it('a redirect answering the logoff is an answer, not a failure to say goodbye', async () => {
    server = await standIn({ logoffStatus: 302 });
    const logger = recordingLogger();
    const conn = onPrem(configFor(server.baseUrl), logger);
    await conn.connect();

    await conn.disconnect();
    await conn.flushGoodbye(60_000);
    assert.ok(logger.lines.includes('Told the server the session is finished'));
    assert.strictEqual(
      logger.lines.some((line) =>
        line.startsWith('Could not tell the server the session is finished'),
      ),
      false,
    );
  });

  it('on the cloud wire: has resolved while the server holds its answer', async () => {
    server = await standIn();
    const config = {
      ...configFor(server.baseUrl),
      authType: 'jwt',
      jwtToken: 'TOKEN',
    } as SapConfig;
    const conn = new AdtCloudConnector(
      config,
      TokenAuthProvider.fixed('TOKEN'),
      cloudHttpTransport(config, null),
      null,
    );
    await conn.connect();

    const disconnected = watched(conn.disconnect());
    await server.logoffArrived;
    await drained();
    assert.strictEqual(disconnected(), true);

    const flushed = watched(conn.flushGoodbye(60_000));
    await turns(2);
    assert.strictEqual(flushed(), false);
    server.answerLogoff();
    await conn.flushGoodbye(60_000);
  });
});

describe('over RFC, disconnect() resolves when the close call has returned', () => {
  it('waits for the conversation to close, and no longer', async () => {
    const { BasicAuthProvider } = await import('@mcp-abap-adt/auth-providers');
    const { AdtOnPremConnector } = await import(
      '../connection/AdtOnPremConnector.js'
    );
    const { RfcTransport } = await import('../connection/RfcTransport.js');
    let release!: () => void;
    const closing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const conversation = {
      alive: true,
      open: async () => {},
      close: async () => {
        await closing;
        conversation.alive = false;
      },
      call: async () => ({}),
    };
    const conn = new AdtOnPremConnector(
      configFor('http://saphost:8000'),
      new BasicAuthProvider('u', 'p'),
      new RfcTransport(() => conversation, null),
      null,
    );
    await conn.connect();

    const disconnected = watched(conn.disconnect());
    await turns(10);
    assert.strictEqual(disconnected(), false);

    release();
    await turns(10, disconnected);
    assert.strictEqual(disconnected(), true);
  });
});
