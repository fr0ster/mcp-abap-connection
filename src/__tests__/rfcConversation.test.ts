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
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type RfcConnectionParams,
  rfcParamsFrom,
} from '../connection/rfcConversation.js';
import { assertMatchObject } from './helpers/assertions.js';

/** The application-server address, or a failed expectation: the result is a union. */
function appServer(
  config: Parameters<typeof rfcParamsFrom>[0],
): RfcConnectionParams {
  const params = rfcParamsFrom(config);
  if (!('ashost' in params))
    throw new Error('expected an application-server address');
  return params;
}

const base = {
  url: 'http://saphost:8000',
  authType: 'basic' as const,
  username: 'USER',
  password: 'PASS',
  client: '100',
};

describe('the connection parameters an RFC conversation needs', () => {
  it('takes the host out of the url', () => {
    assert.strictEqual(appServer(base).ashost, 'saphost');
  });

  it('reads the system number off the HTTP port, by SAP convention', () => {
    // 80XX is the ICM port for system XX. Not a guess about the deployment —
    // it is the convention the port itself follows.
    assert.strictEqual(
      appServer({ ...base, url: 'http://saphost:8042' }).sysnr,
      '42',
    );
  });

  it('pads a single digit, because sysnr is two', () => {
    assert.strictEqual(
      appServer({ ...base, url: 'http://saphost:8001' }).sysnr,
      '01',
    );
  });

  it('lets SAP_SYSNR override it, for a port that follows no convention', () => {
    const previous = process.env.SAP_SYSNR;
    process.env.SAP_SYSNR = '11';
    try {
      assert.strictEqual(
        appServer({ ...base, url: 'https://saphost:50400' }).sysnr,
        '11',
      );
    } finally {
      if (previous === undefined) delete process.env.SAP_SYSNR;
      else process.env.SAP_SYSNR = previous;
    }
  });

  it('returns the address only, and needs no user or password', () => {
    const { username: _u, password: _p, ...noCredential } = base;

    assert.deepStrictEqual(rfcParamsFrom(noCredential), {
      ashost: 'saphost',
      sysnr: '00',
      client: '100',
      lang: 'EN',
    });
  });

  it('refuses a config it cannot dial', () => {
    assert.throws(
      () => rfcParamsFrom({ ...base, url: '' }),
      (e: unknown) => /url/i.test((e as Error).message),
    );
  });

  it('carries a SAProuter string with one application server', () => {
    assert.deepStrictEqual(
      rfcParamsFrom({ ...base, saprouter: '/H/router.example.com/S/3299/H/' }),
      {
        ashost: 'saphost',
        sysnr: '00',
        client: '100',
        lang: 'EN',
        saprouter: '/H/router.example.com/S/3299/H/',
      },
    );
  });
});

describe('the address of an RFC conversation through a message server', () => {
  const ms = { ...base, mshost: 'msgserver.example.com' };

  it('dials the message server with the logon group, and takes nothing from the url', () => {
    assert.deepStrictEqual(
      rfcParamsFrom({
        ...ms,
        msserv: '3600',
        group: 'SPACE',
        url: 'http://saphost:8042',
      }),
      {
        mshost: 'msgserver.example.com',
        msserv: '3600',
        group: 'SPACE',
        client: '100',
        lang: 'EN',
      },
    );
  });

  it('takes sysid when msserv is absent', () => {
    assert.deepStrictEqual(rfcParamsFrom({ ...ms, sysid: 'ABC' }), {
      mshost: 'msgserver.example.com',
      sysid: 'ABC',
      group: 'PUBLIC',
      client: '100',
      lang: 'EN',
    });
  });

  it('defaults the logon group to PUBLIC', () => {
    assertMatchObject(rfcParamsFrom({ ...ms, msserv: '3600' }), {
      group: 'PUBLIC',
    });
  });

  it('carries a SAProuter string', () => {
    assertMatchObject(
      rfcParamsFrom({ ...ms, msserv: '3600', saprouter: '/H/r/S/3299/H/' }),
      { saprouter: '/H/r/S/3299/H/' },
    );
  });

  it('needs no url', () => {
    assertMatchObject(rfcParamsFrom({ ...ms, msserv: '3600', url: '' }), {
      mshost: 'msgserver.example.com',
    });
  });

  it('ignores SAP_SYSNR, which belongs to one application server', () => {
    const previous = process.env.SAP_SYSNR;
    process.env.SAP_SYSNR = '11';
    try {
      assert.ok(!('sysnr' in rfcParamsFrom({ ...ms, msserv: '3600' })));
    } finally {
      if (previous === undefined) delete process.env.SAP_SYSNR;
      else process.env.SAP_SYSNR = previous;
    }
  });

  it('refuses a message server without msserv or sysid, naming both', () => {
    assert.throws(
      () => rfcParamsFrom(ms),
      (e: unknown) => /msserv or sysid/.test((e as Error).message),
    );
  });
});
