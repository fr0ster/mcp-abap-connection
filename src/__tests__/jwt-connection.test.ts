/**
 * Unit tests for JWT connection
 *
 * Verifies basic JWT connection functionality.
 * Token refresh functionality is handled by auth-broker package.
 */

import type { ITokenRefresher } from '@mcp-abap-adt/interfaces';
import type { SapConfig } from '../config/sapConfig.js';
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
