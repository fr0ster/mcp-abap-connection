/**
 * Unit tests for connection factory
 */

import type { ITokenRefresher } from '@mcp-abap-adt/interfaces';
import type { SapConfig } from '../config/sapConfig.js';
import { BaseAbapConnection } from '../connection/BaseAbapConnection.js';
import { CertificateAbapConnection } from '../connection/CertificateAbapConnection.js';
import { createAbapConnection } from '../connection/connectionFactory.js';
import { JwtAbapConnection } from '../connection/JwtAbapConnection.js';
import { KerberosAbapConnection } from '../connection/KerberosAbapConnection.js';
import { SamlAbapConnection } from '../connection/SamlAbapConnection.js';
import type { ILogger } from '../logger.js';

const mockLogger: ILogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

describe('createAbapConnection', () => {
  it('should create BaseAbapConnection for basic auth', () => {
    const config: SapConfig = {
      url: 'https://test.sap.com',
      authType: 'basic',
      username: 'user',
      password: 'pass',
      client: '100',
    };

    const connection = createAbapConnection(config, mockLogger);
    expect(connection).toBeInstanceOf(BaseAbapConnection);
  });

  it('should create JwtAbapConnection for jwt auth', () => {
    const config: SapConfig = {
      url: 'https://test.sap.com',
      authType: 'jwt',
      jwtToken: 'jwt-token',
    };

    const tokenRefresher: ITokenRefresher = {
      getToken: jest.fn().mockResolvedValue('token'),
      refreshToken: jest.fn().mockResolvedValue('token'),
    };

    const connection = createAbapConnection(
      config,
      mockLogger,
      undefined,
      tokenRefresher,
    );

    expect(connection).toBeInstanceOf(JwtAbapConnection);
  });

  it('should create SamlAbapConnection for saml auth', () => {
    const config: SapConfig = {
      url: 'https://test.sap.com',
      authType: 'saml',
      sessionCookies: 'MYSAPSSO2=abc',
    };

    const connection = createAbapConnection(config, mockLogger);
    expect(connection).toBeInstanceOf(SamlAbapConnection);
  });

  it('should throw for unsupported auth type', () => {
    const config: SapConfig = {
      url: 'https://test.sap.com',
      authType: 'token' as any,
    };

    expect(() => createAbapConnection(config, mockLogger)).toThrow(
      'Unsupported SAP authentication type: token',
    );
  });

  test('creates CertificateAbapConnection for authType certificate', () => {
    const c = createAbapConnection(
      {
        url: 'https://h',
        authType: 'certificate',
        certPath: '/c',
        certKeyPath: '/k',
      } as any,
      null,
    );
    expect(c.constructor.name).toBe('CertificateAbapConnection');
  });

  test('creates KerberosAbapConnection for authType kerberos', () => {
    const c = createAbapConnection(
      { url: 'https://h', authType: 'kerberos', kerberosSpn: 'HTTP@h' } as any,
      null,
    );
    expect(c.constructor.name).toBe('KerberosAbapConnection');
  });

  test('throws for certificate + rfc', () => {
    expect(() =>
      createAbapConnection(
        {
          url: 'https://h',
          authType: 'certificate',
          connectionType: 'rfc',
          certPath: '/c',
          certKeyPath: '/k',
        } as any,
        null,
      ),
    ).toThrow(/rfc/i);
  });
});
