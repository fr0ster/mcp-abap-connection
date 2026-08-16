/**
 * Unit tests for JWT connection
 *
 * Verifies basic JWT connection functionality.
 * Token refresh functionality is handled by auth-broker package.
 */

import type { ITokenRefresher } from '@mcp-abap-adt/interfaces';
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
