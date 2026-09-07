import { AxiosError } from 'axios';
import { SamlAuthProvider, TokenAuthProvider } from '../auth/providers.js';
import type { SapConfig } from '../config/sapConfig.js';
import { AdtCloudConnector } from '../connection/AdtCloudConnector.js';
import type { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import type { ILogger } from '../logger.js';
import {
  cloudHttpTransport,
  onPrem,
  onPremHttpTransport,
} from './helpers/onPrem.js';
import { markConnectedForTest } from './helpers/session.js';
import { heldCookies, seedCookies } from './helpers/transportStub.js';

const mockLogger: ILogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
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

function attachMockAxios(conn: AdtOnPremConnector, fn: jest.Mock) {
  (conn as any).transport.send = fn;
}

describe('AbstractAbapConnection — CSRF retry behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('POST with cached CSRF token succeeds without retry', async () => {
    const conn = onPrem(baseConfig, mockLogger);
    markConnectedForTest(conn);
    (conn as any).transport.adoptCsrfToken('cached-token');
    seedCookies(conn, 'SAP_SESSIONID_HQ6=alive');

    const mock = jest.fn().mockResolvedValue({
      status: 200,
      data: 'ok',
      headers: {},
    });
    attachMockAxios(conn, mock);

    const res = await conn.makeAdtRequest({
      url: '/sap/bc/adt/ddic/domains/zfoo',
      method: 'POST',
      timeout: 30000,
      data: '<adtcore:objectReference/>',
    });

    expect(res.status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(1);
    expect((conn as any).transport.csrfToken()).toBe('cached-token');
    expect(heldCookies(conn)).toContain('SAP_SESSIONID_HQ6=alive');
  });

  it('403 with "CSRF" body refetches token and retries; cookies preserved', async () => {
    const conn = onPrem(baseConfig, mockLogger);
    markConnectedForTest(conn);
    (conn as any).transport.adoptCsrfToken('old-token');
    seedCookies(conn, 'SAP_SESSIONID_HQ6=alive');

    const mock = jest
      .fn()
      .mockRejectedValueOnce(
        makeAxiosError(403, 'CSRF token validation failed', {
          method: 'POST',
          url: 'https://sap.example.com/sap/bc/adt/ddic/domains/zfoo',
        }),
      )
      .mockResolvedValueOnce({
        status: 200,
        data: '',
        headers: { 'x-csrf-token': 'new-token' },
      })
      .mockResolvedValueOnce({ status: 200, data: 'ok', headers: {} });
    attachMockAxios(conn, mock);

    const res = await conn.makeAdtRequest({
      url: '/sap/bc/adt/ddic/domains/zfoo',
      method: 'POST',
      timeout: 30000,
      data: '<x/>',
    });

    expect(res.status).toBe(200);
    expect((conn as any).transport.csrfToken()).toBe('new-token');
    expect(heldCookies(conn)).toContain('SAP_SESSIONID_HQ6=alive');
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
    const upfront = jest
      .spyOn((conn as any).transport, 'establish')
      .mockRejectedValueOnce(upfrontFetchError);
    const fetchSpy = jest
      .spyOn(conn as any, 'fetchCsrfToken')
      .mockResolvedValueOnce('bootstrap-token');
    const mock = jest
      .fn()
      .mockRejectedValueOnce(
        makeAxiosError(401, '<html>login</html>', {
          method: 'POST',
          url: 'https://sap.example.com/sap/bc/adt/ddic/domains/zfoo',
        }),
      )
      .mockResolvedValueOnce({ status: 200, data: 'ok', headers: {} });
    attachMockAxios(conn, mock);

    const res = await conn.makeAdtRequest({
      url: '/sap/bc/adt/ddic/domains/zfoo',
      method: 'POST',
      timeout: 30000,
      data: '<x/>',
    });

    expect(res.status).toBe(200);
    expect((conn as any).transport.csrfToken()).toBe('bootstrap-token');
    expect(upfront).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('POST 401 with cached CSRF token: invalidates session, refetches, retries with new token/cookies', async () => {
    const conn = onPrem(baseConfig, mockLogger);
    markConnectedForTest(conn);
    (conn as any).transport.adoptCsrfToken('stale-token');
    seedCookies(conn, 'SAP_SESSIONID_HQ6=dead');

    const calls: AxiosCall[] = [];
    const mock = jest.fn().mockImplementation(async (cfg: AxiosCall) => {
      calls.push({
        method: cfg.method,
        url: cfg.url,
        headers: { ...(cfg.headers || {}) },
      });
      if (calls.length === 1) {
        throw makeAxiosError(401, '<html>Anmeldung fehlgeschlagen</html>', {
          method: cfg.method,
          url: cfg.url,
        });
      }
      if (calls.length === 2) {
        return {
          status: 200,
          data: '',
          headers: {
            'x-csrf-token': 'fresh-token',
            'set-cookie': ['SAP_SESSIONID_HQ6=fresh'],
          },
        };
      }
      return { status: 200, data: 'ok', headers: {} };
    });
    attachMockAxios(conn, mock);

    const res = await conn.makeAdtRequest({
      url: '/sap/bc/adt/ddic/domains/zfoo',
      method: 'POST',
      timeout: 30000,
      data: '<x/>',
    });

    expect(res.status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(3);

    const refetchCookie =
      calls[1]?.headers?.Cookie ?? calls[1]?.headers?.cookie;
    expect(refetchCookie ?? '').not.toContain('SAP_SESSIONID_HQ6=dead');

    expect(calls[2]?.headers?.['x-csrf-token']).toBe('fresh-token');
    const retryCookie = calls[2]?.headers?.Cookie ?? calls[2]?.headers?.cookie;
    expect(retryCookie ?? '').toContain('SAP_SESSIONID_HQ6=fresh');

    expect((conn as any).transport.csrfToken()).toBe('fresh-token');
  });

  it('401 with cached token, retry also 401: original AxiosError propagates', async () => {
    const conn = onPrem(baseConfig, mockLogger);
    markConnectedForTest(conn);
    (conn as any).transport.adoptCsrfToken('stale-token');
    seedCookies(conn, 'SAP_SESSIONID_HQ6=dead');

    const originalError = makeAxiosError(401, '<html>first</html>', {
      method: 'POST',
      url: 'https://sap.example.com/sap/bc/adt/ddic/domains/zfoo',
    });
    const secondError = makeAxiosError(401, '<html>second</html>', {
      method: 'POST',
      url: 'https://sap.example.com/sap/bc/adt/ddic/domains/zfoo',
    });

    let call = 0;
    const mock = jest.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) throw originalError;
      if (call === 2) {
        return {
          status: 200,
          data: '',
          headers: { 'x-csrf-token': 'fresh-token' },
        };
      }
      throw secondError;
    });
    attachMockAxios(conn, mock);

    await expect(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/ddic/domains/zfoo',
        method: 'POST',
        timeout: 30000,
        data: '<x/>',
      }),
    ).rejects.toBe(originalError);

    expect(mock).toHaveBeenCalledTimes(3);
  });

  it('401 with cached token, CSRF refetch fails: original AxiosError propagates', async () => {
    const conn = onPrem(baseConfig, mockLogger);
    markConnectedForTest(conn);
    (conn as any).transport.adoptCsrfToken('stale-token');
    seedCookies(conn, 'SAP_SESSIONID_HQ6=dead');

    const originalError = makeAxiosError(401, '<html>first</html>', {
      method: 'POST',
      url: 'https://sap.example.com/sap/bc/adt/ddic/domains/zfoo',
    });
    const refetchError = makeAxiosError(500, 'ICF service unavailable', {
      method: 'GET',
      url: 'https://sap.example.com/sap/bc/adt/core/discovery',
    });

    const fetchSpy = jest
      .spyOn(conn as any, 'fetchCsrfToken')
      .mockRejectedValue(refetchError);
    const mock = jest.fn().mockRejectedValue(originalError);
    attachMockAxios(conn, mock);

    await expect(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/ddic/domains/zfoo',
        method: 'POST',
        timeout: 30000,
        data: '<x/>',
      }),
    ).rejects.toBe(originalError);

    expect(mock).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('GET 401 with cached token: does NOT invalidate session (new branch is mutation-only)', async () => {
    const conn = onPrem(baseConfig, mockLogger);
    markConnectedForTest(conn);
    (conn as any).transport.adoptCsrfToken('cached-token');
    seedCookies(conn, 'SAP_SESSIONID_HQ6=alive');

    const mock = jest
      .fn()
      .mockRejectedValueOnce(
        makeAxiosError(401, '<html>login</html>', {
          method: 'GET',
          url: 'https://sap.example.com/sap/bc/adt/oo/classes/zcl_x',
        }),
      )
      .mockResolvedValueOnce({ status: 200, data: 'ok', headers: {} });
    attachMockAxios(conn, mock);

    const res = await conn.makeAdtRequest({
      url: '/sap/bc/adt/oo/classes/zcl_x',
      method: 'GET',
      timeout: 30000,
    });

    expect(res.status).toBe(200);
    expect((conn as any).transport.csrfToken()).toBe('cached-token');
    expect(heldCookies(conn)).toContain('SAP_SESSIONID_HQ6=alive');
  });

  it('GET 401 with cookies retries with cookies (existing GET branch)', async () => {
    const conn = onPrem(baseConfig, mockLogger);
    markConnectedForTest(conn);
    (conn as any).transport.adoptCsrfToken('whatever');
    seedCookies(conn, 'SAP_SESSIONID_HQ6=alive');

    const mock = jest.fn();
    mock
      .mockRejectedValueOnce(
        makeAxiosError(
          401,
          '<html>login</html>',
          {
            method: 'GET',
            url: 'https://sap.example.com/sap/bc/adt/oo/classes/zcl_x',
          },
          { 'set-cookie': ['SAP_SESSIONID_HQ6=new'] },
        ),
      )
      .mockResolvedValueOnce({ status: 200, data: 'ok', headers: {} });
    attachMockAxios(conn, mock);

    const res = await conn.makeAdtRequest({
      url: '/sap/bc/adt/oo/classes/zcl_x',
      method: 'GET',
      timeout: 30000,
    });

    expect(res.status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(2);
    expect((conn as any).transport.csrfToken()).toBe('whatever');
  });
});

