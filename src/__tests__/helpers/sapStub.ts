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
  const sessions = new Set<string>();

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
    req.on('end', async () => {
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
        const held = heldSession(headers.cookie);
        const session =
          held && sessions.has(held) ? held : `S${sessions.size + 1}`;
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

      const answer = asAnswer(work.get(path)?.shift());
      record(answer.status);
      res.writeHead(answer.status, {
        'content-type': 'text/plain',
        ...answer.headers,
      });
      res.end(answer.body);
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
    tokens,
    sentTo: (path) => requests.filter((request) => request.path === path),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
