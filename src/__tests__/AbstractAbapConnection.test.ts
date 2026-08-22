import { AxiosError } from 'axios';
import { SamlAuthProvider, TokenAuthProvider } from '../auth/providers.js';
import type { SapConfig } from '../config/sapConfig.js';
import { AdtCloudConnector } from '../connection/AdtCloudConnector.js';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
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

  it('JWT auth: 401 on POST with cached token does NOT trigger stale-CSRF retry', async () => {
    const jwtConfig: SapConfig = {
      url: 'https://sap.example.com',
      authType: 'jwt',
      jwtToken: 'jwt-abc',
      client: '100',
    };
    const conn = new AdtCloudConnector(
      jwtConfig,
      new TokenAuthProvider('jwt-abc'),
      cloudHttpTransport(jwtConfig, mockLogger),
      mockLogger,
    );
    markConnectedForTest(conn);
    (conn as any).transport.adoptCsrfToken('stale-token');
    seedCookies(conn, 'SAP_SESSIONID_HQ6=dead');

    const originalError = makeAxiosError(401, '<html>login</html>', {
      method: 'POST',
      url: 'https://sap.example.com/sap/bc/adt/ddic/domains/zfoo',
    });

    const mock = jest.fn().mockRejectedValue(originalError);
    attachMockAxios(conn as unknown as AdtOnPremConnector, mock);

    // The rejection is the server's own error, not one of ours. This used to
    // assert 'JWT token has expired. Please re-authenticate.' — a message
    // synthesised in place of the AxiosError, which threw away the status and
    // body a caller needs. Issue #30.
    await expect(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/ddic/domains/zfoo',
        method: 'POST',
        timeout: 30000,
        data: '<x/>',
      }),
    ).rejects.toMatchObject({ response: { status: 401 } });

    // The subject of this test, unchanged: no stale-CSRF retry, and the cached
    // token and cookies survive untouched.
    expect(mock).toHaveBeenCalledTimes(1);
    expect((conn as any).transport.csrfToken()).toBe('stale-token');
    expect(heldCookies(conn)).toContain('SAP_SESSIONID_HQ6=dead');
  });

  it('SAML auth: 401 on POST with cached token does NOT trigger stale-CSRF retry', async () => {
    const samlConfig: SapConfig = {
      url: 'https://sap.example.com',
      authType: 'saml',
      sessionCookies: 'MYSAPSSO2=abc',
      client: '100',
    };
    const conn = new AdtOnPremConnector(
      samlConfig,
      new SamlAuthProvider('MYSAPSSO2=abc'),
      onPremHttpTransport(samlConfig, mockLogger),
      mockLogger,
    );
    markConnectedForTest(conn);
    (conn as any).transport.adoptCsrfToken('stale-token');
    seedCookies(conn, 'MYSAPSSO2=abc; SAP_SESSIONID_HQ6=dead');

    const originalError = makeAxiosError(401, '<html>login</html>', {
      method: 'POST',
      url: 'https://sap.example.com/sap/bc/adt/ddic/domains/zfoo',
    });

    const mock = jest.fn().mockRejectedValue(originalError);
    attachMockAxios(conn as unknown as AdtOnPremConnector, mock);

    await expect(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/ddic/domains/zfoo',
        method: 'POST',
        timeout: 30000,
        data: '<x/>',
      }),
    ).rejects.toBe(originalError);

    expect(mock).toHaveBeenCalledTimes(1);
    expect((conn as any).transport.csrfToken()).toBe('stale-token');
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