describe('AbstractAbapConnection — headers that belong to the request', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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

    const mock = jest
      .fn()
      .mockResolvedValue({ status: 200, data: 'ok', headers: {} });
    attachMockAxios(conn, mock);

    await conn.makeAdtRequest({
      url: '/sap/bc/adt/oo/classes/zfoo/source/main',
      method: 'PUT',
      timeout: 30000,
      data: 'CLASS zfoo DEFINITION.',
      ...(headers ? { headers } : {}),
    });
    return (mock.mock.calls[0][0].headers ?? {}) as Record<string, string>;
  }

  it('sends sap-adt-request-id on a stateless request', async () => {
    const headers = await sent();
    expect(headers['sap-adt-request-id']).toMatch(/^[0-9a-f]{32}$/);
    // The one header that really is the session's stays out of it.
    expect(headers['x-sap-adt-sessiontype']).toBeUndefined();
  });

  it('gives each request its own id', async () => {
    const first = await sent();
    const second = await sent();
    expect(first['sap-adt-request-id']).not.toBe(second['sap-adt-request-id']);
  });

  it('asks for server-time by default, and stops when told to', async () => {
    expect((await sent())['X-sap-adt-profiling']).toBe('server-time');

    const quiet = await sent((conn) => {
      conn.setProfilingRequest(null);
    });
    expect(quiet['X-sap-adt-profiling']).toBeUndefined();
    expect(quiet['sap-adt-request-id']).toBeDefined();
  });

  it('asks for whatever the caller set', async () => {
    const headers = await sent((conn) => {
      conn.setProfilingRequest('server-time,response-size');
    });
    expect(headers['X-sap-adt-profiling']).toBe('server-time,response-size');
  });

  it('keeps a request id the caller supplied', async () => {
    // `adt-clients` does exactly this in `getDiscovery({ requestId })`: it logs
    // an id and needs that id to be the one on the wire. A generated
    // replacement is not a smaller version of that guarantee, it is none.
    const headers = await sent(undefined, {
      'sap-adt-request-id': 'caller-owns-this-one',
    });
    expect(headers['sap-adt-request-id']).toBe('caller-owns-this-one');
  });

  it('keeps a profiling value the caller supplied, in either case', async () => {
    const upper = await sent(undefined, {
      'X-sap-adt-profiling': 'response-size',
    });
    expect(upper['X-sap-adt-profiling']).toBe('response-size');

    // Header names are case-insensitive; a lookup that is not would write the
    // default alongside the caller's and send both.
    const lower = await sent(undefined, {
      'x-sap-adt-profiling': 'response-size',
    });
    expect(lower['x-sap-adt-profiling']).toBe('response-size');
    expect(lower['X-sap-adt-profiling']).toBeUndefined();
  });

  it('the session type is the only header that varies with the mode', async () => {
    const stateful = await sent((conn) => {
      conn.setSessionType('stateful');
    });
    expect(stateful['x-sap-adt-sessiontype']).toBe('stateful');
    expect(stateful['sap-adt-request-id']).toBeDefined();
    expect(stateful['X-sap-adt-profiling']).toBe('server-time');
  });
});
