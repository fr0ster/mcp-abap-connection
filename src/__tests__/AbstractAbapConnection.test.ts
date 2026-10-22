import assert from 'node:assert/strict';
import { beforeEach, describe, it, type Mock, mock } from 'node:test';
import { AxiosError } from 'axios';
import type { SapConfig } from '../config/sapConfig.js';
import type { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import type { ILogger } from '../logger.js';
import { answering } from './helpers/answering.js';
import { assertMatchObject } from './helpers/assertions.js';
import { onPrem } from './helpers/onPrem.js';
import { markConnectedForTest } from './helpers/session.js';
import { heldCookies, seedCookies } from './helpers/transportStub.js';

const mockLogger: ILogger = {
  info: mock.fn(),
  warn: mock.fn(),
  error: mock.fn(),
  debug: mock.fn(),
};

const baseConfig: SapConfig = {
  url: 'https://sap.example.com',
  authType: 'basic',
  username: 'u',
  password: 'p',
  client: '100',
};

type AxiosCall = {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
};

function makeAxiosError(
  status: number,
  data: unknown,
  config: AxiosCall = {},
  headers: Record<string, string | string[]> = {},
): AxiosError {
  const err = new AxiosError(
    `Request failed with status ${status}`,
    String(status),
    config as any,
    null,
    {
      status,
      statusText: '',
      data,
      headers,
      config: config as any,
    } as any,
  );
  return err;
}

function attachMockAxios(conn: AdtOnPremConnector, fn: Mock<any>) {
  (conn as any).transport.send = fn;
}

describe('AbstractAbapConnection — CSRF retry behavior', () => {
  beforeEach(() => {
    for (const fn of Object.values(mockLogger)) {
      (fn as Mock<any>).mock.resetCalls();
    }
  });

  it('POST with cached CSRF token succeeds without retry', async () => {
    const conn = onPrem(baseConfig, mockLogger);
    markConnectedForTest(conn);
    (conn as any).transport.adoptCsrfToken('cached-token');
    seedCookies(conn, 'SAP_SESSIONID_HQ6=alive');

    const send = mock.fn(async (..._args: any[]) => ({
      status: 200,
      data: 'ok',
      headers: {},
    }));
    attachMockAxios(conn, send);

    const res = await conn.makeAdtRequest({
      url: '/sap/bc/adt/ddic/domains/zfoo',
      method: 'POST',
      timeout: 30000,
      data: '<adtcore:objectReference/>',
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(send.mock.callCount(), 1);
    assert.strictEqual((conn as any).transport.csrfToken(), 'cached-token');
    assert.ok(heldCookies(conn)?.includes('SAP_SESSIONID_HQ6=alive'));
  });

  it('403 with "CSRF" body refetches token and retries; cookies preserved', async () => {
    const conn = onPrem(baseConfig, mockLogger);
    markConnectedForTest(conn);
    (conn as any).transport.adoptCsrfToken('old-token');
    seedCookies(conn, 'SAP_SESSIONID_HQ6=alive');

    const send = answering(
      {
        reject: makeAxiosError(403, 'CSRF token validation failed', {
          method: 'POST',
          url: 'https://sap.example.com/sap/bc/adt/ddic/domains/zfoo',
        }),
      },
      {
        resolve: {
          status: 200,
          data: '',
          headers: { 'x-csrf-token': 'new-token' },
        },
      },
      { resolve: { status: 200, data: 'ok', headers: {} } },
    );
    attachMockAxios(conn, send);

    const res = await conn.makeAdtRequest({
      url: '/sap/bc/adt/ddic/domains/zfoo',
      method: 'POST',
      timeout: 30000,
      data: '<x/>',
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual((conn as any).transport.csrfToken(), 'new-token');
    assert.ok(heldCookies(conn)?.includes('SAP_SESSIONID_HQ6=alive'));
  });

  it('POST 401 without cached token: refetches token and retries', async () => {
    const conn = onPrem(baseConfig, mockLogger);
    markConnectedForTest(conn);
    (conn as any).transport.adoptCsrfToken(null);
    (conn as any).transport.forgetSession();

    // Two levels, and they are different seams now. Getting the wire ready
    // before a mutation is the WIRE establishing itself; the refetch after a
    // 401 is the connection deciding the token it had is no good.
    const upfrontFetchError = new Error('upfront CSRF fetch unavailable');
    // A spy keeps the original for every call past the first.
    const upfront = mock.method((conn as any).transport, 'establish');
    upfront.mock.mockImplementationOnce(async () => {
      throw upfrontFetchError;
    });
    const fetchSpy = mock.method(conn as any, 'fetchCsrfToken');
    fetchSpy.mock.mockImplementationOnce(async () => 'bootstrap-token');
    const send = answering(
      {
        reject: makeAxiosError(401, '<html>login</html>', {
          method: 'POST',
          url: 'https://sap.example.com/sap/bc/adt/ddic/domains/zfoo',
        }),
      },
      { resolve: { status: 200, data: 'ok', headers: {} } },
    );
    attachMockAxios(conn, send);

    const res = await conn.makeAdtRequest({
      url: '/sap/bc/adt/ddic/domains/zfoo',
      method: 'POST',
      timeout: 30000,
      data: '<x/>',
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual((conn as any).transport.csrfToken(), 'bootstrap-token');
    assert.strictEqual(upfront.mock.callCount(), 1);
    assert.strictEqual(fetchSpy.mock.callCount(), 1);
    assert.strictEqual(send.mock.callCount(), 2);
  });

  // One instance is one session: a 401 on a mutation that holds a cached CSRF
  // token is not cured by discarding the session and opening another on this
  // instance. It goes to the provider like any 401; Basic cannot renew a
  // password, so the caller gets SAP's 401 as the cause of the refusal, and
  // nothing else is sent — no token fetch, no new session.
  it('POST 401 with a cached CSRF token: no new session is opened; the 401 reaches the caller', async () => {
    const conn = onPrem(baseConfig, mockLogger);
    markConnectedForTest(conn);
    (conn as any).transport.adoptCsrfToken('stale-token');
    seedCookies(conn, 'SAP_SESSIONID_HQ6=dead');

    const original = makeAxiosError(
      401,
      '<html>Anmeldung fehlgeschlagen</html>',
      {
        method: 'POST',
        url: 'https://sap.example.com/sap/bc/adt/ddic/domains/zfoo',
      },
    );
    const calls: AxiosCall[] = [];
    const send = mock.fn(async (cfg: AxiosCall) => {
      calls.push({ method: cfg.method, url: cfg.url });
      if (calls.length === 1) throw original;
      // A token fetch here would hand out a different session.
      return {
        status: 200,
        data: '',
        headers: {
          'x-csrf-token': 'fresh-token',
          'set-cookie': ['SAP_SESSIONID_HQ6=fresh'],
        },
      };
    });
    attachMockAxios(conn, send);

    await assert.rejects(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/ddic/domains/zfoo',
        method: 'POST',
        timeout: 30000,
        data: '<x/>',
      }),
      (e: unknown) => {
        assertMatchObject(e, {
          name: 'AuthRefusedError',
          at: 'request',
          cause: original,
        });
        return true;
      },
    );

    // Only the POST: no token fetch, no second session.
    assert.strictEqual(calls.length, 1);
    const held = heldCookies(conn);
    assert.ok(held?.includes('SAP_SESSIONID_HQ6=dead'));
    assert.ok(held !== null && !held.includes('fresh'));
    assert.strictEqual((conn as any).transport.csrfToken(), 'stale-token');
  });

  it('GET 401 with cookies held: nothing is resent before the provider; the 401 reaches the caller', async () => {
    const conn = onPrem(baseConfig, mockLogger);
    markConnectedForTest(conn);
    (conn as any).transport.adoptCsrfToken('cached-token');
    seedCookies(conn, 'SAP_SESSIONID_HQ6=alive');

    const original = makeAxiosError(
      401,
      '<html>login</html>',
      {
        method: 'GET',
        url: 'https://sap.example.com/sap/bc/adt/oo/classes/zcl_x',
      },
      { 'set-cookie': ['sap-usercontext=sap-client=100'] },
    );
    const send = answering(
      { reject: original },
      { resolve: { status: 200, data: 'ok', headers: {} } },
    );
    attachMockAxios(conn, send);

    await assert.rejects(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/oo/classes/zcl_x',
        method: 'GET',
        timeout: 30000,
      }),
      (e: unknown) => {
        assertMatchObject(e, {
          name: 'AuthRefusedError',
          at: 'request',
          cause: original,
        });
        return true;
      },
    );

    // Only the GET: the provider (Basic) answers no, and nothing else is sent.
    assert.strictEqual(send.mock.callCount(), 1);
    assert.strictEqual((conn as any).transport.csrfToken(), 'cached-token');
    assert.ok(heldCookies(conn)?.includes('SAP_SESSIONID_HQ6=alive'));
  });
});

describe('AbstractAbapConnection — headers that belong to the request', () => {
  beforeEach(() => {
    for (const fn of Object.values(mockLogger)) {
      (fn as Mock<any>).mock.resetCalls();
    }
  });

  /** A stateless request, and what it carried. */
  async function sent(
    prepare?: (conn: ReturnType<typeof onPrem>) => void,
    headers?: Record<string, string>,
  ): Promise<Record<string, string>> {
    const conn = onPrem(baseConfig, mockLogger);
    markConnectedForTest(conn);
    (conn as any).transport.adoptCsrfToken('t');
    prepare?.(conn);

    const send = mock.fn(async (..._args: any[]) => ({
      status: 200,
      data: 'ok',
      headers: {},
    }));
    attachMockAxios(conn, send);

    await conn.makeAdtRequest({
      url: '/sap/bc/adt/oo/classes/zfoo/source/main',
      method: 'PUT',
      timeout: 30000,
      data: 'CLASS zfoo DEFINITION.',
      ...(headers ? { headers } : {}),
    });
    return (send.mock.calls[0].arguments[0].headers ?? {}) as Record<
      string,
      string
    >;
  }

  it('sends sap-adt-request-id on a stateless request', async () => {
    const headers = await sent();
    assert.match(headers['sap-adt-request-id'], /^[0-9a-f]{32}$/);
    // The one header that really is the session's stays out of it.
    assert.strictEqual(headers['x-sap-adt-sessiontype'], undefined);
  });

  it('gives each request its own id', async () => {
    const first = await sent();
    const second = await sent();
    assert.notStrictEqual(
      first['sap-adt-request-id'],
      second['sap-adt-request-id'],
    );
  });

  it('asks for server-time by default, and stops when told to', async () => {
    assert.strictEqual((await sent())['X-sap-adt-profiling'], 'server-time');

    const quiet = await sent((conn) => {
      conn.setProfilingRequest(null);
    });
    assert.strictEqual(quiet['X-sap-adt-profiling'], undefined);
    assert.notStrictEqual(quiet['sap-adt-request-id'], undefined);
  });

  it('asks for whatever the caller set', async () => {
    const headers = await sent((conn) => {
      conn.setProfilingRequest('server-time,response-size');
    });
    assert.strictEqual(
      headers['X-sap-adt-profiling'],
      'server-time,response-size',
    );
  });

  it('keeps a request id the caller supplied', async () => {
    // `adt-clients` does exactly this in `getDiscovery({ requestId })`: it logs
    // an id and needs that id to be the one on the wire. A generated
    // replacement is not a smaller version of that guarantee, it is none.
    const headers = await sent(undefined, {
      'sap-adt-request-id': 'caller-owns-this-one',
    });
    assert.strictEqual(headers['sap-adt-request-id'], 'caller-owns-this-one');
  });

  it('keeps a profiling value the caller supplied, in either case', async () => {
    const upper = await sent(undefined, {
      'X-sap-adt-profiling': 'response-size',
    });
    assert.strictEqual(upper['X-sap-adt-profiling'], 'response-size');

    // Header names are case-insensitive; a lookup that is not would write the
    // default alongside the caller's and send both.
    const lower = await sent(undefined, {
      'x-sap-adt-profiling': 'response-size',
    });
    assert.strictEqual(lower['x-sap-adt-profiling'], 'response-size');
    assert.strictEqual(lower['X-sap-adt-profiling'], undefined);
  });

  it('says stateful to the wire as a flag, not as a header', async () => {
    // How the stateful session is asked for is the wire's: HTTP adds the
    // header and the context cookie, RFC neither. The connection only says so.
    const conn = onPrem(baseConfig, mockLogger);
    markConnectedForTest(conn);
    (conn as any).transport.adoptCsrfToken('t');
    const send = mock.fn(async (..._args: any[]) => ({
      status: 200,
      data: 'ok',
      headers: {},
    }));
    attachMockAxios(conn, send);

    conn.setSessionType('stateful');
    await conn.makeAdtRequest({ url: '/x', method: 'POST', timeout: 1000 });
    conn.setSessionType('stateless');
    await conn.makeAdtRequest({ url: '/x', method: 'POST', timeout: 1000 });

    const [stateful, stateless] = send.mock.calls.map((c) => c.arguments[0]);
    assert.strictEqual(stateful.stateful, true);
    assert.strictEqual(stateless.stateful, false);
    for (const request of [stateful, stateless]) {
      assert.strictEqual(request.headers['x-sap-adt-sessiontype'], undefined);
      assert.notStrictEqual(request.headers['sap-adt-request-id'], undefined);
      assert.strictEqual(request.headers['X-sap-adt-profiling'], 'server-time');
    }
  });
});
