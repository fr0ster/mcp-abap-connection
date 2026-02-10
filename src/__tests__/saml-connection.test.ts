/**
 * Unit tests for SAML connection
 */

import type { SapConfig } from '../config/sapConfig.js';
import { SamlAbapConnection } from '../connection/SamlAbapConnection.js';
import type { ILogger } from '../logger.js';

const mockLogger: ILogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

describe('SamlAbapConnection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Config validation', () => {
    it('should accept valid SAML config', () => {
      const config: SapConfig = {
        url: 'https://test.sap.com',
        authType: 'saml',
        sessionCookies: 'MYSAPSSO2=abc',
      };

      expect(() => new SamlAbapConnection(config, mockLogger)).not.toThrow();
    });

    it('should throw error when authType is not saml', () => {
      const config: SapConfig = {
        url: 'https://test.sap.com',
        authType: 'basic' as any,
        sessionCookies: 'MYSAPSSO2=abc',
      };

      expect(() => new SamlAbapConnection(config, mockLogger)).toThrow(
        'SAML connection expects authType "saml"',
      );
    });

    it('should throw error when sessionCookies is missing', () => {
      const config: SapConfig = {
        url: 'https://test.sap.com',
        authType: 'saml',
      } as any;

      expect(() => new SamlAbapConnection(config, mockLogger)).toThrow(
        'SAML authentication requires sessionCookies',
      );
    });
  });

  describe('Auth headers', () => {
    it('should include Cookie header and omit Authorization', async () => {
      const config: SapConfig = {
        url: 'https://test.sap.com',
        authType: 'saml',
        client: '100',
        sessionCookies: 'MYSAPSSO2=abc; SAP_SESSIONID=123',
      };

      const connection = new SamlAbapConnection(config, mockLogger);
      const headers = await connection.getAuthHeaders();

      expect(headers.Cookie).toBe('MYSAPSSO2=abc; SAP_SESSIONID=123');
      expect(headers.Authorization).toBeUndefined();
      expect(headers['X-SAP-Client']).toBe('100');
    });

    it('should seed initial cookies from config', () => {
      const config: SapConfig = {
        url: 'https://test.sap.com',
        authType: 'saml',
        sessionCookies: 'MYSAPSSO2=abc',
      };

      const connection = new SamlAbapConnection(config, mockLogger);
      const cookies = (connection as any).getCookies();

      expect(cookies).toBe('MYSAPSSO2=abc');
    });

    it('should not build Authorization header', () => {
      const config: SapConfig = {
        url: 'https://test.sap.com',
        authType: 'saml',
        sessionCookies: 'MYSAPSSO2=abc',
      };

      const connection = new SamlAbapConnection(config, mockLogger);
      const authHeader = (connection as any).buildAuthorizationHeader();

      expect(authHeader).toBe('');
    });
  });
});
