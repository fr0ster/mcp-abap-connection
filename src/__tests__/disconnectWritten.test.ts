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
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { Duplex } from 'node:stream';
import type { SapConfig } from '../config/sapConfig.js';
import { onPrem } from './helpers/onPrem.js';

interface StandIn {
  baseUrl: string;
  /** Settles when the logoff request has reached the server. */
  logoffArrived: Promise<void>;
  /** Sends the held answer to the logoff. */
  answerLogoff: () => void;
  close: () => Promise<void>;
}

/** Answers the establishment, and HOLDS its answer to the logoff. */
async function standIn(): Promise<StandIn> {
  let arrived!: () => void;
  const logoffArrived = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let held: ServerResponse | undefined;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    if (url.includes('/logoff')) {
      held = res;
      arrived();
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/atomsvc+xml',
      'x-csrf-token': 'TOKEN',
      'set-cookie': ['SAP_SESSIONID_STUB_100=S1; Path=/'],
    });
    res.end('<service/>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    logoffArrived,
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

describe('disconnect() resolves once the logoff is written', () => {
  let server: StandIn;
  beforeEach(async () => {
    server = await standIn();
  });
  afterEach(async () => {
    await server.close();
  });

  it('has resolved while the server holds its answer; flushGoodbye() has not', async () => {
    const conn = onPrem(configFor(server.baseUrl), null);
    await conn.connect();

    const disconnected = watched(conn.disconnect());
    await server.logoffArrived;
    await drained();
    // The logoff is on the server, unanswered: disconnect() is done with it.
    expect(disconnected()).toBe(true);

    // flushGoodbye() is the wait for the answer, and the answer is held.
    const flushed = watched(conn.flushGoodbye(60_000));
    await drained();
    await drained();
    expect(flushed()).toBe(false);

    server.answerLogoff();
    await conn.flushGoodbye(60_000);
    expect(conn.isConnected()).toBe(false);
  });

  it('a server that never takes the bytes: disconnect() waits for the write, and resolves when the socket fails', async () => {
    const conn = onPrem(configFor(server.baseUrl), null);
    await conn.connect();

    // A socket that accepts nothing: every write stays pending, so the
    // request's `finish` never comes.
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
    const transport = conn.transport as unknown as {
      logoffRequest: (
        options: Record<string, unknown>,
        onResponse: (response: IncomingMessage) => void,
      ) => unknown;
    };
    const { request } = await import('node:http');
    transport.logoffRequest = (options, onResponse) =>
      request(
        {
          ...options,
          agent: undefined,
          createConnection: () => socket,
        } as never,
        onResponse,
      );

    const disconnected = watched(conn.disconnect());
    // A second call joins the same teardown, and waits for the same write.
    const joined = watched(conn.disconnect());
    for (let turn = 0; turn < 20; turn += 1) await drained();
    // Nothing written: disconnect() has not resolved, and no timer of its own
    // will make it.
    expect(disconnected()).toBe(false);
    expect(joined()).toBe(false);
    expect(conn.isConnected()).toBe(false);

    // The socket fails: the failure is logged, not thrown, and the teardown
    // completes.
    socket.destroy(new Error('the server never took the bytes'));
    for (let turn = 0; turn < 20 && !disconnected(); turn += 1) {
      await drained();
    }
    expect(disconnected()).toBe(true);
    expect(joined()).toBe(true);
    await expect(conn.flushGoodbye(60_000)).resolves.toBeUndefined();
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
    for (let turn = 0; turn < 10; turn += 1) await drained();
    expect(disconnected()).toBe(false);

    release();
    for (let turn = 0; turn < 10 && !disconnected(); turn += 1) {
      await drained();
    }
    expect(disconnected()).toBe(true);
  });
});
