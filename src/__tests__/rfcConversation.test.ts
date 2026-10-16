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

  it('carries a SAProuter string with one application server', () => {
    expect(
      rfcParamsFrom({ ...base, saprouter: '/H/router.example.com/S/3299/H/' }),
    ).toStrictEqual({
      ashost: 'saphost',
      sysnr: '00',
      client: '100',
      lang: 'EN',
      saprouter: '/H/router.example.com/S/3299/H/',
    });
  });
});

describe('the address of an RFC conversation through a message server', () => {
  const ms = { ...base, mshost: 'msgserver.example.com' };

  it('dials the message server with the logon group, and takes nothing from the url', () => {
    expect(
      rfcParamsFrom({
        ...ms,
        msserv: '3600',
        group: 'SPACE',
        url: 'http://saphost:8042',
      }),
    ).toStrictEqual({
      mshost: 'msgserver.example.com',
      msserv: '3600',
      group: 'SPACE',
      client: '100',
      lang: 'EN',
    });
  });

  it('takes sysid when msserv is absent', () => {
    expect(rfcParamsFrom({ ...ms, sysid: 'ABC' })).toStrictEqual({
      mshost: 'msgserver.example.com',
      sysid: 'ABC',
      group: 'PUBLIC',
      client: '100',
      lang: 'EN',
    });
  });

  it('defaults the logon group to PUBLIC', () => {
    expect(rfcParamsFrom({ ...ms, msserv: '3600' })).toMatchObject({
      group: 'PUBLIC',
    });
  });

  it('carries a SAProuter string', () => {
    expect(
      rfcParamsFrom({ ...ms, msserv: '3600', saprouter: '/H/r/S/3299/H/' }),
    ).toMatchObject({ saprouter: '/H/r/S/3299/H/' });
  });

  it('needs no url', () => {
    expect(rfcParamsFrom({ ...ms, msserv: '3600', url: '' })).toMatchObject({
      mshost: 'msgserver.example.com',
    });
  });

  it('ignores SAP_SYSNR, which belongs to one application server', () => {
    const previous = process.env.SAP_SYSNR;
    process.env.SAP_SYSNR = '11';
    try {
      expect(rfcParamsFrom({ ...ms, msserv: '3600' })).not.toHaveProperty(
        'sysnr',
      );
    } finally {
      if (previous === undefined) delete process.env.SAP_SYSNR;
      else process.env.SAP_SYSNR = previous;
    }
  });

  it('refuses a message server without msserv or sysid, naming both', () => {
    expect(() => rfcParamsFrom(ms)).toThrow(/msserv or sysid/);
  });
});
