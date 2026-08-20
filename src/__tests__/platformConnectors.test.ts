/**
 * The CONSUMER decides the session mechanism, by taking a connector.
 *
 * Nothing here infers it — not from the credential, not from the host, not from
 * what the server answers.
 *
 * Before the split, the class you took stated your credential and the mechanism
 * rode along with it, so two ordinary setups came out wrong: a communication
 * user against ABAP Cloud got the on-prem mechanism, and a bearer token against
 * an on-prem system got the cloud one. Both rows below are those cases.
 */

import { BasicAuthProvider, TokenAuthProvider } from '../auth/providers.js';
import type { SapConfig } from '../config/sapConfig.js';
import { AdtCloudConnector } from '../connection/AdtCloudConnector.js';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import { createAbapConnection } from '../connection/connectionFactory.js';
import type { ILogger } from '../logger.js';

const config: SapConfig = {
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

const SESSION_DOC =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<http:session xmlns:http="http://www.sap.com/adt/http" xmlns:atom="http://www.w3.org/2005/Atom">' +
  '<atom:link href="/sap/bc/adt/core/http/sessions/S-1" rel="http://www.sap.com/adt/categories/core/http/sessions/securitysession"/>' +
  '<atom:link href="/sap/public/bc/icf/logoff" rel="http://www.sap.com/adt/categories/core/http/sessions/logoff"/>' +
  '</http:session>';

type Seen = { url: string; method?: string; headers: Record<string, string> };

/**
 * A server that answers the session resource — which on-prem does too, and
 * which is exactly why nothing here may be decided by asking it.
 */
function serverAnsweringEverything(conn: object, seen: Seen[]): void {
  const instance = async (cfg: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
  }) => {
    seen.push({
      url: String(cfg.url),
      method: cfg.method,
      headers: cfg.headers ?? {},
    });
    if (String(cfg.url).includes('/core/http/sessions?')) {
      return {
        status: 200,
        data: SESSION_DOC,
        headers: { 'set-cookie': ['SAP_SESSIONID_STUB_100=abc%3d; path=/'] },
      };
    }
    return {
      status: 200,
      data: '<service/>',
      headers: {
        'x-csrf-token': 'TOKEN',
        'set-cookie': ['SAP_SESSIONID_STUB_100=abc%3d; path=/'],
      },
    };
  };
  (instance as unknown as { interceptors: unknown }).interceptors = {
    request: { clear: jest.fn() },
    response: { clear: jest.fn() },
  };
  Object.defineProperty(conn, 'axiosInstance', {
    get: () => instance,
    set: () => undefined,
    configurable: true,
  });
}

describe('the consumer decides the session mechanism, by which connector it takes', () => {
  it('on-prem with a bearer token still uses the platform logoff', async () => {
    const seen: Seen[] = [];
    const conn = new AdtOnPremConnector(
      config,
      new TokenAuthProvider('a-token'),
      makeLogger(),
    );
    serverAnsweringEverything(conn, seen);

    await conn.connect();
    await conn.disconnect({ deadlineMs: 500 });

    // Never touched, even though this stub answers it — which is the whole
    // point: on-prem answers it too, so a probe would have chosen wrongly.
    expect(seen.some((r) => r.url.includes('/core/http/sessions'))).toBe(false);
    expect(seen.some((r) => r.url.includes('/sap/public/bc/icf/logoff'))).toBe(
      true,
    );
  });

  it('cloud with a username and password still uses the ADT session', async () => {
    const seen: Seen[] = [];
    const conn = new AdtCloudConnector(
      config,
      new BasicAuthProvider('u', 'p'),
      makeLogger(),
    );
    serverAnsweringEverything(conn, seen);

    await conn.connect();
    await conn.disconnect({ deadlineMs: 500 });

    const opened = seen.find((r) => r.url.includes('/core/http/sessions?'));
    expect(opened?.headers['x-sap-security-session']).toBe('create');
    expect(opened?.headers['sap-adt-purpose']).toBe('preflight_logon');
    // Given back the cloud way, and never through the platform logoff.
    expect(
      seen.some(
        (r) =>
          r.method === 'DELETE' && r.url.includes('/core/http/sessions/S-1'),
      ),
    ).toBe(true);
    expect(seen.some((r) => r.url.includes('/sap/public/bc/icf/logoff'))).toBe(
      false,
    );
  });
});

describe('the credential is what it authenticates with, and nothing more', () => {
  it('a basic credential builds the header the old class built', async () => {
    const seen: Seen[] = [];
    const conn = new AdtOnPremConnector(
      config,
      new BasicAuthProvider('u', 'p'),
      makeLogger(),
    );
    serverAnsweringEverything(conn, seen);

    await conn.connect();

    const expected = `Basic ${Buffer.from('u:p').toString('base64')}`;
    expect(seen[0].headers.Authorization).toBe(expected);
  });

  it('a token credential asks its refresher once per establishment', async () => {
    const getToken = jest.fn(async () => 'FRESH');
    const seen: Seen[] = [];
    const conn = new AdtOnPremConnector(
      config,
      new TokenAuthProvider('stale', {
        getToken,
        refreshToken: jest.fn(async () => 'FRESH'),
      } as never),
      makeLogger(),
    );
    serverAnsweringEverything(conn, seen);

    await conn.connect();
    await conn.makeAdtRequest({
      url: '/sap/bc/adt/discovery',
      method: 'GET',
      timeout: 5000,
    });

    // Once, not per request: a refresher may go to the network, and a
    // connection that asked every time would spend longer authenticating than
    // working.
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)?.headers.Authorization).toBe('Bearer FRESH');
  });
});

/**
 * The factory does what the caller says.
 *
 * `authType` still says HOW to authenticate — it always meant that. What it no
 * longer does is decide which system this is.
 */
describe('createAbapConnection does what the caller states', () => {
  it('gives the cloud connector for a basic credential when asked for cloud', () => {
    const conn = createAbapConnection(
      config,
      makeLogger(),
      undefined,
      undefined,
      {
        system: 'cloud',
      },
    );

    expect(conn).toBeInstanceOf(AdtCloudConnector);
  });

  it('gives the on-prem connector for a token when asked for on-prem', () => {
    const conn = createAbapConnection(
      { ...config, authType: 'jwt', jwtToken: 'a.b.c' } as SapConfig,
      makeLogger(),
      undefined,
      undefined,
      { system: 'onprem' },
    );

    expect(conn).toBeInstanceOf(AdtOnPremConnector);
  });

  it('warns when nothing was stated, and falls back to the old choice', () => {
    const logger = makeLogger();

    const conn = createAbapConnection(config, logger);

    // Still works — existing callers are not broken — but it is said out loud.
    expect(conn).not.toBeInstanceOf(AdtCloudConnector);
    expect(conn).not.toBeInstanceOf(AdtOnPremConnector);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('options.system'),
    );
  });
});
