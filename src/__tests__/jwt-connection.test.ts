/**
 * Unit tests for JWT connection
 *
 * Verifies basic JWT connection functionality.
 * Token refresh functionality is handled by auth-broker package.
 */

import { AsyncResource } from 'node:async_hooks';
import {
  ADT_SESSION_ERROR,
  type ITokenRefresher,
} from '@mcp-abap-adt/interfaces';
import { AxiosError } from 'axios';
import type { SapConfig } from '../config/sapConfig.js';
import { CSRF_CONFIG } from '../connection/csrfConfig.js';
import { JwtAbapConnection } from '../connection/JwtAbapConnection.js';
import type { ILogger } from '../logger.js';
import { markConnectedForTest } from './helpers/session.js';

// Mock logger
const mockLogger: ILogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

describe('JwtAbapConnection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Config validation', () => {
    it('should accept valid JWT config', () => {
      const config: SapConfig = {
        url: 'https://test.sap.com',
        authType: 'jwt',
        jwtToken: 'test-jwt-token',
      };
      expect(() => new JwtAbapConnection(config, mockLogger)).not.toThrow();
    });

    it('should throw error when authType is not jwt', () => {
      const config: SapConfig = {
        url: 'https://test.sap.com',
        authType: 'basic' as any,
        jwtToken: 'test-jwt-token',
      };
      expect(() => new JwtAbapConnection(config, mockLogger)).toThrow(
        'JWT connection expects authType "jwt"',
      );
    });

    it('should throw error when jwtToken is missing', () => {
      const config: SapConfig = {
        url: 'https://test.sap.com',
        authType: 'jwt',
        // jwtToken is missing
      } as any;
      expect(() => new JwtAbapConnection(config, mockLogger)).toThrow(
        'JWT authentication requires SAP_JWT_TOKEN',
      );
    });
  });

  describe('Token refresher injection', () => {
    it('should accept optional tokenRefresher parameter', () => {
      const config: SapConfig = {
        url: 'https://test.sap.com',
        authType: 'jwt',
        jwtToken: 'test-jwt-token',
      };

      const mockTokenRefresher: ITokenRefresher = {
        getToken: jest.fn().mockResolvedValue('new-token'),
        refreshToken: jest.fn().mockResolvedValue('refreshed-token'),
      };

      expect(
        () =>
          new JwtAbapConnection(
            config,
            mockLogger,
            undefined,
            mockTokenRefresher,
          ),
      ).not.toThrow();
    });

    it('should work without tokenRefresher (legacy behavior)', () => {
      const config: SapConfig = {
        url: 'https://test.sap.com',
        authType: 'jwt',
        jwtToken: 'test-jwt-token',
      };

      // No tokenRefresher provided - should still work
      const connection = new JwtAbapConnection(config, mockLogger);
      expect(connection).toBeDefined();
    });

    it('should use initial token from config', async () => {
      const config: SapConfig = {
        url: 'https://test.sap.com',
        authType: 'jwt',
        jwtToken: 'initial-jwt-token',
      };

      const connection = new JwtAbapConnection(config, mockLogger);

      // Access protected method via casting for testing
      const authHeader = (connection as any).buildAuthorizationHeader();
      expect(authHeader).toBe('Bearer initial-jwt-token');
    });
  });
});

/**
 * The override used to declare three parameters where the base declares four,
 * and to call `super` with three — so `generation`, which fences the response
 * effects, was dropped.
 *
 * This is driven through the protected method directly rather than through a
 * request, and that is deliberate. Both call sites that pass a generation —
 * `AbstractAbapConnection` at the stale-CSRF retry and at the 401-on-GET cookie
 * fetch — are gated on `authType === 'basic'`, so no JWT request reaches one
 * today. The defect is latent rather than live, and a test that waited for a
 * reachable path would never be written. What it pins is the forwarding.
 */
