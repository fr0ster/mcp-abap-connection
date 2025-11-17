/**
 * Unit tests for automatic JWT token refresh functionality
 *
 * These are lightweight unit tests that verify the auto-refresh logic configuration.
 * Full integration tests (with actual HTTP calls) are in packages/adt-clients/src/__tests__/integration/
 */

import { CloudAbapConnection } from '../connection/CloudAbapConnection.js';
import { SapConfig } from '../config/sapConfig.js';
import { ILogger } from '../logger.js';

// Mock logger
const mockLogger: ILogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

describe('Auto-refresh JWT token - Unit Tests', () => {
  let connection: CloudAbapConnection;
  let mockConfig: SapConfig;

  beforeEach(() => {
    jest.clearAllMocks();

    // Base config with expired JWT and valid refresh credentials
    mockConfig = {
      url: 'https://test.sap.com',
      authType: 'jwt',
      jwtToken: 'expired-jwt-token',
      refreshToken: 'valid-refresh-token',
      uaaUrl: 'https://uaa.test.sap.com',
      uaaClientId: 'test-client-id',
      uaaClientSecret: 'test-client-secret',
    };
  });

  describe('canRefreshToken()', () => {
    it('should return true when all UAA credentials are present', () => {
      connection = new CloudAbapConnection(mockConfig, mockLogger);
      expect(connection.canRefreshToken()).toBe(true);
    });

    it('should return false when refreshToken is missing', () => {
      delete mockConfig.refreshToken;
      connection = new CloudAbapConnection(mockConfig, mockLogger);
      expect(connection.canRefreshToken()).toBe(false);
    });

    it('should return false when uaaUrl is missing', () => {
      delete mockConfig.uaaUrl;
      connection = new CloudAbapConnection(mockConfig, mockLogger);
      expect(connection.canRefreshToken()).toBe(false);
    });

    it('should return false when uaaClientId is missing', () => {
      delete mockConfig.uaaClientId;
      connection = new CloudAbapConnection(mockConfig, mockLogger);
      expect(connection.canRefreshToken()).toBe(false);
    });

    it('should return false when uaaClientSecret is missing', () => {
      delete mockConfig.uaaClientSecret;
      connection = new CloudAbapConnection(mockConfig, mockLogger);
      expect(connection.canRefreshToken()).toBe(false);
    });

    it('should return true with all credentials even if jwtToken is expired', () => {
      // Simulate expired JWT (just a different token, not validated here)
      mockConfig.jwtToken = 'definitely-expired-token';
      connection = new CloudAbapConnection(mockConfig, mockLogger);

      // canRefreshToken should still return true - it only checks credentials presence
      expect(connection.canRefreshToken()).toBe(true);
    });
  });

  describe('Config validation', () => {
    it('should accept valid JWT config with refresh credentials', () => {
      expect(() => new CloudAbapConnection(mockConfig, mockLogger)).not.toThrow();
    });

    it('should throw error when authType is not jwt', () => {
      const invalidConfig = { ...mockConfig, authType: 'basic' as any };
      expect(() => new CloudAbapConnection(invalidConfig, mockLogger))
        .toThrow('Cloud connection expects authType "jwt"');
    });

    it('should throw error when jwtToken is missing', () => {
      delete mockConfig.jwtToken;
      expect(() => new CloudAbapConnection(mockConfig, mockLogger))
        .toThrow('JWT authentication requires SAP_JWT_TOKEN');
    });

    it('should not throw when refresh credentials are missing (optional for auto-refresh)', () => {
      delete mockConfig.refreshToken;
      delete mockConfig.uaaUrl;
      delete mockConfig.uaaClientId;
      delete mockConfig.uaaClientSecret;

      // Should not throw - refresh credentials are optional
      expect(() => new CloudAbapConnection(mockConfig, mockLogger)).not.toThrow();

      // But canRefreshToken should return false
      connection = new CloudAbapConnection(mockConfig, mockLogger);
      expect(connection.canRefreshToken()).toBe(false);
    });
  });

  describe('Refresh credentials combinations', () => {
    it('should return false when only refreshToken is present', () => {
      delete mockConfig.uaaUrl;
      delete mockConfig.uaaClientId;
      delete mockConfig.uaaClientSecret;
      connection = new CloudAbapConnection(mockConfig, mockLogger);
      expect(connection.canRefreshToken()).toBe(false);
    });

    it('should return false when only UAA URL is missing', () => {
      delete mockConfig.uaaUrl;
      connection = new CloudAbapConnection(mockConfig, mockLogger);
      expect(connection.canRefreshToken()).toBe(false);
    });

    it('should return false when only UAA client ID is missing', () => {
      delete mockConfig.uaaClientId;
      connection = new CloudAbapConnection(mockConfig, mockLogger);
      expect(connection.canRefreshToken()).toBe(false);
    });

    it('should return false when only UAA client secret is missing', () => {
      delete mockConfig.uaaClientSecret;
      connection = new CloudAbapConnection(mockConfig, mockLogger);
      expect(connection.canRefreshToken()).toBe(false);
    });
  });
});
