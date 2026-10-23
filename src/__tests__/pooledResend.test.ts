/**
 * The HTTP wire pools its sockets, over `http:` and `https:` alike, and resends
 * a request once — on a new connection — only when it went out on a socket
 * taken from the pool and that socket ended with no byte of an answer.
 *
 * A server closes an idle kept-alive connection when it likes; a request
 * written onto it as it closes is lost unread. Left alone, a cleanup `UNLOCK`
 * died so with "socket hang up" and the enqueue lock stayed with the session
 * (mcp-abap-adt#314). The session is the cookies', not the socket's, so the
 * resend carries the same cookies and session headers.
 *
 * The real transport against real loopback servers: which socket a request
 * travels on, and what a server's close does to it, is not something a stub
 * under the client can show. The server here does not close an idle socket on
 * a timer (the client would see that close and drop the socket): it destroys
 * the socket when the next request arrives on it — the moment a close and a
 * write cross.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo, Server, Socket } from 'node:net';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { HttpTransport } from '../connection/HttpTransport.js';

const fixtures = join(__dirname, 'fixtures', 'tls');
const cert = readFileSync(join(fixtures, 'server.crt'), 'utf8');
const key = readFileSync(join(fixtures, 'server.key'), 'utf8');

/** What the server does with one arriving request. */
type Action =
  /** Answer `200 ok`. */
  | 'ok'
  /** Destroy the socket, no byte written. */
  | 'drop'
  /** Write half a status line, then destroy the socket. */
  | 'partial-head'
  /** Write the head and part of the body, then destroy the socket. */
  | 'partial-body';

interface Arrival {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  /** Which connection carried it: the order the server accepted it in. */
  socket: number;
  /** Which request this was on its connection, from 1. */
  onSocket: number;
  action: Action;
}

type Plan = (arrival: Omit<Arrival, 'action'>) => Action;

interface Stub {
  baseUrl: string;
  arrivals: Arrival[];
  plan: Plan;
  close(): Promise<void>;
}

