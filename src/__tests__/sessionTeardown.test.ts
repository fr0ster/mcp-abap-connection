/**
 * disconnect() ends the session on the server, not only in the client.
 *
 * Dropping the cookie leaves the ABAP session alive until its own timeout, and
 * a process that connects repeatedly leaves one behind every time. Once enough
 * pile up the server stops issuing sessions at all — it answers with the XSRF
 * cookie instead — and a connection without a session still gets `200` for a
 * LOCK, handing back a handle the next request cannot use.
 */
import type { SapConfig } from '../config/sapConfig.js';
import { BaseAbapConnection } from '../connection/BaseAbapConnection.js';
import type { ILogger } from '../logger.js';

const baseConfig: SapConfig = {
  url: 'https://sap.example.com',
  authType: 'basic',
  username: 'u',
  password: 'p',
  client: '100',
};

function makeLogger(): ILogger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

type Seen = { url: string; method: string; headers: Record<string, string> };

function attachMockAxios(
  conn: BaseAbapConnection,
  seen: Seen[],
  answer: (cfg: any) => Promise<any> = async () => ({
    status: 200,
    data: '<service/>',
    headers: {
      'x-csrf-token': 'TOKEN',
      'set-cookie': ['SAP_SESSIONID_E19_100=abc%3d; path=/'],
    },
  }),
): void {
  const instance = async (cfg: any) => {
    seen.push({
      url: cfg.url,
      method: cfg.method,
      headers: cfg.headers ?? {},
    });
    return answer(cfg);
  };
  // clearSessionState() detaches interceptors before dropping the instance, so
  // the double has to carry them — the earlier doubles never reached teardown.
  (instance as any).interceptors = {
    request: { clear: jest.fn() },
    response: { clear: jest.fn() },
  };
  (conn as any).axiosInstance = instance;
}

describe('a connection the server gave no session says so', () => {
  it('warns when the server issued no SAP_SESSIONID', async () => {
    const logger = makeLogger();
    const conn = new BaseAbapConnection(baseConfig, logger);
    // What an on-prem server answers when it will not open a session: the CSRF
    // cookie, and nothing to hold a lock against.
    attachMockAxios(conn, [], async () => ({
      status: 200,
      data: '<service/>',
      headers: {
        'x-csrf-token': 'TOKEN',
        'set-cookie': ['sap-XSRF_E19_100=xyz; path=/'],
      },
    }));

    await conn.connect();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no SAP_SESSIONID'),
    );
    expect(conn.getSessionIdentity()).toBeNull();
  });

  it('stays quiet when a session was established', async () => {
    const logger = makeLogger();
    const conn = new BaseAbapConnection(baseConfig, logger);
    attachMockAxios(conn, []);

    await conn.connect();

    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('no SAP_SESSIONID'),
    );
    expect(conn.getSessionIdentity()).not.toBeNull();
  });
});

describe('disconnect ends the server session', () => {
  it('calls the logoff endpoint with the session cookies', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    const seen: Seen[] = [];
    attachMockAxios(conn, seen);

    await conn.connect();
    await conn.disconnect();

    const logoff = seen.find((r) =>
      r.url.includes('/sap/public/bc/icf/logoff'),
    );
    expect(logoff).toBeDefined();
    expect(logoff?.headers.Cookie).toContain('SAP_SESSIONID_E19_100');
  });

  it('disconnects anyway when the logoff fails', async () => {
    // A session we could not close is strictly better than a teardown that
    // hangs or throws — disconnect() must always settle.
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    const seen: Seen[] = [];
    attachMockAxios(conn, seen, async (cfg) => {
      if (String(cfg.url).includes('logoff')) {
        throw new Error('network is down');
      }
      return {
        status: 200,
        data: '<service/>',
        headers: {
          'x-csrf-token': 'TOKEN',
          'set-cookie': ['SAP_SESSIONID_E19_100=abc%3d; path=/'],
        },
      };
    });

    await conn.connect();
    await expect(conn.disconnect()).resolves.toBeUndefined();
    expect(conn.isConnected()).toBe(false);
    expect(conn.getSessionIdentity()).toBeNull();
  });

  it('sends nothing when there is no session to end', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    const seen: Seen[] = [];
    attachMockAxios(conn, seen);

    await conn.disconnect();

    expect(seen).toHaveLength(0);
  });
});
