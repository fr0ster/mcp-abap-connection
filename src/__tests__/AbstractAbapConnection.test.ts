import { AxiosError } from 'axios';
import type { SapConfig } from '../config/sapConfig.js';
import { BaseAbapConnection } from '../connection/BaseAbapConnection.js';
import type { ILogger } from '../logger.js';

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

function attachMockAxios(conn: BaseAbapConnection, fn: jest.Mock) {
  (conn as any).axiosInstance = fn;
}

describe('AbstractAbapConnection — CSRF retry behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('POST with cached CSRF token succeeds without retry', async () => {
    const conn = new BaseAbapConnection(baseConfig, mockLogger);
    (conn as any).csrfToken = 'cached-token';
    (conn as any).cookies = 'SAP_SESSIONID_HQ6=alive';

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
    expect((conn as any).csrfToken).toBe('cached-token');
    expect((conn as any).cookies).toBe('SAP_SESSIONID_HQ6=alive');
  });

  it('403 with "CSRF" body refetches token and retries; cookies preserved', async () => {
    const conn = new BaseAbapConnection(baseConfig, mockLogger);
    (conn as any).csrfToken = 'old-token';
    (conn as any).cookies = 'SAP_SESSIONID_HQ6=alive';
    (conn as any).cookieStore.set('SAP_SESSIONID_HQ6', 'alive');

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
    expect((conn as any).csrfToken).toBe('new-token');
    expect((conn as any).cookies).toContain('SAP_SESSIONID_HQ6=alive');
  });

  it('POST 401 without cached token: refetches token and retries', async () => {
    const conn = new BaseAbapConnection(baseConfig, mockLogger);
    (conn as any).csrfToken = null;
    (conn as any).cookies = null;

    const upfrontFetchError = new Error('upfront CSRF fetch unavailable');
    const fetchSpy = jest
      .spyOn(conn as any, 'fetchCsrfToken')
      .mockRejectedValueOnce(upfrontFetchError)
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
    expect((conn as any).csrfToken).toBe('bootstrap-token');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('GET 401 with cookies retries with cookies (existing GET branch)', async () => {
    const conn = new BaseAbapConnection(baseConfig, mockLogger);
    (conn as any).csrfToken = 'whatever';
    (conn as any).cookies = 'SAP_SESSIONID_HQ6=alive';

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
    expect((conn as any).csrfToken).toBe('whatever');
  });
});
