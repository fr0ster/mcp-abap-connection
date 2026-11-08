/**
 * Unit tests for sapConfigSignature
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ISapConfig,
  ISapRfcApplicationServer,
  ISapRfcMessageServer,
} from '@mcp-abap-adt/interfaces-auth-sap';
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

describe('sapConfigSignature names the RFC address', () => {
  const appServer: ISapRfcApplicationServer = {
    connectionType: 'rfc',
    authType: 'basic',
    ashost: 'saphost',
    sysnr: '00',
    client: '100',
    language: 'EN',
  };
  const messageServer: ISapRfcMessageServer = {
    connectionType: 'rfc',
    authType: 'basic',
    mshost: 'msgserver',
    msserv: '3600',
    group: 'SPACE',
    client: '100',
    language: 'EN',
  };

  /** Two configs that differ in one field must not share a signature. */
  function signsApart(first: ISapConfig, second: ISapConfig): void {
    assert.notStrictEqual(
      sapConfigSignature(first),
      sapConfigSignature(second),
    );
  }

  it('differs by connectionType', () => {
    signsApart(
      { url: 'https://test.sap.com', authType: 'basic' },
      {
        connectionType: 'http',
        url: 'https://test.sap.com',
        authType: 'basic',
      },
    );
  });

  it('differs by the application server: ashost, sysnr', () => {
    signsApart(appServer, { ...appServer, ashost: 'otherhost' });
    signsApart(appServer, { ...appServer, sysnr: '01' });
  });

  it('differs by the message server: mshost, msserv, sysid, group', () => {
    signsApart(messageServer, { ...messageServer, mshost: 'otherms' });
    signsApart(messageServer, { ...messageServer, msserv: '3601' });
    signsApart(messageServer, { ...messageServer, sysid: 'ABC' });
    signsApart(messageServer, { ...messageServer, group: 'OTHER' });
  });

  it('differs by saprouter', () => {
    signsApart(appServer, { ...appServer, saprouter: '/H/router/H/' });
    signsApart(messageServer, { ...messageServer, saprouter: '/H/router/H/' });
  });

  it('differs by client over RFC', () => {
    signsApart(appServer, { ...appServer, client: '200' });
  });

  it('differs by language over RFC', () => {
    signsApart(appServer, { ...appServer, language: 'DE' });
  });
});
