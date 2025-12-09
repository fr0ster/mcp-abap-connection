/**
 * Unit tests for JWT connection
 * 
 * Verifies basic JWT connection functionality.
 * Token refresh functionality is handled by auth-broker package.
 */

import { JwtAbapConnection } from '../connection/JwtAbapConnection.js';
import { SapConfig } from '../config/sapConfig.js';
import { ILogger } from '../logger.js';

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
      expect(() => new JwtAbapConnection(config, mockLogger))
        .toThrow('JWT connection expects authType "jwt"');
    });

    it('should throw error when jwtToken is missing', () => {
      const config: SapConfig = {
        url: 'https://test.sap.com',
        authType: 'jwt',
        // jwtToken is missing
      } as any;
      expect(() => new JwtAbapConnection(config, mockLogger))
        .toThrow('JWT authentication requires SAP_JWT_TOKEN');
    });
  });
});
