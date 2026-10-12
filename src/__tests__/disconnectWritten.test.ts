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
import type { ILogger } from '../logger.js';
import { cloudHttpTransport, onPrem } from './helpers/onPrem.js';

const SESSION_DOCUMENT =
  '<http:session xmlns:http="http://www.sap.com/adt/http" xmlns:atom="http://www.w3.org/2005/Atom">' +
  '<atom:link href="/sap/bc/adt/core/http/sessions/ABC" rel="http://www.sap.com/adt/categories/core/http/sessions/securitysession"/>' +
  '<atom:link href="/sap/public/bc/icf/logoff" rel="http://www.sap.com/adt/categories/core/http/sessions/logoff"/>' +
  '</http:session>';

interface StandIn {
  baseUrl: string;
  /** Settles when the logoff request has reached the server. */
  logoffArrived: Promise<IncomingMessage>;
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
  } = {},
): Promise<StandIn> {
  const sessionCookie = options.sessionCookie ?? true;
  let arrived!: (request: IncomingMessage) => void;
  const logoffArrived = new Promise<IncomingMessage>((resolve) => {
    arrived = resolve;
  });
  let held: ServerResponse | undefined;
  let establishment: Socket | undefined;
  const cookies = sessionCookie
    ? ['SAP_SESSIONID_STUB_100=S1; Path=/']
    : ['sap-XSRF_STUB_100=X1; Path=/'];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    if (url.includes('/logoff')) {
      arrived(req);
      if (options.logoffStatus !== undefined) {
        res.writeHead(options.logoffStatus, { location: '/goodbye' });
        res.end('');
        return;
      }
      held = res;
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
    if (options.discoveryStatus !== undefined) {
      res.writeHead(options.discoveryStatus, { 'content-type': 'text/plain' });
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

    it('a connect() starts a new life: its disconnect() is owed once again', async () => {
      server = await standIn();
      const conn = onPrem(configFor(server.baseUrl), null);
      await conn.connect();
      await conn.disconnect();
      await conn.connect();
      await expect(conn.disconnect()).resolves.toBeUndefined();
      server.answerLogoff();
    });
  });

  describe('a failed connect() rejects only once its own goodbye is written', () => {
    it('authenticated, no ABAP session', async () => {
      server = await standIn({ sessionCookie: false });
      const conn = onPrem(configFor(server.baseUrl), null);
      const wire = bytesNeverTaken(conn.transport);

      const connecting = conn.connect();
      const settled = watched(connecting);
      await wire.requested;
      await turns(20);
      // Refused, and still writing the goodbye to what the server did open.
      expect(settled()).toBe(false);

      wire.fail();
      await expect(connecting).rejects.toThrow(/opened no ABAP session/);
      // The caller's `finally`: its first disconnect() of this life.
      await expect(conn.disconnect()).resolves.toBeUndefined();
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