describe('JwtAbapConnection.fetchCsrfToken argument forwarding', () => {
  const config: SapConfig = {
    url: 'https://test.sap.com',
    authType: 'jwt',
    jwtToken: 'test-jwt-token',
  };
  const url = 'https://test.sap.com/sap/bc/adt/discovery';

  /** `super.fetchCsrfToken` resolves against this object at call time. */
  const basePrototype = Object.getPrototypeOf(JwtAbapConnection.prototype);

  it('passes the generation through to the base implementation', async () => {
    const conn = new JwtAbapConnection(config, mockLogger);
    const spy = jest
      .spyOn(basePrototype as any, 'fetchCsrfToken')
      .mockResolvedValue('csrf-token');

    await (conn as any).fetchCsrfToken(url, 5, 2000, 42);

    expect(spy).toHaveBeenCalledWith(url, 5, 2000, 42);
    spy.mockRestore();
  });

  it('takes its defaults from CSRF_CONFIG rather than its own copies', async () => {
    const conn = new JwtAbapConnection(config, mockLogger);
    const spy = jest
      .spyOn(basePrototype as any, 'fetchCsrfToken')
      .mockResolvedValue('csrf-token');

    await (conn as any).fetchCsrfToken(url);

    expect(spy).toHaveBeenCalledWith(
      url,
      CSRF_CONFIG.RETRY_COUNT,
      CSRF_CONFIG.RETRY_DELAY,
      undefined,
    );
    spy.mockRestore();
  });
});

/**
 * Issue #30: a 403 authorization refusal was reported as
 * "JWT token has expired. Please re-authenticate.", with the original
 * AxiosError — status, body, everything — thrown away. A caller was sent to
 * re-authenticate for an S_DEVELOP gap, which no credential can fix.
 *
 * Captured from a cloud trial: creating a classic program answers 403 with
 * `ExceptionResourceNoAuthorization`, which none of the three substring guards
 * matched, so it fell through to the refresh and then to the synthesised error.
 */
describe('JwtAbapConnection error classification', () => {
  const config: SapConfig = {
    url: 'https://sap.example.com',
    authType: 'jwt',
    jwtToken: 'jwt-abc',
    client: '100',
  };

  const FORBIDDEN =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">' +
    '<type id="ExceptionResourceNoAuthorization"/>' +
    '<message lang="EN">You are not authorized to make changes (authorization object S_DEVELOP)</message>' +
    '</exc:exception>';

  function axiosError(status: number, data: unknown): AxiosError {
    return new AxiosError(
      `Request failed with status ${status}`,
      String(status),
      {} as never,
      null,
      {
        status,
        statusText: '',
        data,
        headers: {},
        config: {} as never,
      } as never,
    );
  }

  /** A connection staged as connected, whose transport always rejects. */
  function connectionRejecting(
    error: AxiosError,
    refresher?: ITokenRefresher,
  ): JwtAbapConnection {
    const conn = new JwtAbapConnection(
      config,
      mockLogger,
      undefined,
      refresher,
    );
    markConnectedForTest(conn);
    // A cached CSRF token and cookies, so the POST goes straight out. Without
    // them the mutation first fetches a token, and that fetch retries with
    // delays — the test then times out somewhere that is not its subject.
    (conn as any).csrfToken = 'cached-token';
    (conn as any).cookies = 'SAP_SESSIONID_STUB_100=S1';
    // Discovery answers; only the ADT request fails. A transport that rejected
    // everything would make the recovery establishment retry with delays too,
    // and the test would time out in the session layer rather than say
    // anything about classification.
    (conn as any).axiosInstance = jest.fn(async (cfg: { url?: string }) => {
      if ((cfg.url ?? '').includes('/discovery')) {
        return {
          status: 200,
          statusText: 'OK',
          data: '<service/>',
          headers: {
            'x-csrf-token': 'FRESH-TOKEN',
            'set-cookie': ['SAP_SESSIONID_STUB_100=S2; Path=/'],
          },
          config: cfg,
        };
      }
      throw error;
    });
    return conn;
  }

  const request = {
    url: '/sap/bc/adt/programs/programs',
    method: 'POST' as const,
    timeout: 30000,
    data: '<x/>',
  };

  it('a 403 propagates with its status and the server body', async () => {
    const conn = connectionRejecting(axiosError(403, FORBIDDEN));

    await expect(conn.makeAdtRequest(request)).rejects.toMatchObject({
      response: { status: 403 },
    });
    await expect(conn.makeAdtRequest(request)).rejects.toMatchObject({
      response: { data: expect.stringContaining('S_DEVELOP') },
    });
  });

  it('a 403 does not call the refresher', async () => {
    // Without this, a future change could send 403 back into the refresh path
    // and the test above would still pass: a refreshed-then-failed 403 also
    // ends up rethrown.
    const refreshToken = jest.fn(async () => 'FRESH');
    const conn = connectionRejecting(axiosError(403, FORBIDDEN), {
      getToken: async () => 'FRESH',
      refreshToken,
    });

    await expect(conn.makeAdtRequest(request)).rejects.toBeDefined();

    expect(refreshToken).not.toHaveBeenCalled();
  });

  it('a 401 with no refresher rethrows the original 401', async () => {
    const conn = connectionRejecting(axiosError(401, '<html>login</html>'));

    await expect(conn.makeAdtRequest(request)).rejects.toMatchObject({
      response: { status: 401 },
    });
  });

  it('a 401 does call the refresher', async () => {
    const refreshToken = jest.fn(async () => 'FRESH');
    const conn = connectionRejecting(axiosError(401, '<html>login</html>'), {
      getToken: async () => 'FRESH',
      refreshToken,
    });

    await expect(conn.makeAdtRequest(request)).rejects.toBeDefined();

    expect(refreshToken).toHaveBeenCalledTimes(1);
  });
});

