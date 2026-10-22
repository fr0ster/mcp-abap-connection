/**
 * Unit tests for sapConfigSignature
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ISapConfig } from '@mcp-abap-adt/interfaces-auth-sap';
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

    assert.strictEqual(parsed.url, 'https://test.sap.com');
    assert.strictEqual(parsed.authType, 'jwt');
    assert.strictEqual(parsed.username, 'user');
    assert.strictEqual(parsed.password, 'set');
    assert.strictEqual(parsed.jwtToken, '1234567890...ABCDEFGHIJ');
    assert.strictEqual(parsed.refreshToken, 'abcdefghij...KLMNOPQRST');
    assert.strictEqual(parsed.sessionCookies, 'cookie1234...7890cookie');
  });

  it('should handle missing optional fields', () => {
    const config: ISapConfig = {
      url: 'https://test.sap.com',
      authType: 'basic',
    };

    const signature = sapConfigSignature(config);
    const parsed = JSON.parse(signature);

    assert.strictEqual(parsed.client, null);
    assert.strictEqual(parsed.username, null);
    assert.strictEqual(parsed.password, null);
    assert.strictEqual(parsed.jwtToken, null);
    assert.strictEqual(parsed.refreshToken, null);
    assert.strictEqual(parsed.sessionCookies, null);
  });
});
