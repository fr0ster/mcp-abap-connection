/**
 * Getting an RFC conversation out of the config a caller already has.
 *
 * `RfcTransport` takes a factory rather than connection parameters, because the
 * SDK is optional and a transport that reached for it in its constructor could
 * not be built on a machine without it. That is right for the transport and
 * wrong as the only public entry: without this, taking the RFC wire means a
 * consumer writing `require('@mcp-abap-adt/sap-rfc-lite')` and deriving
 * `ashost` and `sysnr` themselves — which is exactly the derivation the class
 * this replaces already did, and would now be copied into every consumer.
 */
import { rfcParamsFrom } from '../connection/rfcConversation.js';

const base = {
  url: 'http://saphost:8000',
  authType: 'basic' as const,
  username: 'USER',
  password: 'PASS',
  client: '100',
};

describe('the connection parameters an RFC conversation needs', () => {
  it('takes the host out of the url', () => {
    expect(rfcParamsFrom(base).ashost).toBe('saphost');
  });

  it('reads the system number off the HTTP port, by SAP convention', () => {
    // 80XX is the ICM port for system XX. Not a guess about the deployment —
    // it is the convention the port itself follows.
    expect(rfcParamsFrom({ ...base, url: 'http://saphost:8042' }).sysnr).toBe(
      '42',
    );
  });

  it('pads a single digit, because sysnr is two', () => {
    expect(rfcParamsFrom({ ...base, url: 'http://saphost:8001' }).sysnr).toBe(
      '01',
    );
  });

  it('lets SAP_SYSNR override it, for a port that follows no convention', () => {
    const previous = process.env.SAP_SYSNR;
    process.env.SAP_SYSNR = '11';
    try {
      expect(
        rfcParamsFrom({ ...base, url: 'https://saphost:50400' }).sysnr,
      ).toBe('11');
    } finally {
      if (previous === undefined) delete process.env.SAP_SYSNR;
      else process.env.SAP_SYSNR = previous;
    }
  });

  it('returns the address only, and needs no user or password', () => {
    const { username: _u, password: _p, ...noCredential } = base;

    expect(rfcParamsFrom(noCredential)).toStrictEqual({
      ashost: 'saphost',
      sysnr: '00',
      client: '100',
      lang: 'EN',
    });
  });

  it('refuses a config it cannot dial', () => {
    expect(() => rfcParamsFrom({ ...base, url: '' })).toThrow(/url/i);
  });
});
