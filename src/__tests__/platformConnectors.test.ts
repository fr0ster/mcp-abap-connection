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

import {
  BasicAuthProvider,
  SamlAuthProvider,
  TokenAuthProvider,
} from '../auth/providers.js';
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

  /**
   * The provider renews; we must not hold what it returned.
   *
   * `BaseTokenProvider` checks expiry and refreshes before handing a token
   * back, so a cache on this side serves the stale one and hides exactly the
   * renewal the provider exists to do. The first version of this class cached
   * at establishment, and this test is what that cost.
   */
  it('asks the provider per request, so a renewed token is used without reconnecting', async () => {
    // A switch rather than a queue: how many times the header is asked for is
    // an implementation detail, and a test that depends on the count would
    // break for reasons that are not about renewal.
    let renewed = false;
    const getToken = jest.fn(async () => (renewed ? 'RENEWED' : 'FIRST'));
    const seen: Seen[] = [];
    const conn = new AdtOnPremConnector(
      config,
      new TokenAuthProvider({ getToken, refreshToken: getToken } as never),
      makeLogger(),
    );
    serverAnsweringEverything(conn, seen);

    await conn.connect();
    const before = seen.at(-1)?.headers.Authorization;

    // The provider renews on its own, exactly as BaseTokenProvider does when a
    // token expires. Nothing tells the connection about it.
    renewed = true;

    await conn.makeAdtRequest({
      url: '/sap/bc/adt/discovery',
      method: 'GET',
      timeout: 5000,
    });

    expect(before).toBe('Bearer FIRST');
    // No reconnect, no new session — the provider simply answered differently,
    // and the next request carried it.
    expect(seen.at(-1)?.headers.Authorization).toBe('Bearer RENEWED');
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

  it('builds a token connector for jwt, using the refresher it was given', async () => {
    const refresher = {
      getToken: jest.fn(async () => 'FROM-REFRESHER'),
      refreshToken: jest.fn(async () => 'FROM-REFRESHER'),
    };
    const seen: Seen[] = [];
    const conn = createAbapConnection(
      { ...config, authType: 'jwt', jwtToken: 'ignored' } as SapConfig,
      makeLogger(),
      undefined,
      refresher as never,
      { system: 'cloud' },
    );
    serverAnsweringEverything(conn, seen);

    await conn.connect();

    // The refresher, not the static token beside it: a caller that supplies one
    // supplied it to be used.
    expect(seen[0].headers.Authorization).toBe('Bearer FROM-REFRESHER');
    expect(conn).toBeInstanceOf(AdtCloudConnector);
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

/**
 * A credential that is cookies rather than a header.
 *
 * The first version of the split held them on the provider and never asked for
 * them: `SamlAuthProvider` had a `cookies()` method that nothing called, so the
 * connector sent an empty Authorization, presented no session, and the class it
 * was recommended over authenticated with nothing at all.
 */
describe('cookie credentials reach the wire', () => {
  it.each([
    [
      'on-prem',
      (p: SamlAuthProvider) => new AdtOnPremConnector(config, p, makeLogger()),
    ],
    [
      'cloud',
      (p: SamlAuthProvider) => new AdtCloudConnector(config, p, makeLogger()),
    ],
  ])('%s sends the SAML cookies on every request', async (_name, build) => {
    const seen: Seen[] = [];
    const conn = build(
      new SamlAuthProvider('MYSAPSSO2=ticket; sap-usercontext=x'),
    );
    serverAnsweringEverything(conn, seen);

    await conn.connect();
    await conn.makeAdtRequest({
      url: '/sap/bc/adt/discovery',
      method: 'GET',
      timeout: 5000,
    });

    // Every one of them: the preflight and the establishing call included. A
    // session not presented to those is a session the server never sees us in.
    expect(seen.length).toBeGreaterThan(1);
    for (const request of seen) {
      expect(request.headers.Cookie ?? '').toContain('MYSAPSSO2=ticket');
    }
  });
});

/**
 * A 401 has two causes, and asking the provider again tells them apart.
 *
 * No renewal strategy is injected anywhere: the provider owns "get me a valid
 * credential" and already renews on its own, so what is left is "the credential
 * changed, so the session built on the old one is dead" — which only whoever
 * owns the session can do.
 */
/** Accepts one header value on `/work`; everything else establishes fine. */
function serverRejectingUntilShared(
  conn: object,
  seen: Seen[],
  accepted: string,
  onReject: () => void = () => undefined,
): void {
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
    const ok = {
      status: 200,
      data: '<service/>',
      headers: {
        'x-csrf-token': 'TOKEN',
        'set-cookie': ['SAP_SESSIONID_STUB_100=abc%3d; path=/'],
      },
    };
    if (!String(cfg.url).includes('/work')) return ok;
    if (cfg.headers?.Authorization === accepted) return ok;
    onReject();
    const error = new Error('unauthorized') as Error & { response?: unknown };
    error.response = { status: 401, headers: {}, data: '' };
    throw error;
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

describe('a rejected credential is retried only when it actually changed', () => {
  /** Accepts one header value on `/work`; everything else establishes fine. */
  function serverRejectingUntil(
    conn: object,
    seen: Seen[],
    accepted: string,
    onReject: () => void = () => undefined,
  ): void {
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
      const ok = {
        status: 200,
        data: '<service/>',
        headers: {
          'x-csrf-token': 'TOKEN',
          'set-cookie': ['SAP_SESSIONID_STUB_100=abc%3d; path=/'],
        },
      };
      if (!String(cfg.url).includes('/work')) return ok;
      if (cfg.headers?.Authorization === accepted) return ok;
      onReject();
      const error = new Error('unauthorized') as Error & { response?: unknown };
      error.response = { status: 401, headers: {}, data: '' };
      throw error;
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

  it('renews and retries once when the provider answers differently', async () => {
    // The provider renews once the token it gave has been refused — which is
    // when BaseTokenProvider would notice the expiry, not before.
    let refused = false;
    const seen: Seen[] = [];
    const conn = new AdtOnPremConnector(
      config,
      new TokenAuthProvider(async () => (refused ? 'GOOD' : 'STALE')),
      makeLogger(),
    );
    serverRejectingUntil(conn, seen, 'Bearer GOOD', () => {
      refused = true;
    });

    await conn.connect();
    const response = await conn.makeAdtRequest({
      url: '/work',
      method: 'GET',
      timeout: 5000,
    });

    expect(response.status).toBe(200);
    const work = seen.filter((r) => r.url.includes('/work'));
    // Exactly two: the refused one and the retry. Not three.
    expect(work).toHaveLength(2);
    expect(work[0].headers.Authorization).toBe('Bearer STALE');
    expect(work[1].headers.Authorization).toBe('Bearer GOOD');
  });

  it('does not retry when the credential is unchanged', async () => {
    const seen: Seen[] = [];
    const conn = new AdtOnPremConnector(
      config,
      new BasicAuthProvider('u', 'wrong'),
      makeLogger(),
    );
    // Nothing this credential can say is accepted — a real refusal rather than
    // an expiry, and repeating it would only ask a second time.
    serverRejectingUntil(conn, seen, 'Bearer NEVER');

    await conn.connect();

    await expect(
      conn.makeAdtRequest({ url: '/work', method: 'GET', timeout: 5000 }),
    ).rejects.toMatchObject({ response: { status: 401 } });

    expect(seen.filter((r) => r.url.includes('/work'))).toHaveLength(1);
  });

  /**
   * One retry, not a loop.
   *
   * A provider that answers differently every time — a broken refresher, a
   * server rejecting whatever it is given — would keep looking like "the
   * credential changed" forever. The retry goes to `super`, so it cannot ask
   * again; the same call reaching for `this` would spin until the process died.
   */
  it('retries exactly once even when the retry is refused too', async () => {
    let n = 0;
    const seen: Seen[] = [];
    const conn = new AdtOnPremConnector(
      config,
      new TokenAuthProvider(async () => {
        n += 1;
        return `T${n}`;
      }),
      makeLogger(),
    );
    // Nothing is ever accepted, and the credential is different every time.
    serverRejectingUntil(conn, seen, 'Bearer NEVER');

    await conn.connect();

    await expect(
      conn.makeAdtRequest({ url: '/work', method: 'GET', timeout: 5000 }),
    ).rejects.toMatchObject({ response: { status: 401 } });

    expect(seen.filter((r) => r.url.includes('/work'))).toHaveLength(2);
  });

  it('rebuilds once for concurrent requests, not once each', async () => {
    let refused = false;
    const seen: Seen[] = [];
    const conn = new AdtOnPremConnector(
      config,
      new TokenAuthProvider(async () => (refused ? 'GOOD' : 'STALE')),
      makeLogger(),
    );
    serverRejectingUntil(conn, seen, 'Bearer GOOD', () => {
      refused = true;
    });

    await conn.connect();
    const before = seen.filter((r) => r.url.includes('/discovery')).length;

    await Promise.all([
      conn.makeAdtRequest({ url: '/work', method: 'GET', timeout: 5000 }),
      conn.makeAdtRequest({ url: '/work', method: 'GET', timeout: 5000 }),
      conn.makeAdtRequest({ url: '/work', method: 'GET', timeout: 5000 }),
    ]);

    // Three requests met the same refusal; the session was rebuilt once, so
    // exactly one further establishing call went out.
    const after = seen.filter((r) => r.url.includes('/discovery')).length;
    expect(after - before).toBe(1);
  });
});

/**
 * How the provider is used, which is the part that is ours to get right.
 *
 * The provider itself is a tested package; what this pins is the contract
 * between us and it — which method, when, and how often. `ITokenRefresher`
 * spells the important one out: `getToken()` "may return cached token if still
 * valid", and `refreshToken()` is the one to call "when getToken() returned a
 * token that was rejected by server (401/403)". Asking the first again after a
 * refusal gets the same dead token back, and the renewal never happens.
 */
describe('the token provider is used the way its contract says', () => {
  function refresherSpy(tokens: string[]) {
    let i = 0;
    return {
      getToken: jest.fn(async () => tokens[i] ?? tokens[tokens.length - 1]),
      // A real one mints a new token here and caches it, so the next getToken
      // returns the new one. Modelled exactly that way.
      refreshToken: jest.fn(async () => {
        i = Math.min(i + 1, tokens.length - 1);
        return tokens[i];
      }),
    };
  }

  it('forces a refresh after a refusal instead of asking again', async () => {
    const refresher = refresherSpy(['STALE', 'GOOD']);
    const seen: Seen[] = [];
    const conn = new AdtOnPremConnector(
      config,
      new TokenAuthProvider(refresher as never),
      makeLogger(),
    );
    serverRejectingUntilShared(conn, seen, 'Bearer GOOD');

    await conn.connect();
    const response = await conn.makeAdtRequest({
      url: '/work',
      method: 'GET',
      timeout: 5000,
    });

    expect(response.status).toBe(200);
    // Without this call the provider keeps handing back the token it still
    // believes in, the header never changes, and the request fails for good.
    expect(refresher.refreshToken).toHaveBeenCalledTimes(1);
  });

  it('does not force a refresh when nothing was refused', async () => {
    const refresher = refresherSpy(['GOOD']);
    const seen: Seen[] = [];
    const conn = new AdtOnPremConnector(
      config,
      new TokenAuthProvider(refresher as never),
      makeLogger(),
    );
    serverRejectingUntilShared(conn, seen, 'Bearer GOOD');

    await conn.connect();
    await conn.makeAdtRequest({ url: '/work', method: 'GET', timeout: 5000 });

    // A forced refresh can be expensive — with authorization_code it may reach
    // for a refresh token, or fall back to an interactive login — so it is
    // asked for only when the server has actually refused something.
    expect(refresher.refreshToken).not.toHaveBeenCalled();
    expect(refresher.getToken).toHaveBeenCalled();
  });
});

/**
 * A refusal that arrives after somebody else has already fixed things.
 *
 * Two requests go out on one session with one token. The first is refused,
 * renews, rebuilds, and carries on. The second's refusal — answered by the
 * server before any of that, and delivered afterwards — says nothing about the
 * credential in use now: it was answered by a session that no longer exists.
 * Acting on it forces a second refresh and tears down a healthy session.
 */
describe('a late refusal does not undo a session somebody else rebuilt', () => {
  it('retries on the new session instead of renewing again', async () => {
    let refused = false;
    let release: (() => void) | undefined;
    const seen: Seen[] = [];
    const refresher = {
      getToken: jest.fn(async () => (refused ? 'GOOD' : 'STALE')),
      refreshToken: jest.fn(async () => {
        refused = true;
        return 'GOOD';
      }),
    };
    const conn = new AdtOnPremConnector(
      config,
      new TokenAuthProvider(refresher as never),
      makeLogger(),
    );

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
      const ok = {
        status: 200,
        data: '<service/>',
        headers: {
          'x-csrf-token': 'TOKEN',
          'set-cookie': ['SAP_SESSIONID_STUB_100=abc%3d; path=/'],
        },
      };
      if (!String(cfg.url).includes('/work')) return ok;
      if (cfg.headers?.Authorization === 'Bearer GOOD') return ok;
      // The slow one: refused by the old session, delivered long after the
      // fast one has finished renewing and rebuilding.
      if (String(cfg.url).includes('/slow')) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      const error = new Error('unauthorized') as Error & { response?: unknown };
      error.response = { status: 401, headers: {}, data: '' };
      throw error;
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

    await conn.connect();

    const slow = conn.makeAdtRequest({
      url: '/work/slow',
      method: 'GET',
      timeout: 5000,
    });
    await new Promise((r) => setTimeout(r, 10));
    await conn.makeAdtRequest({ url: '/work', method: 'GET', timeout: 5000 });
    release?.();
    await slow;

    // One refusal, one refresh. The late one found the session already replaced
    // and simply went again.
    expect(refresher.refreshToken).toHaveBeenCalledTimes(1);
  });
});

/**
 * One physical request, one credential read.
 *
 * The contract lets a provider answer differently each time — that is the whole
 * point of asking per request — so a request assembled from two reads can carry
 * an Authorization from one credential and a Cookie from another. For a token
 * provider it also doubles the work behind every call.
 */
describe('a request is built from one reading of the credential', () => {
  it.each([
    [
      'on-prem',
      (p: TokenAuthProvider) => new AdtOnPremConnector(config, p, makeLogger()),
    ],
    [
      'cloud',
      (p: TokenAuthProvider) => new AdtCloudConnector(config, p, makeLogger()),
    ],
  ])('%s asks once per request it sends', async (_name, build) => {
    const seen: Seen[] = [];
    let reads = 0;
    const conn = build(
      new TokenAuthProvider(async () => {
        reads += 1;
        return 'T';
      }),
    );
    serverAnsweringEverything(conn, seen);

    await conn.connect();
    await conn.disconnect({ deadlineMs: 500 });

    // Never more than one read per request that actually went out. More means
    // some request was assembled from two different answers.
    expect(reads).toBeLessThanOrEqual(seen.length);
  });
});
