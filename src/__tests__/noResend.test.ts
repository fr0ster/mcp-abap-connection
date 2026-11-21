/**
 * `noResend: true` makes the first failure the caller's answer.
 *
 * Every replay of the request is gated: the CSRF recovery (a `403` naming
 * CSRF, any answer whose text holds `CSRF token`, a `401` to a mutation sent
 * without a token), the resend after a credential renewal, and — through the
 * wire — the resend on a dead pooled socket (`pooledResend.test.ts`). A
 * redirect from SAP's own endpoint is returned, not followed: following would
 * replay the request. The CSRF token fetch before a mutation still happens.
 *
 * Each case runs twice: with the flag, and without it, where the request
 * behaves as before — the ordinary call is unchanged.
 *
 * A real local server and the shipped HTTP wire, so what is counted is what
 * arrived on a socket.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { BasicAuthProvider } from '@mcp-abap-adt/auth-providers';
import type { IAbapRequestOptions } from '@mcp-abap-adt/interfaces-adt-connection';
import type { IAuthProvider } from '@mcp-abap-adt/interfaces-auth';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import { AuthRefusedError } from '../connection/authErrors.js';
import { refusalOf } from '../connection/IAdtTransport.js';
import { OnPremHttpTransport } from '../connection/OnPremHttpTransport.js';
import { stubProvider } from './helpers/stubProvider.js';

const DISCOVERY = '/sap/bc/adt/core/discovery';
const WORK = '/sap/bc/adt/oo/classes/zcl_x/source/main';
const ELSEWHERE = '/sap/bc/adt/elsewhere';

interface Answer {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

interface Arrival {
  method: string;
  path: string;
  status: number;
}

interface Sap {
  baseUrl: string;
  /** Answers for the next discovery requests; past the end, a token. */
  discovery: Answer[];
  /** Answers for the next other requests; past the end, `200 ok`. */
  work: Answer[];
  arrivals: Arrival[];
  close(): Promise<void>;
}

