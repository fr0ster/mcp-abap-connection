/**
 * Unit tests for sapConfigSignature
 */

import type { ISapConfig } from '@mcp-abap-adt/interfaces';
import { sapConfigSignature } from '../config/sapConfig.js';

describe('sapConfigSignature', () => {
  it('should include token previews and mask password', () => {
    const config: ISapConfig = {
      url: 'https://test.sap.com',
      authType: 'jwt',
      username: 'user',
      password: 'secret',
      jwtToken: '1234567890ABCDEFGHIJ',
      refreshToken: 'abcdefghijKLMNOPQRST',
      sessionCookies: 'cookie1234567890cookie',
    };

    const signature = sapConfigSignature(config);
    const parsed = JSON.parse(signature);

    expect(parsed.url).toBe('https://test.sap.com');
    expect(parsed.authType).toBe('jwt');
    expect(parsed.username).toBe('user');
    expect(parsed.password).toBe('set');
    expect(parsed.jwtToken).toBe('1234567890...ABCDEFGHIJ');
    expect(parsed.refreshToken).toBe('abcdefghij...KLMNOPQRST');
    expect(parsed.sessionCookies).toBe('cookie1234...7890cookie');
  });

  it('should handle missing optional fields', () => {
    const config: ISapConfig = {
      url: 'https://test.sap.com',
      authType: 'basic',
    };

    const signature = sapConfigSignature(config);
    const parsed = JSON.parse(signature);

    expect(parsed.client).toBeNull();
    expect(parsed.username).toBeNull();
    expect(parsed.password).toBeNull();
    expect(parsed.jwtToken).toBeNull();
    expect(parsed.refreshToken).toBeNull();
    expect(parsed.sessionCookies).toBeNull();
  });
});