async function listen(
  scheme: 'http' | 'https',
  make: (
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ) => Server,
): Promise<Stub> {
  const numbers = new WeakMap<Socket, { socket: number; served: number }>();
  let accepted = 0;
  const stub: Stub = {
    baseUrl: '',
    arrivals: [],
    plan: () => 'ok',
    close: async () => {},
  };
  const server = make((req, res) => {
    req.resume();
    const socket = req.socket;
    const known = numbers.get(socket) ?? { socket: -1, served: 0 };
    known.served += 1;
    const seen = {
      method: req.method ?? '',
      path: (req.url ?? '').split('?')[0] ?? '',
      headers: { ...req.headers },
      socket: known.socket,
      onSocket: known.served,
    };
    const action = stub.plan(seen);
    stub.arrivals.push({ ...seen, action });
    if (action === 'drop') {
      socket.destroy();
      return;
    }
    if (action === 'partial-head') {
      socket.write('HTTP/1.1 200 O', () => socket.destroy());
      return;
    }
    if (action === 'partial-body') {
      res.writeHead(200, { 'Content-Length': '100' });
      res.write('0123456789', () => socket.destroy());
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  server.on(
    scheme === 'https' ? 'secureConnection' : 'connection',
    (socket: Socket) => {
      accepted += 1;
      numbers.set(socket, { socket: accepted, served: 0 });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  stub.baseUrl = `${scheme}://127.0.0.1:${port}`;
  stub.close = () =>
    new Promise<void>((resolve) => {
      (
        server as unknown as { closeAllConnections?: () => void }
      ).closeAllConnections?.();
      server.close(() => resolve());
    });
  return stub;
}

/** The headers a stateful request carries: the session's cookies, its token. */
const SESSION_HEADERS = {
  Cookie: 'SAP_SESSIONID_E19_100=abc; sap-contextid=ctx-1',
  'x-csrf-token': 'token-1',
  'X-sap-adt-sessiontype': 'stateful',
};

function unlock(transport: HttpTransport) {
  return transport.send({
    method: 'POST',
    url: '/sap/bc/adt/oo/classes/zcl_test?_action=UNLOCK&lockHandle=H',
    headers: SESSION_HEADERS,
  });
}

function read(transport: HttpTransport) {
  return transport.send({
    method: 'GET',
    url: '/sap/bc/adt/discovery',
    headers: SESSION_HEADERS,
  });
}

/** Everything but the hop-by-hop `connection`, which the fresh agent sets. */
function endToEnd(headers: Arrival['headers']): Arrival['headers'] {
  const { connection: _hop, ...rest } = headers;
  return rest;
}

/** A plan: the first request on a reused socket is answered `action`. */
function onReuse(action: Action): Plan {
  let done = false;
  return (arrival) => {
    if (!done && arrival.onSocket > 1) {
      done = true;
      return action;
    }
    return 'ok';
  };
}

/** The arrivals as [method, request on its socket, action]. */
function trace(stub: Stub): [string, number, Action][] {
  return stub.arrivals.map((a) => [a.method, a.onSocket, a.action]);
}

function isReset(error: unknown): boolean {
  assert.strictEqual((error as { code?: string }).code, 'ECONNRESET');
  return true;
}

for (const scheme of ['http', 'https'] as const) {
  describe(`the pooled ${scheme}: wire`, () => {
    let stub: Stub;

    before(async () => {
      stub = await listen(scheme, (handler) =>
        scheme === 'https'
          ? createHttpsServer({ cert, key }, handler)
          : createHttpServer(handler),
      );
    });

    after(async () => {
      await stub.close();
    });

    beforeEach(() => {
      stub.arrivals.length = 0;
      stub.plan = () => 'ok';
    });

    function wire(): HttpTransport {
      return new HttpTransport(
        () => (scheme === 'https' ? { ca: cert } : {}),
        null,
        { baseUrl: stub.baseUrl },
      );
    }

    it('reuses one connection for sequential requests', async () => {
      const transport = wire();

      await read(transport);
      await read(transport);

      assert.deepStrictEqual(trace(stub), [
        ['GET', 1, 'ok'],
        ['GET', 2, 'ok'],
      ]);
      assert.strictEqual(stub.arrivals[0]?.socket, stub.arrivals[1]?.socket);
    });

    it('resends once on a new connection a request whose pooled socket ended with no answer', async () => {
      const transport = wire();
      stub.plan = onReuse('drop');

      await read(transport);
      const response = await unlock(transport);

      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(trace(stub), [
        ['GET', 1, 'ok'],
        ['POST', 2, 'drop'],
        ['POST', 1, 'ok'],
      ]);
      assert.strictEqual(stub.arrivals[1]?.socket, stub.arrivals[0]?.socket);
      assert.notStrictEqual(stub.arrivals[2]?.socket, stub.arrivals[1]?.socket);
    });

    it('sends the resend with the same cookies and session headers', async () => {
      const transport = wire();
      stub.plan = onReuse('drop');

      await read(transport);
      await unlock(transport);

      const [, dropped, resent] = stub.arrivals;
      assert.ok(dropped !== undefined && resent !== undefined);
      assert.strictEqual(dropped.action, 'drop');
      assert.strictEqual(resent.path, dropped.path);
      assert.strictEqual(resent.headers.cookie, SESSION_HEADERS.Cookie);
      assert.strictEqual(resent.headers['x-csrf-token'], 'token-1');
      assert.strictEqual(resent.headers['x-sap-adt-sessiontype'], 'stateful');
      assert.deepStrictEqual(
        endToEnd(resent.headers),
        endToEnd(dropped.headers),
      );
    });

    it('resends only once: a resend that fails too is the error', async () => {
      const transport = wire();
      // Two pooled sockets, so a second resend would find one to take.
      await Promise.all([read(transport), read(transport)]);
      stub.plan = (arrival) => (arrival.method === 'GET' ? 'ok' : 'drop');

      await assert.rejects(unlock(transport), isReset);

      assert.deepStrictEqual(trace(stub).slice(2), [
        ['POST', 2, 'drop'],
        ['POST', 1, 'drop'],
      ]);
    });

    it('resends on a connection opened for it, never on another pooled one', async () => {
      const transport = wire();
      await Promise.all([read(transport), read(transport)]);
      assert.notStrictEqual(stub.arrivals[0]?.socket, stub.arrivals[1]?.socket);
      // Every pooled socket is dead: a request on one is not answered.
      stub.plan = (arrival) => (arrival.onSocket > 1 ? 'drop' : 'ok');

      const response = await unlock(transport);

      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(trace(stub).slice(2), [
        ['POST', 2, 'drop'],
        ['POST', 1, 'ok'],
      ]);
    });

    it('does not resend a request that failed on a socket opened for it', async () => {
      const transport = wire();
      stub.plan = () => 'drop';

      await assert.rejects(unlock(transport), isReset);

      assert.deepStrictEqual(trace(stub), [['POST', 1, 'drop']]);
    });

    it('sends the logoff on a connection of its own, closed after it', async () => {
      const transport = wire();
      await read(transport);
      let written = 0;

      await (
        transport as unknown as {
          sendLogoff(
            context: unknown,
            url: string,
            snapshot: unknown,
            written: () => void,
          ): Promise<void>;
        }
      ).sendLogoff(
        { extraHeaders: {} },
        `${stub.baseUrl}/sap/public/bc/icf/logoff`,
        { cookies: SESSION_HEADERS.Cookie, affinity: {}, session: {} },
        () => {
          written += 1;
        },
      );

      assert.strictEqual(written, 1);
      assert.deepStrictEqual(trace(stub), [
        ['GET', 1, 'ok'],
        ['GET', 1, 'ok'],
      ]);
      assert.strictEqual(stub.arrivals[1]?.path, '/sap/public/bc/icf/logoff');
      assert.strictEqual(stub.arrivals[1]?.headers.connection, 'close');
    });

    for (const partial of ['partial-head', 'partial-body'] as const) {
      it(`does not resend a request that read part of an answer (${partial})`, async () => {
        const transport = wire();
        stub.plan = onReuse(partial);

        await read(transport);
        await assert.rejects(unlock(transport));

        assert.deepStrictEqual(trace(stub), [
          ['GET', 1, 'ok'],
          ['POST', 2, partial],
        ]);
      });
    }
  });
}

describe('the https: pool and the caller', () => {
  let stub: Stub;

  before(async () => {
    stub = await listen('https', (handler) =>
      createHttpsServer({ cert, key }, handler),
    );
  });

  after(async () => {
    await stub.close();
  });

  it("agentOptions' keepAlive: false turns the pool off: the caller's options win", async () => {
    const transport = new HttpTransport(
      () => ({ ca: cert, keepAlive: false }),
      null,
      { baseUrl: stub.baseUrl },
    );

    await read(transport);
    await read(transport);

    assert.deepStrictEqual(trace(stub), [
      ['GET', 1, 'ok'],
      ['GET', 1, 'ok'],
    ]);
  });
});
