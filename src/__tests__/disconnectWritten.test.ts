/**
 * `disconnect()` resolves once the logoff is WRITTEN — its bytes on the
 * socket — not when SAP answers it.
 *
 * Measured on E19 (2026-10-12): with a long request still running in the same
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
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { TokenAuthProvider } from '@mcp-abap-adt/auth-providers';
import type { SapConfig } from '../config/sapConfig.js';
import { AdtCloudConnector } from '../connection/AdtCloudConnector.js';
import { OnPremHttpTransport } from '../connection/OnPremHttpTransport.js';
import type { ILogger } from '../logger.js';
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

interface StandIn {
  baseUrl: string;
  /** Settles when the logoff request has reached the server. */
  logoffArrived: Promise<IncomingMessage>;
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
  let establishments = 0;
  const fallbackCookies: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    if (url.includes('/logoff')) {
      logoffs += 1;
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
      res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': route });
      res.end('');
      return;
    }
    if (url.includes('/core/http/sessions')) {
      res.writeHead(200, {
        'content-type': 'application/vnd.sap.adt.core.http.session.v3+xml',
        'set-cookie': cookies,
      });
      res.end(SESSION_DOCUMENT);
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
} {
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
    opened();
    return httpRequest(
      { ...options, agent: undefined, createConnection: () => socket } as never,
      onResponse,
    );
  };
  return {
    fail: () => socket.destroy(new Error('the server never took the bytes')),
    requested,
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
    expect(disconnected()).toBe(true);

    // flushGoodbye() is the wait for the answer, and the answer is held.
    const flushed = watched(conn.flushGoodbye(60_000));
    await turns(2);
    expect(flushed()).toBe(false);

    server.answerLogoff();
    await conn.flushGoodbye(60_000);
    expect(conn.isConnected()).toBe(false);
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
    expect(disconnected()).toBe(false);
    expect(conn.isConnected()).toBe(false);

    // The socket fails: the failure is logged, not thrown, and the teardown
    // completes.
    wire.fail();
    await turns(20, disconnected);
    expect(disconnected()).toBe(true);
    await expect(conn.flushGoodbye(60_000)).resolves.toBeUndefined();
  });

  describe('disconnect() is called once', () => {
    const NOT_CONNECTED = {
      code: 'ADT_NOT_CONNECTED',
      message:
        'disconnect() was already called for this connection; call it once per connect()',
    };

    it('a second call while the first is writing rejects; the first still resolves on the write', async () => {
      server = await standIn();
      const conn = onPrem(configFor(server.baseUrl), null);
      await conn.connect();
      const wire = bytesNeverTaken(conn.transport);

      const first = conn.disconnect();
      const firstDone = watched(first);
      await expect(conn.disconnect()).rejects.toMatchObject(NOT_CONNECTED);
      await turns(20);
      expect(firstDone()).toBe(false);

      wire.fail();
      await expect(first).resolves.toBeUndefined();
    });

    it('a second call after the first has settled rejects', async () => {
      server = await standIn();
      const conn = onPrem(configFor(server.baseUrl), null);
      await conn.connect();
      await conn.disconnect();
      await server.logoffArrived;
      server.answerLogoff();
      await conn.flushGoodbye(60_000);

      await expect(conn.disconnect()).rejects.toMatchObject(NOT_CONNECTED);
    });
  });

  describe('one instance is one session', () => {
    const SPENT = {
      code: 'ADT_NOT_CONNECTED',
      message:
        "This connection's SAP session has ended (it was disconnected or logged off); one connection instance is one session. Create a new connection for a new session.",
    };

    it('connect() after disconnect() is refused, and nothing is sent', async () => {
      server = await standIn();
      const conn = onPrem(configFor(server.baseUrl), null);
      await conn.connect();
      const establishments = server.establishments();
      await conn.disconnect();
      await server.logoffArrived;

      await expect(conn.connect()).rejects.toMatchObject(SPENT);
      expect(server.establishments()).toBe(establishments);
      expect(server.logoffs()).toBe(1);
      server.answerLogoff();
    });

    it('connect() after disconnect() on an instance that never connected is refused too', async () => {
      server = await standIn();
      const conn = onPrem(configFor(server.baseUrl), null);
      await conn.disconnect();
      await expect(conn.connect()).rejects.toMatchObject(SPENT);
      expect(server.establishments()).toBe(0);
    });

    it('connect() after a failed connect() that logged off is refused', async () => {
      server = await standIn({ discoveryStatus: 404, fallbackStatus: 404 });
      const conn = onPrem(configFor(server.baseUrl), null);
      await expect(conn.connect()).rejects.toBeDefined();
      await server.logoffArrived;
      const establishments = server.establishments();

      await expect(conn.connect()).rejects.toMatchObject(SPENT);
      expect(server.establishments()).toBe(establishments);
      server.answerLogoff();
    }, 30_000);

    it('connect() after a failed connect() that sent no logoff (401) may be retried', async () => {
      // A 401 creates no security session, so it carries no SAP_SESSIONID.
      server = await standIn({
        discoveryStatus: 401,
        cookies: ['sap-XSRF_STUB_100=X1; Path=/'],
      });
      const conn = onPrem(configFor(server.baseUrl), null);
      await expect(conn.connect()).rejects.toBeDefined();
      expect(server.logoffs()).toBe(0);
      const establishments = server.establishments();

      // Retried: it asks the server again rather than refusing.
      await expect(conn.connect()).rejects.toBeDefined();
      expect(server.establishments()).toBeGreaterThan(establishments);
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
      expect(settled()).toBe(false);

      write();
      await expect(connecting).rejects.toThrow(/opened no ABAP session/);
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
      expect(settled()).toBe(false);

      wire.fail();
      await expect(connecting).rejects.toBeDefined();
    });
  });

  describe('the logoff is sent if and only if the wire holds a SAP_SESSIONID it received', () => {
    // The establishment retries a refused GET, with its own delay between
    // attempts: these take a few seconds of the wire's retries.
    const RETRIES = 30_000;

    it.each([404, 403])(
      'connect() answered %i after logon, with SAP_SESSIONID: the logoff is sent, and connect() rejects once it is written',
      async (status) => {
        server = await standIn({ discoveryStatus: status });
        const conn = onPrem(configFor(server.baseUrl), null);

        await expect(conn.connect()).rejects.toBeDefined();
        // It rejected after the write: the logoff is on its way or arrived.
        const logoff = await server.logoffArrived;
        expect(logoff.headers.cookie).toContain('SAP_SESSIONID_STUB_100=S1');
        expect(server.logoffs()).toBe(1);
        server.answerLogoff();
      },
      RETRIES,
    );

    it(
      'core discovery 404 with SAP_SESSIONID, fallback 200: connect() resolves, no logoff, the fallback ran in the same session',
      async () => {
        server = await standIn({ discoveryStatus: 404, fallbackStatus: 200 });
        const conn = onPrem(configFor(server.baseUrl), null);

        await expect(conn.connect()).resolves.toBeUndefined();
        expect(server.logoffs()).toBe(0);
        expect(server.fallbackCookies()[0]).toContain(
          'SAP_SESSIONID_STUB_100=S1',
        );

        // The normal path: nothing until disconnect().
        await conn.disconnect();
        await server.logoffArrived;
        expect(server.logoffs()).toBe(1);
        server.answerLogoff();
      },
      RETRIES,
    );

    it(
      'core discovery 404 and fallback 404, both with SAP_SESSIONID: one logoff, then connect() rejects',
      async () => {
        server = await standIn({ discoveryStatus: 404, fallbackStatus: 404 });
        const conn = onPrem(configFor(server.baseUrl), null);

        await expect(conn.connect()).rejects.toBeDefined();
        await server.logoffArrived;
        expect(server.logoffs()).toBe(1);
        expect(server.fallbackCookies().length).toBeGreaterThan(0);
        server.answerLogoff();
      },
      RETRIES,
    );

    it('connect() answered 401 with a debris cookie: nothing is sent', async () => {
      server = await standIn({
        discoveryStatus: 401,
        cookies: ['sap-XSRF_STUB_100=X1; Path=/'],
      });
      const conn = onPrem(configFor(server.baseUrl), null);

      await expect(conn.connect()).rejects.toBeDefined();
      await expect(conn.disconnect()).resolves.toBeUndefined();
      await turns(5);
      expect(server.logoffs()).toBe(0);
    });

    it('connect() answered 200 with only sap-XSRF_* (no session): nothing is sent, on connect() nor on disconnect()', async () => {
      server = await standIn({ sessionCookie: false });
      const conn = onPrem(configFor(server.baseUrl), null);

      await expect(conn.connect()).rejects.toThrow(/opened no ABAP session/);
      await expect(conn.disconnect()).resolves.toBeUndefined();
      await turns(5);
      expect(server.logoffs()).toBe(0);
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
        // Exactly what SAP's logoff answers with (E19, 2026-10-13): a
        // one-character value and an expiry in 1980.
        'SAP_SESSIONID_STUB_100=X; path=/; expires=Tue, 01-Jan-1980 00:00:01 GMT',
        'SAP_SESSIONID_STUB_100=S1; Max-Age=0; Path=/',
        'SAP_SESSIONID_STUB_100=S1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/',
      ]) {
        transport.ingest({
          'set-cookie': ['SAP_SESSIONID_STUB_100=S1; Path=/'],
        });
        expect(transport.sessionEstablished()).toBe(true);
        transport.ingest({ 'set-cookie': [deletion] });
        expect(transport.sessionFingerprint().size).toBe(0);
        expect(transport.sessionEstablished()).toBe(false);
        // Nor does the deleted cookie ride on the next request.
        expect(transport.cookies() ?? '').not.toContain('SAP_SESSIONID');
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
      expect(bare.cookies()).toBeNull();
      await turns(5);
      expect(server.logoffs()).toBe(0);
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
      expect(transport.sessionEstablished()).toBe(true);
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
      expect(transport.sessionEstablished()).toBe(false);
      const sent = transport.cookies() ?? '';
      expect(sent).not.toContain('SAP_SESSIONID');
      expect(sent).not.toContain('sap-contextid');
    });

    it('an empty SAP_SESSIONID value names no session: nothing is sent', async () => {
      server = await standIn();
      const transport = onPremHttpTransport(configFor(server.baseUrl));
      transport.ingest({ 'set-cookie': ['SAP_SESSIONID_STUB_100=; Path=/'] });
      expect(transport.sessionEstablished()).toBe(false);
      await transport.close({
        baseUrl: server.baseUrl,
        authorize: async () => {},
        logon: async () => {},
        observe: () => {},
      });
      await turns(5);
      expect(server.logoffs()).toBe(0);
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

      await expect(conn.connect()).rejects.toThrow(/opened no ABAP session/);
      await expect(conn.disconnect()).resolves.toBeUndefined();
      await turns(5);
      expect(server.logoffs()).toBe(0);
    });

    it("the failing answer's cookie is the one the goodbye carries, snapshot before the clearing", async () => {
      server = await standIn({ discoveryStatus: 404 });
      const conn = onPrem(configFor(server.baseUrl), null);

      await expect(conn.connect()).rejects.toBeDefined();
      // Cleared by now: the goodbye took its cookie before that.
      expect(conn.transport.cookies()).toBeNull();
      const logoff = await server.logoffArrived;
      expect(logoff.headers.cookie).toContain('SAP_SESSIONID_STUB_100=S1');
      server.answerLogoff();
    }, 30_000);
  });

  describe('the logoff never carries sap-contextid', () => {
    // Measured on E19 (2026-10-13, bare HTTP): a logoff without the context
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
      expect(cookie).toContain('SAP_SESSIONID_STUB_100=S1');
      expect(cookie).toContain('sap-usercontext=');
      expect(cookie).not.toContain('sap-contextid');
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
      expect(cookie).toContain('SAP_SESSIONID_STUB_100=S1');
      expect(cookie).not.toContain('sap-contextid');
      server.answerLogoff();
    });
  });

  describe('a replaced ABAP session in a lock window', () => {
    it('logs the security session off at once — one logoff, with the original SAP_SESSIONID and no sap-contextid; disconnect() then sends nothing more', async () => {
      server = await standIn({
        routes: {
          '/sap/bc/adt/lock': ['sap-contextid=A; path=/sap/bc/adt'],
          '/sap/bc/adt/write': ['sap-contextid=B; path=/sap/bc/adt'],
        },
      });
      const conn = onPrem(configFor(server.baseUrl), null);
      await conn.connect();
      conn.beginCriticalSection();
      conn.setSessionType('stateful');

      await conn.makeAdtRequest({
        url: '/sap/bc/adt/lock',
        method: 'POST',
        timeout: 5000,
      });
      await expect(
        conn.makeAdtRequest({
          url: '/sap/bc/adt/write',
          method: 'PUT',
          data: 'x',
          timeout: 5000,
        }),
      ).rejects.toMatchObject({ code: 'ADT_SESSION_REPLACED' });

      const logoff = await server.logoffArrived;
      const cookie = String(logoff.headers.cookie ?? '');
      expect(cookie).toContain('SAP_SESSIONID_STUB_100=S1');
      expect(cookie).not.toContain('sap-contextid');

      // The caller's disconnect(): its first of this life, so it resolves —
      // once that logoff is written — and sends nothing more.
      await expect(conn.disconnect()).resolves.toBeUndefined();
      await turns(5);
      expect(server.logoffs()).toBe(1);

      // flushGoodbye() waits for that logoff's answer.
      const flushed = watched(conn.flushGoodbye(60_000));
      await turns(2);
      expect(flushed()).toBe(false);
      server.answerLogoff();
      await conn.flushGoodbye(60_000);
      conn.endCriticalSection();
    });

    /** Connected, in a lock window, the context replaced; the logoff's bytes held. */
    async function replacedWithHeldLogoff(provider?: unknown) {
      server = await standIn({
        routes: {
          '/sap/bc/adt/lock': ['sap-contextid=A; path=/sap/bc/adt'],
          '/sap/bc/adt/write': ['sap-contextid=B; path=/sap/bc/adt'],
        },
      });
      const { AdtOnPremConnector } = await import(
        '../connection/AdtOnPremConnector.js'
      );
      const { BasicAuthProvider } = await import(
        '@mcp-abap-adt/auth-providers'
      );
      const conn = new AdtOnPremConnector(
        configFor(server.baseUrl),
        (provider ?? new BasicAuthProvider('u', 'p')) as never,
        onPremHttpTransport(configFor(server.baseUrl)),
        null,
      );
      await conn.connect();
      const wire = bytesNeverTaken(conn.transport);
      conn.beginCriticalSection();
      conn.setSessionType('stateful');
      await conn.makeAdtRequest({
        url: '/sap/bc/adt/lock',
        method: 'POST',
        timeout: 5000,
      });
      await expect(
        conn.makeAdtRequest({
          url: '/sap/bc/adt/write',
          method: 'PUT',
          data: 'x',
          timeout: 5000,
        }),
      ).rejects.toMatchObject({ code: 'ADT_SESSION_REPLACED' });
      conn.endCriticalSection();
      conn.setSessionType('stateless');
      return { conn, wire };
    }

    it('connect() after SESSION_REPLACED is refused; the old logoff is still awaited by disconnect()', async () => {
      const { conn, wire } = await replacedWithHeldLogoff();
      const establishments = server.establishments();

      // Codex's sequences need a reconnect on this instance; there is none.
      await expect(conn.connect()).rejects.toMatchObject({
        code: 'ADT_NOT_CONNECTED',
      });
      expect(server.establishments()).toBe(establishments);

      const disconnected = watched(conn.disconnect());
      await turns(20);
      expect(disconnected()).toBe(false);
      wire.fail();
      await turns(20, disconnected);
      expect(disconnected()).toBe(true);
    });

    it("the caller's disconnect() resolves only once that logoff is written", async () => {
      server = await standIn({
        routes: {
          '/sap/bc/adt/lock': ['sap-contextid=A; path=/sap/bc/adt'],
          '/sap/bc/adt/write': ['sap-contextid=B; path=/sap/bc/adt'],
        },
      });
      const conn = onPrem(configFor(server.baseUrl), null);
      await conn.connect();
      const wire = bytesNeverTaken(conn.transport);
      conn.beginCriticalSection();
      conn.setSessionType('stateful');

      await conn.makeAdtRequest({
        url: '/sap/bc/adt/lock',
        method: 'POST',
        timeout: 5000,
      });
      await expect(
        conn.makeAdtRequest({
          url: '/sap/bc/adt/write',
          method: 'PUT',
          data: 'x',
          timeout: 5000,
        }),
      ).rejects.toMatchObject({ code: 'ADT_SESSION_REPLACED' });

      const disconnected = watched(conn.disconnect());
      await turns(20);
      expect(disconnected()).toBe(false);
      wire.fail();
      await turns(20, disconnected);
      expect(disconnected()).toBe(true);
      conn.endCriticalSection();
    });
  });

  it('goes out on a connection of its own, closed after it', async () => {
    server = await standIn();
    const conn = onPrem(configFor(server.baseUrl), null);
    await conn.connect();
    const establishedOn = server.establishedOn();
    expect(establishedOn).toBeDefined();

    await conn.disconnect();
    const logoff = await server.logoffArrived;
    // Not the establishment's keep-alive socket, which the server may close
    // at any time: a write to that one could succeed and still be lost.
    expect(logoff.socket).not.toBe(establishedOn);
    expect(logoff.headers.connection).toBe('close');
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
    expect(logger.lines).toContain('Told the server the session is finished');
    expect(
      logger.lines.some((line) =>
        line.startsWith('Could not tell the server the session is finished'),
      ),
    ).toBe(false);
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
    expect(disconnected()).toBe(true);

    const flushed = watched(conn.flushGoodbye(60_000));
    await turns(2);
    expect(flushed()).toBe(false);
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
    expect(disconnected()).toBe(false);

    release();
    await turns(10, disconnected);
    expect(disconnected()).toBe(true);
  });
});
