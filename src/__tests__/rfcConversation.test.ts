/**
 * The address an RFC conversation dials, read out of the config as stated.
 *
 * `RfcTransport` takes a factory rather than connection parameters, because the
 * SDK is optional and a transport that reached for it in its constructor could
 * not be built on a machine without it. `rfcConversationFrom` is that factory
 * from the config a caller already holds, and `rfcParamsFrom` is what it dials:
 * the config's own address, client and language, and nothing else — no default,
 * nothing derived from a URL, nothing read from the environment, nothing trimmed.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ISapRfcApplicationServer,
  ISapRfcMessageServer,
} from '@mcp-abap-adt/interfaces-auth-sap';
import {
  rfcConversationFrom,
  rfcParamsFrom,
} from '../connection/rfcConversation.js';
import { withModule } from './helpers/moduleCache.js';

const appServer: ISapRfcApplicationServer = {
  connectionType: 'rfc',
  authType: 'basic',
  ashost: 'saphost',
  sysnr: '42',
  client: '100',
  language: 'DE',
};

const messageServer: ISapRfcMessageServer = {
  connectionType: 'rfc',
  authType: 'basic',
  mshost: 'msgserver.example.com',
  msserv: '3600',
  group: 'SPACE',
  client: '200',
  language: 'UK',
};

/** Runs `run` with `SAP_SYSNR` set to `value`, then puts the environment back. */
function withSysnr<T>(value: string, run: () => T): T {
  const previous = process.env.SAP_SYSNR;
  process.env.SAP_SYSNR = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.SAP_SYSNR;
    else process.env.SAP_SYSNR = previous;
  }
}

describe('the address of one application server', () => {
  it('is exactly the host, the system number, the client and the language stated', () => {
    assert.deepStrictEqual(rfcParamsFrom(appServer), {
      ashost: 'saphost',
      sysnr: '42',
      client: '100',
      lang: 'DE',
    });
  });

  it('takes the logon language from language, as the SDK’s lang', () => {
    assert.deepStrictEqual(rfcParamsFrom({ ...appServer, language: 'FR' }), {
      ashost: 'saphost',
      sysnr: '42',
      client: '100',
      lang: 'FR',
    });
  });

  it('reads no SAP_SYSNR from the environment', () => {
    assert.deepStrictEqual(
      withSysnr('11', () => rfcParamsFrom(appServer)),
      rfcParamsFrom(appServer),
    );
  });

  it('carries a SAProuter string exactly when one is stated', () => {
    assert.deepStrictEqual(
      rfcParamsFrom({ ...appServer, saprouter: '/H/router/S/3299/H/' }),
      {
        ashost: 'saphost',
        sysnr: '42',
        client: '100',
        lang: 'DE',
        saprouter: '/H/router/S/3299/H/',
      },
    );
    assert.ok(!('saprouter' in rfcParamsFrom(appServer)));
  });

  it('defaults no client: an empty client stays empty', () => {
    assert.strictEqual(rfcParamsFrom({ ...appServer, client: '' }).client, '');
  });

  it('passes every value through untrimmed', () => {
    assert.deepStrictEqual(
      rfcParamsFrom({
        ...appServer,
        ashost: ' saphost ',
        sysnr: ' 42 ',
        client: ' 100 ',
        language: ' DE ',
        saprouter: ' /H/r/H/ ',
      }),
      {
        ashost: ' saphost ',
        sysnr: ' 42 ',
        client: ' 100 ',
        lang: ' DE ',
        saprouter: ' /H/r/H/ ',
      },
    );
  });
});

describe('the address of a message server', () => {
  it('is exactly the host, the service, the group, the client and the language stated', () => {
    assert.deepStrictEqual(rfcParamsFrom(messageServer), {
      mshost: 'msgserver.example.com',
      msserv: '3600',
      group: 'SPACE',
      client: '200',
      lang: 'UK',
    });
  });

  it('takes sysid alone as the service', () => {
    const { msserv: _msserv, ...rest } = messageServer;
    assert.deepStrictEqual(rfcParamsFrom({ ...rest, sysid: 'ABC' }), {
      mshost: 'msgserver.example.com',
      sysid: 'ABC',
      group: 'SPACE',
      client: '200',
      lang: 'UK',
    });
  });

  it('carries msserv and sysid both when both are stated', () => {
    assert.deepStrictEqual(rfcParamsFrom({ ...messageServer, sysid: 'ABC' }), {
      mshost: 'msgserver.example.com',
      msserv: '3600',
      sysid: 'ABC',
      group: 'SPACE',
      client: '200',
      lang: 'UK',
    });
  });

  it('carries a SAProuter string exactly when one is stated', () => {
    assert.strictEqual(
      rfcParamsFrom({ ...messageServer, saprouter: '/H/r/S/3299/H/' })
        .saprouter,
      '/H/r/S/3299/H/',
    );
    assert.ok(!('saprouter' in rfcParamsFrom(messageServer)));
  });

  it('defaults no group: an empty group stays empty', () => {
    const params = rfcParamsFrom({ ...messageServer, group: '' });
    assert.ok('group' in params);
    assert.strictEqual(params.group, '');
  });

  it('reads no SAP_SYSNR from the environment', () => {
    assert.deepStrictEqual(
      withSysnr('11', () => rfcParamsFrom(messageServer)),
      rfcParamsFrom(messageServer),
    );
  });

  it('passes every value through untrimmed', () => {
    assert.deepStrictEqual(
      rfcParamsFrom({
        ...messageServer,
        mshost: ' ms ',
        msserv: ' 3600 ',
        sysid: ' ABC ',
        group: ' SPACE ',
      }),
      {
        mshost: ' ms ',
        msserv: ' 3600 ',
        sysid: ' ABC ',
        group: ' SPACE ',
        client: '200',
        lang: 'UK',
      },
    );
  });
});

describe('the conversation factory', () => {
  /** What the stand-in SDK client was constructed with, one entry per open. */
  function constructedFrom(
    open: () => void,
  ): ReadonlyArray<Record<string, unknown>> {
    const constructed: Record<string, unknown>[] = [];
    withModule(
      '@mcp-abap-adt/sap-rfc-lite',
      {
        Client: class {
          constructor(params: Record<string, unknown>) {
            constructed.push({ ...params });
          }
        },
      },
      open,
    );
    return constructed;
  }

  it('dials the stated application server with the logon spread over it', () => {
    const constructed = constructedFrom(() => {
      rfcConversationFrom(appServer)({ user: 'U', passwd: 'P' });
    });
    assert.deepStrictEqual(constructed, [
      {
        ashost: 'saphost',
        sysnr: '42',
        client: '100',
        lang: 'DE',
        user: 'U',
        passwd: 'P',
      },
    ]);
  });

  it('dials the stated message server with the logon spread over it', () => {
    const constructed = constructedFrom(() => {
      rfcConversationFrom({ ...messageServer, saprouter: '/H/r/H/' })({
        snc_partnername: 'p:CN=X',
        snc_qop: '9',
      });
    });
    assert.deepStrictEqual(constructed, [
      {
        mshost: 'msgserver.example.com',
        msserv: '3600',
        group: 'SPACE',
        client: '200',
        lang: 'UK',
        saprouter: '/H/r/H/',
        snc_partnername: 'p:CN=X',
        snc_qop: '9',
      },
    ]);
  });

  it('builds its factory from any stated address without throwing', () => {
    assert.doesNotThrow(() => rfcConversationFrom(appServer));
    assert.doesNotThrow(() => rfcConversationFrom(messageServer));
  });
});
