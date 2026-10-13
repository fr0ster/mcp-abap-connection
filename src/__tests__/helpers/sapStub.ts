/**
 * A local SAP over `node:http`, for tests that run a real HTTP wire.
 *
 * It does what SAP does with the two things a request's recovery depends on:
 *
 * - discovery issues a new CSRF token each time it is asked, and a session
 *   cookie with it — the session the request already carries when it carries
 *   one, a new session when it carries none;
 * - a POST, PUT or DELETE whose `x-csrf-token` is not the latest token issued is
 *   answered `403 CSRF token validation failed`, before anything queued. A
 *   mutation that went out without the new token fails the test instead of
 *   passing it.
 *
 * Everything else answers from queues: one for discovery, and one per work
 * path. A queue is consumed in order; an empty one answers 200. Every request
 * is recorded, refusals included.
 *
 * With `authenticate` on, it also does what SAP does with a request that
 * proves nothing: one carrying neither `Authorization` nor the cookie of a
 * session it holds is answered `401`. The ICF logoff ends the session its
 * cookie names, and a session can be ended by hand (`sessions.delete`).
 */
import { createServer, type Server } from 'node:http';

/** A status, or a status with a body and response headers. */
export type StubAnswer =
  | number
  | {
      status: number;
      body?: string;
      headers?: Record<string, string | string[]>;
      /**
       * Called when the request arrives; the answer waits for it to settle —
       * for a test that acts while the request is in flight.
       */
      hold?: () => Promise<void>;
    };

export interface StubRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  status: number;
}

export interface SapStub {
  baseUrl: string;
  /** Answers for the next discovery requests, in order. */
  discovery: StubAnswer[];
  /** Queues the answers for the next requests to `path`, in order. */
  work(path: string, answers: StubAnswer[]): void;
  /** Every request, in arrival order. */
  requests: StubRequest[];
  /** Refuse, with `401`, a request with no credential and no live session. */
  authenticate: boolean;
  /** The sessions alive, by `SAP_SESSIONID` value. */
  sessions: Set<string>;
  /** The tokens issued, in order; the last one is the one SAP accepts. */
  tokens: string[];
  /** The work requests to `path`. */
  sentTo(path: string): StubRequest[];
  close(): Promise<void>;
}

const SESSION_COOKIE = 'SAP_SESSIONID_STUB_100';

function heldSession(cookie: string | undefined): string | undefined {
  const pair = (cookie ?? '')
    .split(/;\s*/)
    .find((entry) => entry.startsWith(`${SESSION_COOKIE}=`));
  return pair?.slice(SESSION_COOKIE.length + 1);
}

function asAnswer(answer: StubAnswer | undefined): {
  status: number;
  body: string;
  headers: Record<string, string | string[]>;
} {
  if (answer === undefined) return { status: 200, body: '', headers: {} };
  if (typeof answer === 'number')
    return { status: answer, body: '', headers: {} };
  return {
    status: answer.status,
    body: answer.body ?? '',
    headers: answer.headers ?? {},
  };
}

export async function startSapStub(): Promise<SapStub> {
  const discovery: StubAnswer[] = [];
  const work = new Map<string, StubAnswer[]>();
  const requests: StubRequest[] = [];
  const tokens: string[] = [];
  /** How many sessions were ever opened: an ended one's id is not reused. */
  let opened = 0;
  const sessions = new Set<string>();
  const flags = { authenticate: false };

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    const method = (req.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[name] = value;
      else if (Array.isArray(value)) headers[name] = value.join(', ');
    }
    const record = (status: number) =>
      requests.push({ method, path, headers, status });

    // Drained before answering, so a request with a body is read whole.
    req.resume();
    // The answer may await a `hold`, and nobody awaits this handler: whatever
    // it throws is caught here, never left as an unhandled rejection.
    const respond = async () => {
      const held = heldSession(headers.cookie);
      const live = held !== undefined && sessions.has(held);
      if (path === '/sap/public/bc/icf/logoff' && live) sessions.delete(held);
      if (
        flags.authenticate &&
        path !== '/sap/public/bc/icf/logoff' &&
        !headers.authorization &&
        !live
      ) {
        record(401);
        res.writeHead(401, {
          'content-type': 'text/plain',
          'www-authenticate': 'Basic realm="SAP NetWeaver Application Server"',
        });
        res.end('Logon failed');
        return;
      }
      if (path.includes('/discovery')) {
        const next = discovery.shift();
        if (typeof next === 'object') await next.hold?.();
        const answer = asAnswer(next);
        record(answer.status);
        if (answer.status !== 200) {
          res.writeHead(answer.status, {
            'content-type': 'text/plain',
            ...answer.headers,
          });
          res.end(answer.body);
          return;
        }
        const token = `TOKEN-${tokens.length + 1}`;
        tokens.push(token);
        const session = live ? held : `S${opened + 1}`;
        if (!live) opened++;
        sessions.add(session);
        res.writeHead(200, {
          'content-type': 'application/atomsvc+xml',
          'x-csrf-token': token,
          'set-cookie': [`${SESSION_COOKIE}=${session}; Path=/`],
          ...answer.headers,
        });
        res.end('<service/>');
        return;
      }

      const mutation = ['POST', 'PUT', 'DELETE'].includes(method);
      if (mutation && headers['x-csrf-token'] !== tokens[tokens.length - 1]) {
        record(403);
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('CSRF token validation failed');
        return;
      }

      const queued = work.get(path)?.shift();
      if (typeof queued === 'object') await queued.hold?.();
      const answer = asAnswer(queued);
      record(answer.status);
      res.writeHead(answer.status, {
        'content-type': 'text/plain',
        ...answer.headers,
      });
      res.end(answer.body);
    };
    req.on('end', () => {
      respond().catch(() => res.destroy());
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    discovery,
    work: (path, answers) => {
      work.set(path, [...(work.get(path) ?? []), ...answers]);
    },
    requests,
    get authenticate() {
      return flags.authenticate;
    },
    set authenticate(on: boolean) {
      flags.authenticate = on;
    },
    sessions,
    tokens,
    sentTo: (path) => requests.filter((request) => request.path === path),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
