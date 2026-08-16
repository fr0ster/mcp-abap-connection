/**
 * Unit tests for JWT connection
 *
 * Verifies basic JWT connection functionality.
 * Token refresh functionality is handled by auth-broker package.
 */

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