/**
 * `fetchCsrfToken` classifies for itself, and it was very nearly missed.
 *
 * The first pass at issue #30 converted `makeAdtRequest` and left this handler
 * accepting 403 with the substring list intact — and every test written for it
 * went through `makeAdtRequest` with a cached CSRF token, so none of them came
 * near this code. The gap was found by reading the file, which is not a method
 * that scales. These tests are the method that does.
 */
describe('JwtAbapConnection.fetchCsrfToken classification', () => {
  const config: SapConfig = {
    url: 'https://sap.example.com',
    authType: 'jwt',
    jwtToken: 'jwt-abc',
    client: '100',
  };
  const url = 'https://sap.example.com/sap/bc/adt/discovery';

  const basePrototype = Object.getPrototypeOf(JwtAbapConnection.prototype);

  function refuse(status: number, data: string) {
    return jest.spyOn(basePrototype as any, 'fetchCsrfToken').mockRejectedValue(
      new AxiosError(
        `Request failed with status ${status}`,
        String(status),
        {} as never,
        null,
        {
          status,
          statusText: '',
          data,
          headers: {},
          config: {} as never,
        } as never,
      ),
    );
  }

  afterEach(() => jest.restoreAllMocks());

  it('does not refresh on a 403, and rethrows it', async () => {
    const refreshToken = jest.fn(async () => 'FRESH');
    const conn = new JwtAbapConnection(config, mockLogger, undefined, {
      getToken: async () => 'FRESH',
      refreshToken,
    });
    refuse(403, 'ExceptionResourceNoAuthorization');

    await expect((conn as any).fetchCsrfToken(url)).rejects.toMatchObject({
      response: { status: 403 },
    });
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it('refreshes once on a 401 and retries', async () => {
    const refreshToken = jest.fn(async () => 'FRESH');
    const conn = new JwtAbapConnection(config, mockLogger, undefined, {
      getToken: async () => 'FRESH',
      refreshToken,
    });
    const spy = refuse(401, '<html>login</html>');

    await expect((conn as any).fetchCsrfToken(url)).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(refreshToken).toHaveBeenCalledTimes(1);
    // The retry happened: the base was asked twice, and gave up after that.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  /**
   * Test 9, first form. Two concurrent operations both fail their nested CSRF
   * fetch; the token primitive has to collapse them into one network refresh.
   * `renewalInFlight` cannot help at this level — it does not exist until the
   * failure climbs to the outer handler.
   */
  it('two concurrent CSRF fetches share one token refresh', async () => {
    const refreshToken = jest.fn(async () => 'FRESH');
    const conn = new JwtAbapConnection(config, mockLogger, undefined, {
      getToken: async () => 'FRESH',
      refreshToken,
    });

    let calls = 0;
    jest
      .spyOn(basePrototype as any, 'fetchCsrfToken')
      .mockImplementation(async () => {
        calls += 1;
        // The first attempt of each operation is refused; the retry after the
        // shared refresh succeeds.
        if (calls <= 2) {
          throw new AxiosError('unauthorized', '401', {} as never, null, {
            status: 401,
            statusText: '',
            data: '',
            headers: {},
            config: {} as never,
          } as never);
        }
        return 'CSRF-AFTER-REFRESH';
      });

    const [a, b] = await Promise.all([
      (conn as any).fetchCsrfToken(url),
      (conn as any).fetchCsrfToken(url),
    ]);

    expect(a).toBe('CSRF-AFTER-REFRESH');
    expect(b).toBe('CSRF-AFTER-REFRESH');
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });
});

/**
 * The renewal: one per caller-visible operation, session included.
 *
 * These drive `makeAdtRequest`, whose recovery discards the session and
 * re-establishes it. The transport answers discovery so the establishment can
 * succeed; only the ADT request is scripted.
 */
describe('JwtAbapConnection credential renewal', () => {
  const config: SapConfig = {
    url: 'https://sap.example.com',
    authType: 'jwt',
    jwtToken: 'jwt-abc',
    client: '100',
  };
  const request = {
    url: '/sap/bc/adt/ddic/domains/zfoo',
    method: 'POST' as const,
    timeout: 30000,
    data: '<x/>',
  };

  function unauthorized(): AxiosError {
    return new AxiosError('unauthorized', '401', {} as never, null, {
      status: 401,
      statusText: '',
      data: '<html>login</html>',
      headers: {},
      config: {} as never,
    } as never);
  }

  function discoveryOk(cfg: { url?: string }) {
    return {
      status: 200,
      statusText: 'OK',
      data: '<service/>',
      headers: {
        'x-csrf-token': 'FRESH-TOKEN',
        'set-cookie': ['SAP_SESSIONID_STUB_100=S2; Path=/'],
      },
      config: cfg,
    };
  }

  /**
   * A connection staged as connected, with a cached CSRF token so a mutation
   * goes straight out, and a transport whose ADT answers the test scripts.
   */
  function staged(
    refreshToken: jest.Mock,
    adt: (attempt: number, cfg: { url?: string }) => unknown,
  ) {
    const conn = new JwtAbapConnection(config, mockLogger, undefined, {
      getToken: async () => 'FRESH',
      refreshToken: refreshToken as unknown as () => Promise<string>,
    });
    markConnectedForTest(conn);
    (conn as any).csrfToken = 'cached-token';
    (conn as any).cookies = 'SAP_SESSIONID_STUB_100=S1';
    let adtCalls = 0;
    const transport = jest.fn(async (cfg: { url?: string }) => {
      if ((cfg.url ?? '').includes('/discovery')) return discoveryOk(cfg);
      adtCalls += 1;
      return adt(adtCalls, cfg);
    });
    (conn as any).axiosInstance = transport;
    return { conn, transport, adtCalls: () => adtCalls };
  }

  /** Test 5: a persistent 401 renews exactly once, through the real path. */
  it('a persistent 401 renews once and rejects with the original error', async () => {
    const refreshToken = jest.fn(async () => 'FRESH');
    const { conn } = staged(refreshToken, () => {
      throw unauthorized();
    });

    await expect(conn.makeAdtRequest(request)).rejects.toMatchObject({
      response: { status: 401 },
    });

    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  /** Test 6: two concurrent operations share one renewal, and both succeed. */
  it('two concurrent 401s share one renewal and both retry after it', async () => {
    const refreshToken = jest.fn(async () => 'FRESH');
    const { conn } = staged(refreshToken, (attempt, cfg) => {
      // The first attempt of each operation fails; the retries succeed.
      if (attempt <= 2) throw unauthorized();
      return {
        status: 200,
        statusText: 'OK',
        data: 'ok',
        headers: {},
        config: cfg,
      };
    });
    const recover = jest.spyOn(conn as any, 'recoverSession');

    const [a, b] = await Promise.all([
      conn.makeAdtRequest(request),
      conn.makeAdtRequest(request),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  /**
   * Test 8: a nested token-only refresh is not a session recovery.
   *
   * `fetchCsrfToken` bumps `tokenGeneration` without rebuilding anything. If
   * the outer handler read that counter it would conclude a recovery had
   * happened for it and retry a request whose session was never rebuilt.
   */
  it('a token-only refresh does not pass for a session recovery', async () => {
    const refreshToken = jest.fn(async () => 'FRESH');
    let conn!: JwtAbapConnection;
    ({ conn } = staged(refreshToken, (attempt, cfg) => {
      if (attempt === 1) {
        // A nested fetchCsrfToken refreshed the token DURING this operation —
        // after its scope opened, so the operation's baseline is still 0. That
        // is the whole point: bumping the counter before the call would move
        // the baseline with it and the test would prove nothing.
        (conn as any).tokenGeneration = 1;
        throw unauthorized();
      }
      return {
        status: 200,
        statusText: 'OK',
        data: 'ok',
        headers: {},
        config: cfg,
      };
    }));

    const recover = jest.spyOn(conn as any, 'recoverSession');

    const response = await conn.makeAdtRequest(request);

    expect(response.status).toBe(200);
    // The session was rebuilt even though the token was already newer.
    expect(recover).toHaveBeenCalledTimes(1);
    // And no second token was fetched: only the session was missing.
    expect(refreshToken).not.toHaveBeenCalled();
  });

  /**
   * Test 14: a teardown between the last lifecycle check and the retry.
   *
   * reset() alone would not prove this — it shuts admission synchronously, so
   * the retry would be refused with or without the guard. The connection has to
   * be usable again AND carry a moved epoch, which is reset() followed by a
   * successful connect(): markConnected clears teardownPending without touching
   * the epoch.
   */
  it('does not retry after the caller tore the connection down', async () => {
    const refreshToken = jest.fn(async () => 'FRESH');
    const { conn, adtCalls } = staged(refreshToken, (attempt, cfg) => {
      if (attempt === 1) throw unauthorized();
      return {
        status: 200,
        statusText: 'OK',
        data: 'ok',
        headers: {},
        config: cfg,
      };
    });

    const original = (conn as any).ensureRecovered.bind(conn);
    (conn as any).ensureRecovered = async (epoch: number) => {
      const answer = await original(epoch);
      // The renewal is done and renewalInFlight is cleared. Now the caller
      // discards the connection and it is brought back up: admission open,
      // epoch moved.
      conn.reset();
      await conn.connect();
      return answer;
    };

    await expect(conn.makeAdtRequest(request)).rejects.toMatchObject({
      code: ADT_SESSION_ERROR.NOT_CONNECTED,
    });

    // The forbidden retry never reached the transport: one ADT attempt only.
    expect(adtCalls()).toBe(1);
  }, 20000);
});

/**
 * The operation-scope boundaries.
 *
 * These are the tests the AsyncLocalStorage design exists for: which credential
 * state an operation reasons from, and who may read whose baseline. All of them
 * assert a renewal that would otherwise be **skipped** — a stale or borrowed
 * baseline reads as "somebody already did this for me", never as "do it twice".
 */
describe('JwtAbapConnection operation scope', () => {
  const config: SapConfig = {
    url: 'https://sap.example.com',
    authType: 'jwt',
    jwtToken: 'jwt-abc',
    client: '100',
  };
  const request = {
    url: '/sap/bc/adt/ddic/domains/zfoo',
    method: 'POST' as const,
    timeout: 30000,
    data: '<x/>',
  };

  function unauthorized(): AxiosError {
    return new AxiosError('unauthorized', '401', {} as never, null, {
      status: 401,
      statusText: '',
      data: '<html>login</html>',
      headers: {},
      config: {} as never,
    } as never);
  }

  function ok(cfg: { url?: string }) {
    return {
      status: 200,
      statusText: 'OK',
      data: 'ok',
      headers: {},
      config: cfg,
    };
  }

  function discoveryOk(cfg: { url?: string }) {
    return {
      status: 200,
      statusText: 'OK',
      data: '<service/>',
      headers: {
        'x-csrf-token': 'FRESH-TOKEN',
        'set-cookie': ['SAP_SESSIONID_STUB_100=S2; Path=/'],
      },
      config: cfg,
    };
  }

  function staged(
    refreshToken: jest.Mock,
    adt: (attempt: number, cfg: { url?: string }) => unknown,
  ) {
    const conn = new JwtAbapConnection(config, mockLogger, undefined, {
      getToken: async () => 'FRESH',
      refreshToken: refreshToken as unknown as () => Promise<string>,
    });
    markConnectedForTest(conn);
    (conn as any).csrfToken = 'cached-token';
    (conn as any).cookies = 'SAP_SESSIONID_STUB_100=S1';
    let adtCalls = 0;
    (conn as any).axiosInstance = jest.fn(async (cfg: { url?: string }) => {
      if ((cfg.url ?? '').includes('/discovery')) return discoveryOk(cfg);
      adtCalls += 1;
      return adt(adtCalls, cfg);
    });
    return conn;
  }

  /**
   * Test 7, the pair to the concurrency test: an operation that starts AFTER a
   * completed renewal must be able to renew again. Without this, "renew at most
   * once" could be satisfied by never renewing twice at all — which is what an
   * instance-level re-entrancy flag would do.
   */
  it('an operation starting after a completed renewal may renew again', async () => {
    const refreshToken = jest.fn(async () => 'FRESH');
    const conn = staged(refreshToken, (attempt, cfg) =>
      // Attempts 1 and 3 are the two operations' first tries; 2 and 4 their
      // retries.
      attempt === 1 || attempt === 3
        ? (() => {
            throw unauthorized();
          })()
        : ok(cfg),
    );

    await conn.makeAdtRequest(request);
    expect(refreshToken).toHaveBeenCalledTimes(1);

    // A second operation, started after the first settled completely.
    await conn.makeAdtRequest(request);
    expect(refreshToken).toHaveBeenCalledTimes(2);
  });

  /**
   * Test 11: a re-entrant `makeAdtRequest` on the same connection is its own
   * operation, with its own baseline.
   *
   * The hook has to fire after the renewal has completed and `renewalInFlight`
   * has cleared, but before the outer retry — wrapping `ensureRecovered` is the
   * only window that satisfies all of it. Inside the refresher deadlocks;
   * inside the recovery establishment meets a closed admission door.
   */
  it('a re-entrant request on the same connection gets its own baseline', async () => {
    const refreshToken = jest.fn(async () => 'FRESH');
    const conn = staged(refreshToken, (attempt, cfg) =>
      // 1: outer first try. 2: the inner request. 3: the inner retry.
      // 4: the outer retry.
      attempt === 1 || attempt === 2
        ? (() => {
            throw unauthorized();
          })()
        : ok(cfg),
    );

    const original = (conn as any).ensureRecovered.bind(conn);
    let hooked = false;
    (conn as any).ensureRecovered = async (epoch: number) => {
      const answer = await original(epoch);
      if (!hooked) {
        hooked = true;
        // Inside the outer operation's scope, after its renewal completed.
        await conn.makeAdtRequest(request);
      }
      return answer;
    };

    await conn.makeAdtRequest(request);

    // Two renewals: the outer one, and the inner one which carries a baseline
    // taken after it. With an inherited scope the inner would have read the
    // outer's renewal as its own and skipped a renewal it needed.
    expect(refreshToken).toHaveBeenCalledTimes(2);
  }, 20000);

  /**
   * Test 10: two connections do not share a recovery scope.
   *
   * Driven through `fetchCsrfToken`, and that is the point. `makeAdtRequest`
   * always opens a NEW scope, so a re-entrant request never inherits anything
   * whatever the store is — a version of this test written against it passed
   * with a static store and proved nothing. `fetchCsrfToken` is the handler
   * that *inherits*, so it is the only place the store's ownership shows.
   *
   * The generations must also diverge, or an inherited baseline and an own
   * baseline give the same answer.
   */
  it('two connections do not share a recovery scope', async () => {
    const refreshB = jest.fn(async () => 'FRESH-B');
    const a = new JwtAbapConnection(config, mockLogger, undefined, {
      getToken: async () => 'FRESH-A',
      refreshToken: jest.fn(async () => 'FRESH-A') as never,
    });
    const b = new JwtAbapConnection(config, mockLogger, undefined, {
      getToken: async () => 'FRESH-B',
      refreshToken: refreshB as never,
    });

    // Diverge: B has already refreshed once, A has not.
    (b as any).tokenGeneration = 1;

    const basePrototype = Object.getPrototypeOf(JwtAbapConnection.prototype);
    let csrfCalls = 0;
    jest
      .spyOn(basePrototype as any, 'fetchCsrfToken')
      .mockImplementation(async () => {
        csrfCalls += 1;
        if (csrfCalls === 1) throw unauthorized();
        return 'CSRF';
      });

    // Inside A's live scope, whose baseline is 0.
    await (a as any).inNewRecoveryScope(async () => {
      await (b as any).fetchCsrfToken('https://sap.example.com/x');
    });

    // B renewed on its own account. Under a shared store it would have read
    // A's baseline of 0, seen its own generation of 1 as greater, and skipped
    // the refresh it needed.
    expect(refreshB).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
  });

  /**
   * Test 12: a finished operation's async context is not inherited.
   *
   * `AsyncLocalStorage` propagates its store into every async resource created
   * inside `run()`, and such a resource can outlive the callback. `active` is
   * what makes a stale store visibly stale. Driven through `fetchCsrfToken`
   * for the same reason as test 10.
   */
  it("a finished operation's async context is not inherited", async () => {
    const refreshToken = jest.fn(async () => 'FRESH');
    const conn = new JwtAbapConnection(config, mockLogger, undefined, {
      getToken: async () => 'FRESH',
      refreshToken: refreshToken as never,
    });

    const basePrototype = Object.getPrototypeOf(JwtAbapConnection.prototype);
    let csrfCalls = 0;
    jest
      .spyOn(basePrototype as any, 'fetchCsrfToken')
      .mockImplementation(async () => {
        csrfCalls += 1;
        // The continuation's first attempt fails, so it has to decide whether
        // to refresh — which is the decision under test.
        if (csrfCalls === 2) throw unauthorized();
        return 'CSRF';
      });

    let escaped!: () => Promise<unknown>;
    let seenStore: { active: boolean } | undefined;

    await (conn as any).inNewRecoveryScope(async () => {
      seenStore = (conn as any).recoveryScope.getStore();
      // Bound explicitly: this is how a callback keeps the store after its
      // operation has returned. A plain `.then()` did not reproduce it here,
      // and a test that cannot stage the hazard cannot pin the guard.
      escaped = AsyncResource.bind(() =>
        (conn as any).fetchCsrfToken('https://sap.example.com/x'),
      );
      await (conn as any).fetchCsrfToken('https://sap.example.com/x');
    });

    // The store outlived its operation, and is marked finished.
    expect(seenStore).toBeDefined();
    expect(seenStore?.active).toBe(false);

    // Somebody moved the token after that operation began.
    (conn as any).tokenGeneration = 1;

    await escaped();

    // The continuation still sees the finished scope's store, but `active` is
    // false — so it took its own baseline of 1, found nothing newer, and
    // refreshed. Inheriting the stale baseline of 0 would have read the
    // generation as somebody else's refresh and skipped this one.
    expect(refreshToken).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
  });
});
