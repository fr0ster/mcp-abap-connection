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
import { WireLogonError } from '../connection/authErrors.js';
import { refusalOf } from '../connection/IAdtTransport.js';
import { OnPremHttpTransport } from '../connection/OnPremHttpTransport.js';
import { instanceOf } from './helpers/assertions.js';
import { httpClientStub, type StubResponse } from './helpers/httpClientStub.js';
import { stubProvider } from './helpers/stubProvider.js';

const DISCOVERY = '/sap/bc/adt/core/discovery';
const WORK = '/sap/bc/adt/oo/classes/zcl_x/source/main';
const ELSEWHERE = '/sap/bc/adt/elsewhere';

interface Answer {
  /** `0`: the socket is destroyed, no byte written. */
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
      if (answer.status === 0) {
        req.socket.destroy();
        return;
      }
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

  it('a mutation whose CSRF fetch fails: that answer with the flag; sent without a token, its 401 resent once, without', async () => {
    const { connection, transport } = await connected();
    try {
      for (const noResend of [true, false]) {
        sap.arrivals.length = 0;
        transport.adoptCsrfToken(null);
        // The upfront fetch fails, so the mutation goes without a token.
        sap.discovery.push({ status: 500 });
        sap.work.push({ status: 401, body: 'Logon failed' });
        if (noResend) {
          // The failed fetch is the answer: the mutation is not sent.
          await assert.rejects(connection.makeAdtRequest(write(true)), (e) => {
            assert.strictEqual(statusOf(e), 500);
            return true;
          });
          assert.deepStrictEqual(trace(), [['GET', DISCOVERY, 500]]);
          sap.work.length = 0;
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

  it('a 401 to the CSRF fetch: the answer with the flag, renewed and fetched again without', async () => {
    const provider = stubProvider();
    const { connection, transport } = await connected(provider);
    try {
      transport.adoptCsrfToken(null);
      sap.discovery.push({ status: 401, body: 'Logon failed' });
      await assert.rejects(connection.makeAdtRequest(write(true)), (e) => {
        // The refused logon, as the wire named it: no provider was asked.
        assert.strictEqual(instanceOf(e, WireLogonError).status, 401);
        return true;
      });
      assert.deepStrictEqual(trace(), [['GET', DISCOVERY, 401]]);
      assert.strictEqual(provider.rejections.length, 0);

      sap.arrivals.length = 0;
      transport.adoptCsrfToken(null);
      sap.discovery.push({ status: 401, body: 'Logon failed' });
      const response = await connection.makeAdtRequest(write(false));
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(trace(), [
        ['GET', DISCOVERY, 401],
        ['GET', DISCOVERY, 200],
        ['PUT', WORK, 200],
      ]);
      assert.strictEqual(provider.rejections.length, 1);
    } finally {
      await connection.disconnect();
    }
  });

  it('a dead pooled socket under the CSRF fetch: the answer with the flag, resent without', async () => {
    for (const noResend of [true, false]) {
      // A connection each: the fetch must go out on the socket the connect
      // left idle in the pool.
      const { connection, transport } = await connected();
      try {
        transport.adoptCsrfToken(null);
        sap.discovery.push({ status: 0 });
        if (noResend) {
          await assert.rejects(connection.makeAdtRequest(write(true)));
          assert.deepStrictEqual(trace(), [['GET', DISCOVERY, 0]]);
        } else {
          const response = await connection.makeAdtRequest(write(false));
          assert.strictEqual(response.status, 200);
          assert.deepStrictEqual(trace(), [
            ['GET', DISCOVERY, 0],
            ['GET', DISCOVERY, 200],
            ['PUT', WORK, 200],
          ]);
        }
      } finally {
        await connection.disconnect();
      }
    }
  });

  it('a 307 to the CSRF fetch: the answer with the flag, followed without', async () => {
    const { connection, transport } = await connected();
    const redirect = { status: 307, headers: { location: ELSEWHERE } };
    try {
      transport.adoptCsrfToken(null);
      sap.discovery.push(redirect);
      await assert.rejects(connection.makeAdtRequest(write(true)), (e) => {
        assert.strictEqual(statusOf(e), 307);
        return true;
      });
      assert.deepStrictEqual(trace(), [['GET', DISCOVERY, 307]]);

      sap.arrivals.length = 0;
      transport.adoptCsrfToken(null);
      sap.discovery.push(redirect);
      await connection.makeAdtRequest(write(false));
      assert.deepStrictEqual(trace().slice(0, 2), [
        ['GET', DISCOVERY, 307],
        ['GET', ELSEWHERE, 200],
      ]);
    } finally {
      await connection.disconnect();
    }
  });

  for (const [name, refusal, fallback] of [
    ['a 404 to the CSRF fetch', { status: 404, body: 'none' }, true],
    ['a 501 to the CSRF fetch', { status: 501, body: 'none' }, true],
    [
      'a 405 to the CSRF fetch that carries a token',
      { status: 405, body: 'no', headers: { 'x-csrf-token': 'T9' } },
      false,
    ],
  ] as const) {
    it(`${name}: the answer with the flag, the request not sent`, async () => {
      const { connection, transport } = await connected();
      try {
        transport.adoptCsrfToken(null);
        sap.discovery.push({ ...refusal });
        await assert.rejects(connection.makeAdtRequest(write(true)), (e) => {
          assert.strictEqual(statusOf(e), refusal.status);
          return true;
        });
        assert.deepStrictEqual(trace(), [['GET', DISCOVERY, refusal.status]]);

        sap.arrivals.length = 0;
        transport.adoptCsrfToken(null);
        sap.discovery.push({ ...refusal });
        await connection.makeAdtRequest(write(false));
        assert.deepStrictEqual(
          trace(),
          fallback
            ? [
                ['GET', DISCOVERY, refusal.status],
                ['GET', '/sap/bc/adt/discovery', 200],
                ['PUT', WORK, 200],
              ]
            : [
                ['GET', DISCOVERY, refusal.status],
                ['PUT', WORK, 200],
              ],
        );
      } finally {
        await connection.disconnect();
      }
    });
  }

  it('a client that resolves a refusal: under the flag a token comes only from a 2xx', async () => {
    for (const noResend of [true, false]) {
      let fetches = 0;
      const client = httpClientStub(async (request): Promise<StubResponse> => {
        if (request.url.endsWith(DISCOVERY)) {
          fetches += 1;
          // The connect's fetch earns the session; the next is a 405 that
          // still carries a token, resolved by this client.
          return fetches === 1
            ? {
                status: 200,
                headers: {
                  'x-csrf-token': 'T1',
                  'set-cookie': 'SAP_SESSIONID_STUB_100=S1; Path=/',
                },
              }
            : {
                status: 405,
                data: 'refused BODY',
                headers: { 'x-csrf-token': 'T2' },
              };
        }
        return { status: 200, data: 'ok' };
      });
      const transport = new OnPremHttpTransport(() => ({}), null, {
        client: '100',
        baseUrl: 'http://sap.invalid',
        httpClient: client,
      });
      const connection = new AdtOnPremConnector(
        { url: 'http://sap.invalid', authType: 'basic', client: '100' },
        new BasicAuthProvider('u', 'p'),
        transport,
        null,
      );
      await connection.connect();
      try {
        transport.adoptCsrfToken(null);
        const sent = connection.makeAdtRequest(write(noResend));
        if (noResend) {
          // SAP's answer, as an ordinary refusal carries it.
          await assert.rejects(sent, (e) => {
            assert.strictEqual(refusalOf(e)?.status, 405);
            assert.strictEqual(refusalOf(e)?.data, 'refused BODY');
            return true;
          });
        } else await sent;
        const puts = client.sent.filter((r) => r.method === 'PUT');
        assert.strictEqual(puts.length, noResend ? 0 : 1);
      } finally {
        await connection.disconnect();
      }
    }
  });

  it('with noLog too, the resolved refusal of the fetch is the quiet line’s status', async () => {
    const lines: { message: string; meta: unknown }[] = [];
    const record = (message: string, meta?: unknown) => {
      lines.push({ message, meta });
    };
    const logger = { info: record, warn: record, error: record, debug: record };
    let fetches = 0;
    const client = httpClientStub(async (request): Promise<StubResponse> => {
      if (request.url.endsWith(DISCOVERY)) {
        fetches += 1;
        return fetches === 1
          ? {
              status: 200,
              headers: {
                'x-csrf-token': 'T1',
                'set-cookie': 'SAP_SESSIONID_STUB_100=S1; Path=/',
              },
            }
          : { status: 405, data: 'refused BODY' };
      }
      return { status: 200, data: 'ok' };
    });
    const transport = new OnPremHttpTransport(() => ({}), logger, {
      client: '100',
      baseUrl: 'http://sap.invalid',
      httpClient: client,
    });
    const connection = new AdtOnPremConnector(
      { url: 'http://sap.invalid', authType: 'basic', client: '100' },
      new BasicAuthProvider('u', 'p'),
      transport,
      logger,
    );
    await connection.connect();
    try {
      transport.adoptCsrfToken(null);
      lines.length = 0;
      await assert.rejects(
        connection.makeAdtRequest({ ...write(true), noLog: true }),
      );
      const bytes = Buffer.byteLength('refused BODY');
      assert.deepStrictEqual(lines, [
        {
          message: `PUT ${WORK} → 405 (${bytes} bytes)`,
          meta: { method: 'PUT', path: WORK, status: 405, bytes },
        },
      ]);
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
