/**
 * Unit tests for JWT connection
 *
 * Verifies basic JWT connection functionality.
 * Token refresh functionality is handled by auth-broker package.
 */

import type { ITokenRefresher } from '@mcp-abap-adt/interfaces';
import type { SapConfig } from '../config/sapConfig.js';
import { CSRF_CONFIG } from '../connection/csrfConfig.js';
import { JwtAbapConnection } from '../connection/JwtAbapConnection.js';
import type { ILogger } from '../logger.js';

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
