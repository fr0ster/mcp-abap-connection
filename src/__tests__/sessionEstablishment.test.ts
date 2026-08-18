/**
 * connect() must OPEN a session, not merely collect a CSRF token.
 *
 * Asked statelessly, an on-prem server answers the establishing fetch with
 * `sap-XSRF_*` and no `SAP_SESSIONID`. A later switch to stateful then yields a
 * `sap-contextid` marked ANON which survives exactly one request — and that one
 * request is the LOCK, which returns 200 with a handle the following write
 * cannot use (`400 Session not found`). Asked statefully, the same server issues
 * `SAP_SESSIONID` and the session holds.
 */
import type { SapConfig } from '../config/sapConfig.js';
import { BaseAbapConnection } from '../connection/BaseAbapConnection.js';
import type { ILogger } from '../logger.js';
import { markConnectedForTest } from './helpers/session.js';

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

function attachMockAxios(
  conn: BaseAbapConnection,
  fn: (cfg: any) => Promise<any>,
): void {
  (conn as any).axiosInstance = fn;
}

/** Records every request, answering each one as a token fetch would be. */
function recordAll(
  conn: BaseAbapConnection,
  setCookie?: string[],
): Array<{ url: string; headers: Record<string, string> }> {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  attachMockAxios(conn, async (cfg) => {
    seen.push({ url: cfg.url, headers: cfg.headers ?? {} });
    return {
      status: 200,
      data: '<service/>',
      headers: {
        'x-csrf-token': 'TOKEN',
        ...(setCookie ? { 'set-cookie': setCookie } : {}),
      },
    };
  });
  return seen;
}

const SESSION_COOKIE = [
  'SAP_SESSIONID_E19_100=abc%3d; path=/',
  'sap-usercontext=sap-client=100; path=/',
];

describe('the establishing fetch opens a session', () => {
  it('asks for a stateful session on connect', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    const seen = recordAll(conn, SESSION_COOKIE);

    await conn.connect();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].headers['x-sap-adt-sessiontype']).toBe('stateful');
  });

  it('does not ask when skipSessionType forbids the header', async () => {
    // BASIS 7.40 stores locks in session memory when the stateful header is
    // sent, which is the defect skipSessionType exists to avoid. That contract
    // wins over this one.
    const conn = new BaseAbapConnection(baseConfig, makeLogger(), undefined, {
      skipSessionType: true,
    });
    const seen = recordAll(conn, SESSION_COOKIE);

    await conn.connect();

    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) {
      expect(request.headers['x-sap-adt-sessiontype']).toBeUndefined();
    }
  });

  it('leaves a later token refresh stateless', async () => {
    // Only the establishing fetch opens a session. A refresh mid-conversation
    // must not change the session type under the caller — makeAdtRequest owns
    // that, from the mode the caller set.
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    markConnectedForTest(conn);
    const seen = recordAll(conn, SESSION_COOKIE);

    await conn.makeAdtRequest({
      url: '/sap/bc/adt/ddic/domains/zx?_action=LOCK&accessMode=MODIFY',
      method: 'POST',
      timeout: 5000,
      data: null,
    });

    const fetches = seen.filter((r) => r.headers['x-csrf-token'] === 'fetch');
    expect(fetches.length).toBeGreaterThan(0);
    for (const fetch of fetches) {
      expect(fetch.headers['x-sap-adt-sessiontype']).toBeUndefined();
    }
  });
});

describe('a connection with no session says so', () => {
  it('warns when the server issued no SAP_SESSIONID', async () => {
    const logger = makeLogger();
    const conn = new BaseAbapConnection(baseConfig, logger);
    // Only the XSRF cookie: the shape that leaves the fingerprint empty, which
    // can never be classified `replaced` and so disables every guard built on
    // session identity.
    recordAll(conn, ['sap-XSRF_E19_100=xyz; path=/']);

    await conn.connect();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no SAP_SESSIONID'),
    );
  });

  it('stays quiet when a session was established', async () => {
    const logger = makeLogger();
    const conn = new BaseAbapConnection(baseConfig, logger);
    recordAll(conn, SESSION_COOKIE);

    await conn.connect();

    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('no SAP_SESSIONID'),
    );
  });
});