async function startSap(): Promise<Sap> {
  const sap: Sap = {
    baseUrl: '',
    discovery: [],
    work: [],
    arrivals: [],
    close: async () => {},
  };
  let issued = 0;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      const method = req.method ?? '';
      const queue = path === DISCOVERY ? sap.discovery : sap.work;
      const answer = queue.shift() ?? {
        status: 200,
        body: path === DISCOVERY ? '<service/>' : 'ok',
        headers:
          path === DISCOVERY
            ? {
                'x-csrf-token': `T${++issued}`,
                'set-cookie': 'SAP_SESSIONID_STUB_100=S1; Path=/',
              }
            : {},
      };
      sap.arrivals.push({ method, path, status: answer.status });
      res.writeHead(answer.status, {
        'content-type': 'text/plain',
        ...answer.headers,
      });
      res.end(answer.body ?? '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  sap.baseUrl = `http://127.0.0.1:${address.port}`;
  sap.close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  return sap;
}

let sap: Sap;

beforeEach(async () => {
  sap = await startSap();
});

afterEach(async () => {
  await sap.close();
});

async function connected(
  credential: IAuthProvider = new BasicAuthProvider('u', 'p'),
) {
  const transport = new OnPremHttpTransport(() => ({}), null, {
    client: '100',
    baseUrl: sap.baseUrl,
  });
  const connection = new AdtOnPremConnector(
    { url: sap.baseUrl, authType: 'basic', client: '100' },
    credential,
    transport,
    null,
  );
  await connection.connect();
  // What connect() sent is not this request's.
  sap.arrivals.length = 0;
  return { connection, transport };
}

/** The arrivals as `[method, path, status]`. */
function trace(): [string, string, number][] {
  return sap.arrivals.map((a) => [a.method, a.path, a.status]);
}

function write(noResend: boolean): IAbapRequestOptions {
  return {
    url: WORK,
    method: 'PUT',
    timeout: 5000,
    data: 'source',
    ...(noResend ? { noResend: true } : {}),
  };
}

function statusOf(error: unknown): number | undefined {
  return refusalOf(error)?.status;
}

describe('noResend', () => {
  it('a mutation still fetches its CSRF token first, and is sent once', async () => {
    const { connection, transport } = await connected();
    transport.adoptCsrfToken(null);
    try {
      const response = await connection.makeAdtRequest(write(true));
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(trace(), [
        ['GET', DISCOVERY, 200],
        ['PUT', WORK, 200],
      ]);
    } finally {
      await connection.disconnect();
    }
  });

  for (const [name, refusal] of [
    [
      'a 500 whose text holds "CSRF token"',
      { status: 500, body: 'CSRF token expired in the handler' },
    ],
    [
      'a 403 "CSRF token validation failed"',
      { status: 403, body: 'CSRF token validation failed' },
    ],
  ] as const) {
    it(`${name}: the answer with the flag, resent once without`, async () => {
      const { connection } = await connected();
      try {
        sap.work.push({ ...refusal });
        await assert.rejects(connection.makeAdtRequest(write(true)), (e) => {
          assert.strictEqual(statusOf(e), refusal.status);
          return true;
        });
        assert.deepStrictEqual(trace(), [['PUT', WORK, refusal.status]]);

        sap.arrivals.length = 0;
        sap.work.push({ ...refusal });
        const response = await connection.makeAdtRequest(write(false));
        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(trace(), [
          ['PUT', WORK, refusal.status],
          ['GET', DISCOVERY, 200],
          ['PUT', WORK, 200],
        ]);
      } finally {
        await connection.disconnect();
      }
    });
  }

  it('a 401 to a mutation sent without a token: the answer with the flag, resent once without', async () => {
    const { connection, transport } = await connected();
    try {
      for (const noResend of [true, false]) {
        sap.arrivals.length = 0;
        transport.adoptCsrfToken(null);
        // The upfront fetch fails, so the mutation goes without a token.
        sap.discovery.push({ status: 500 });
        sap.work.push({ status: 401, body: 'Logon failed' });
        if (noResend) {
          await assert.rejects(connection.makeAdtRequest(write(true)), (e) => {
            assert.strictEqual(statusOf(e), 401);
            assert.ok(!(e instanceof AuthRefusedError));
            return true;
          });
          assert.deepStrictEqual(trace(), [
            ['GET', DISCOVERY, 500],
            ['PUT', WORK, 401],
          ]);
        } else {
          const response = await connection.makeAdtRequest(write(false));
          assert.strictEqual(response.status, 200);
          assert.deepStrictEqual(trace(), [
            ['GET', DISCOVERY, 500],
            ['PUT', WORK, 401],
            ['GET', DISCOVERY, 200],
            ['PUT', WORK, 200],
          ]);
        }
      }
    } finally {
      await connection.disconnect();
    }
  });

  it('a 401 the provider renews: the answer with the flag, resent once without', async () => {
    const provider = stubProvider();
    const { connection } = await connected(provider);
    const read = (noResend: boolean): IAbapRequestOptions => ({
      url: WORK,
      method: 'GET',
      timeout: 5000,
      ...(noResend ? { noResend: true } : {}),
    });
    try {
      sap.work.push({ status: 401, body: 'Logon failed' });
      await assert.rejects(connection.makeAdtRequest(read(true)), (e) => {
        assert.strictEqual(statusOf(e), 401);
        return true;
      });
      assert.deepStrictEqual(trace(), [['GET', WORK, 401]]);
      assert.strictEqual(provider.rejections.length, 0);

      sap.arrivals.length = 0;
      sap.work.push({ status: 401, body: 'Logon failed' });
      const response = await connection.makeAdtRequest(read(false));
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(trace(), [
        ['GET', WORK, 401],
        ['GET', WORK, 200],
      ]);
      assert.strictEqual(provider.rejections.length, 1);
    } finally {
      await connection.disconnect();
    }
  });

  it('a 307 from SAP is the answer with the flag, followed without', async () => {
    const { connection } = await connected();
    const redirect = {
      status: 307,
      body: 'moved',
      headers: { location: ELSEWHERE },
    };
    try {
      sap.work.push(redirect);
      const response = await connection.makeAdtRequest(write(true));
      assert.strictEqual(response.status, 307);
      assert.deepStrictEqual(trace(), [['PUT', WORK, 307]]);

      sap.arrivals.length = 0;
      sap.work.push(redirect);
      const followed = await connection.makeAdtRequest(write(false));
      assert.strictEqual(followed.status, 200);
      assert.deepStrictEqual(trace(), [
        ['PUT', WORK, 307],
        ['PUT', ELSEWHERE, 200],
      ]);
    } finally {
      await connection.disconnect();
    }
  });

  it('every other status is still refused: a 404 rejects', async () => {
    const { connection } = await connected();
    try {
      sap.work.push({ status: 404, body: 'not found' });
      await assert.rejects(
        connection.makeAdtRequest({
          url: WORK,
          method: 'GET',
          timeout: 5000,
          noResend: true,
        }),
        (e) => {
          assert.strictEqual(statusOf(e), 404);
          return true;
        },
      );
      assert.deepStrictEqual(trace(), [['GET', WORK, 404]]);
    } finally {
      await connection.disconnect();
    }
  });
});
