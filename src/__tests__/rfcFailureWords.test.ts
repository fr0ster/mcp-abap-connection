/**
 * What the RFC SDK said reaches a caller only through its typed fields.
 *
 * The NW RFC SDK's error text names the partner it dialled (`host:port`), the
 * time, the SDK release and the source module of the kernel — a gateway's
 * address a consumer would hand on to whoever reads its errors. So no error
 * this package raises for an RFC failure, and no log line it writes, carries
 * any of that text: the failure is said in fixed words built from `rfc`
 * (`codeString`, one of the closed list `RFC_RCS`), and `rfc` itself keeps
 * `{ key, group, code, codeString }` as before.
 *
 * The one place the SDK's own error is handed on as it is: a refused logon's
 * cause, which the provider reads (`IAuthRejection.error`) — a wire's mark,
 * not a message.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';
import type { ISapRfcConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import {
  WireLogonError,
  WireSessionLostError,
} from '../connection/authErrors.js';
import {
  type IRfcConversation,
  RfcTransport,
} from '../connection/RfcTransport.js';
import { rfcConversationFrom } from '../connection/rfcConversation.js';
import type { ILogger } from '../logger.js';
import { withModule, withModuleAsync } from './helpers/moduleCache.js';
import { dies, fails, standInFactory } from './helpers/rfcStandIn.js';
import { stubProvider } from './helpers/stubProvider.js';

/** The SDK's words for a broken gateway connection, as the kernel writes them. */
const SDK_TEXT = [
  "partner 'PARTNER-SENTINEL:PORT-SENTINEL' not reached",
  '',
  'LOCATION    CPIC (TCP/IP) on local host LOCAL-HOST-SENTINEL with Unicode',
  'ERROR       partner PARTNER-SENTINEL:PORT-SENTINEL not reached',
  'TIME        Thu Nov 13 10:11:12 2026',
  'RELEASE     753',
  'COMPONENT   NI (network interface)',
  'MODULE      /bas/753_REL/src/base/ni/nixxi.cpp',
  'LINE        3283',
].join('\n');

/** Every piece of `SDK_TEXT` that must reach nothing. */
const LEAKS = [
  'PARTNER-SENTINEL',
  'LOCAL-HOST-SENTINEL',
  'PORT-SENTINEL',
  'partner',
  'not reached',
  'Nov 13',
  '10:11:12',
  '/bas/',
  'nixxi.cpp',
  'CPIC',
  'LOCATION',
  'COMPONENT',
];

const FAILED = 'RFC call to SADT_REST_RFC_ENDPOINT failed: ';

const FIELDS = {
  key: 'RFC_COMMUNICATION_FAILURE',
  group: 1,
  code: 1,
  codeString: 'RFC_COMMUNICATION_FAILURE',
};

/** What sap-rfc-lite rejects with when the gateway is gone. */
function sdkFailure(): Record<string, unknown> {
  return { name: 'RfcLibError', ...FIELDS, message: SDK_TEXT };
}

/** The same text in a value that is not the SDK's error shape. */
function shapeless(): Record<string, unknown> {
  return { name: 'nodeRfcError', message: SDK_TEXT };
}

/** Every rendering of `value` a consumer could put in front of someone. */
function renderings(value: unknown): string[] {
  const forms = [
    String(value),
    inspect(value, { depth: 10, showHidden: true }),
  ];
  try {
    forms.push(String(JSON.stringify(value)));
  } catch {
    // A value that does not serialise has no JSON form to leak through.
  }
  if (value instanceof Error) {
    forms.push(value.message, String(value.stack));
  }
  if (typeof value === 'object' && value !== null) {
    for (const name of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      forms.push(inspect(descriptor?.value, { depth: 10, showHidden: true }));
    }
  }
  return forms;
}

function assertNoSdkText(value: unknown, where: string): void {
  for (const form of renderings(value)) {
    for (const leak of LEAKS) {
      assert.ok(
        !form.includes(leak),
        `${where} carries ${JSON.stringify(leak)}: ${form}`,
      );
    }
  }
}

/** A logger that keeps every argument of every call, at every level. */
function recordingLogger(): { logger: ILogger; lines: unknown[][] } {
  const lines: unknown[][] = [];
  const keep = (...args: unknown[]): void => {
    lines.push(args);
  };
  return {
    logger: { info: keep, warn: keep, debug: keep, error: keep },
    lines,
  };
}

function assertLogClean(lines: unknown[][]): void {
  assert.ok(lines.length > 0, 'something was logged');
  for (const line of lines) assertNoSdkText(line, 'a log line');
}

async function rejection(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof Error, 'an Error reaches the caller');
    return error;
  }
  assert.fail('the request was expected to fail');
}

function rfcOf(error: Error): unknown {
  return Object.getOwnPropertyDescriptor(error, 'rfc')?.value;
}

type Route = 'stateful' | 'kept' | 'throwaway';

/** The wire, with every conversation's every call rejecting with `thrown`. */
function wireRejecting(
  thrown: unknown,
  route: Route,
  logger: ILogger,
): RfcTransport {
  return new RfcTransport(() => {
    const conversation: IRfcConversation = {
      alive: true,
      open: async () => {},
      close: async () => {},
      resetServerContext: async () => {},
      call: async () => {
        throw thrown;
      },
    };
    if (route !== 'throwaway') return conversation;
    const { resetServerContext: _reset, ...withoutReset } = conversation;
    return withoutReset;
  }, logger);
}

describe('a failed RFC call carries the SDK’s fields, never its text', () => {
  for (const route of ['stateful', 'kept', 'throwaway'] as const) {
    it(`the error and the log line name the return code only (${route})`, async () => {
      const { logger, lines } = recordingLogger();
      const transport = wireRejecting(sdkFailure(), route, logger);
      await transport.open();

      const error = await rejection(
        transport.send({
          method: 'GET',
          url: '/sap/bc/adt/discovery',
          stateful: route === 'stateful',
        }),
      );

      assert.strictEqual(error.message, `${FAILED}RFC_COMMUNICATION_FAILURE`);
      assert.deepStrictEqual(rfcOf(error), FIELDS);
      assertNoSdkText(error, 'the error');
      assertLogClean(lines);
    });
  }

  it('a thrown value that is not the SDK’s shape is said in fixed words', async () => {
    const { logger, lines } = recordingLogger();
    const transport = wireRejecting(shapeless(), 'stateful', logger);
    await transport.open();

    const error = await rejection(
      transport.send({ method: 'GET', url: '/x', stateful: true }),
    );

    assert.strictEqual(
      error.message,
      `${FAILED}the SDK did not name the failure`,
    );
    assert.strictEqual(Object.hasOwn(error, 'rfc'), false);
    assertNoSdkText(error, 'the error');
    assertLogClean(lines);
  });

  it('an Error the SDK threw is said in fixed words too', async () => {
    const { logger, lines } = recordingLogger();
    const transport = wireRejecting(new Error(SDK_TEXT), 'kept', logger);
    await transport.open();

    const error = await rejection(transport.send({ method: 'GET', url: '/x' }));

    assert.strictEqual(
      error.message,
      `${FAILED}the SDK did not name the failure`,
    );
    assertNoSdkText(error, 'the error');
    assertLogClean(lines);
  });

  it('the session the call ended: WireSessionLostError, in the same fixed words', async () => {
    const { logger, lines } = recordingLogger();
    const { factory } = standInFactory([[dies(sdkFailure())]], true);
    const transport = new RfcTransport(factory, logger);
    await transport.open();

    const error = await rejection(
      transport.send({
        method: 'POST',
        url: '/x?_action=LOCK',
        stateful: true,
      }),
    );

    assert.ok(error instanceof WireSessionLostError);
    assert.strictEqual(error.message, `${FAILED}RFC_COMMUNICATION_FAILURE`);
    assert.deepStrictEqual(error.rfc, FIELDS);
    assertNoSdkText(error, 'the error');
    assertLogClean(lines);
  });
});

describe('the connection hands on no SDK text either', () => {
  const config: ISapRfcConfig = {
    connectionType: 'rfc',
    authType: 'basic',
    ashost: 'ASHOST-SENTINEL',
    sysnr: '00',
    client: '100',
    language: 'EN',
  };

  it('a request whose call failed: the error, and every line the connection logged', async () => {
    const { logger, lines } = recordingLogger();
    // The first conversation is the stateful one; a stateless GET goes on the
    // second, whose call fails.
    const { factory } = standInFactory([[], [fails(sdkFailure())]], true);
    const transport = new RfcTransport(factory, logger);
    const conn = new AdtOnPremConnector(
      config,
      stubProvider(),
      transport,
      logger,
    );
    await conn.connect();

    const error = await rejection(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/discovery',
        method: 'GET',
        timeout: 30000,
      }),
    );

    assert.strictEqual(error.message, `${FAILED}RFC_COMMUNICATION_FAILURE`);
    assert.deepStrictEqual(rfcOf(error), FIELDS);
    assertNoSdkText(error, 'the error');
    assertLogClean(lines);
    await conn.disconnect();
  });

  it('a request that ended the session: the SESSION_REPLACED verdict keeps rfc, no text', async () => {
    const { logger, lines } = recordingLogger();
    const { factory } = standInFactory([[dies(sdkFailure())]], true);
    const transport = new RfcTransport(factory, logger);
    const conn = new AdtOnPremConnector(
      config,
      stubProvider(),
      transport,
      logger,
    );
    await conn.connect();
    conn.setSessionType('stateful');

    const error = await rejection(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/oo/classes/zcl_x?_action=LOCK',
        method: 'POST',
        timeout: 30000,
      }),
    );

    assert.deepStrictEqual(rfcOf(error), FIELDS);
    assertNoSdkText(error, 'the error');
    assertLogClean(lines);
  });
});

describe('a log line about a close or a reset carries no SDK text', () => {
  it('a close that fails', async () => {
    const { logger, lines } = recordingLogger();
    const transport = new RfcTransport(
      () => ({
        alive: true,
        open: async () => {},
        close: async () => {
          throw sdkFailure();
        },
        call: async () => ({}),
      }),
      logger,
    );
    await transport.open();
    await transport.close();

    assert.ok(
      lines.some((line) =>
        String(line[0]).startsWith(
          'RFC close error: RFC_COMMUNICATION_FAILURE',
        ),
      ),
      inspect(lines),
    );
    assertLogClean(lines);
  });

  it('a reset that fails', async () => {
    const { logger, lines } = recordingLogger();
    const transport = new RfcTransport(
      () => ({
        alive: true,
        open: async () => {},
        close: async () => {},
        resetServerContext: async () => {
          throw shapeless();
        },
        call: async () => ({
          RESPONSE: {
            STATUS_LINE: { STATUS_CODE: 200, REASON_PHRASE: 'OK' },
            HEADER_FIELDS: [],
            MESSAGE_BODY: Buffer.from('<ok/>', 'utf-8'),
          },
        }),
      }),
      logger,
    );
    await transport.open();
    await transport.send({ method: 'GET', url: '/x' });

    assert.ok(
      lines.some((line) =>
        String(line[0]).startsWith(
          'RFC reset failed, dropping the conversation: the SDK did not name the failure',
        ),
      ),
      inspect(lines),
    );
    assertLogClean(lines);
  });
});

describe('a refused logon says it in fixed words, its cause the SDK’s own', () => {
  for (const [what, raw] of [
    ['the SDK’s error object', sdkFailure()],
    [
      'an Error holding the SDK’s text',
      Object.assign(new Error(SDK_TEXT), FIELDS),
    ],
  ] as const) {
    it(`WireLogonError carries no SDK text in its message; the provider still gets the raw error (${what})`, async () => {
      const transport = new RfcTransport(
        () => ({
          alive: false,
          open: async () => {
            throw raw;
          },
          close: async () => {},
          call: async () => ({}),
        }),
        null,
      );

      const error = await rejection(transport.open());

      assert.ok(error instanceof WireLogonError);
      assert.strictEqual(error.cause, raw);
      for (const form of [error.message, String(error), String(error.stack)]) {
        for (const leak of LEAKS) {
          assert.ok(!form.includes(leak), `${JSON.stringify(leak)} in ${form}`);
        }
      }
    });
  }
});

describe('a conversation the factory could not build is said in fixed words', () => {
  for (const [what, thrown, words, rfc] of [
    [
      'the SDK’s error object',
      sdkFailure(),
      'The RFC conversation could not be built: RFC_COMMUNICATION_FAILURE',
      FIELDS,
    ],
    [
      'a TypeError holding the SDK’s text',
      new TypeError(SDK_TEXT),
      'The RFC conversation could not be built: the SDK did not name the failure',
      undefined,
    ],
  ] as const) {
    it(`the factory’s throw is not quoted (${what})`, async () => {
      const transport = new RfcTransport(() => {
        throw thrown;
      }, null);

      const error = await rejection(transport.open());

      assert.strictEqual(error.message, words);
      assert.deepStrictEqual(rfcOf(error), rfc);
      assert.ok(
        !(error instanceof WireLogonError),
        'nothing was sent: no logon',
      );
      assertNoSdkText(error, 'the error');
    });
  }

  it('the SDK’s client constructor, through rfcConversationFrom', async () => {
    const config: ISapRfcConfig = {
      connectionType: 'rfc',
      authType: 'basic',
      ashost: 'ASHOST-SENTINEL',
      sysnr: '00',
      client: '100',
      language: 'EN',
    };
    const factory = rfcConversationFrom(config);
    const transport = new RfcTransport(factory, null);
    let error: Error | undefined;
    await withModuleAsync(
      '@mcp-abap-adt/sap-rfc-lite',
      {
        Client: class {
          constructor() {
            throw new Error(SDK_TEXT);
          }
        },
      },
      async () => {
        error = await rejection(transport.open());
      },
    );

    assert.ok(error);
    assert.strictEqual(
      error.message,
      'The RFC conversation could not be built: the SDK did not name the failure',
    );
    assertNoSdkText(error, 'the error');
  });
});

describe('a missing SDK reaches the caller of open() in its own words', () => {
  it('the install guidance is kept, the loader’s text is not quoted', async () => {
    const config: ISapRfcConfig = {
      connectionType: 'rfc',
      authType: 'basic',
      ashost: 'ASHOST-SENTINEL',
      sysnr: '00',
      client: '100',
      language: 'EN',
    };
    const transport = new RfcTransport(rfcConversationFrom(config), null);
    let error: Error | undefined;
    await withModuleAsync(
      '@mcp-abap-adt/sap-rfc-lite',
      {
        get Client(): never {
          throw new Error(SDK_TEXT);
        },
      },
      async () => {
        error = await rejection(transport.open());
      },
    );

    assert.ok(error);
    assert.strictEqual(
      error.message,
      '@mcp-abap-adt/sap-rfc-lite is not available. To take the RFC wire, install the SAP NW RFC SDK and run: npm install @mcp-abap-adt/sap-rfc-lite.',
    );
    assertNoSdkText(error, 'the error');
  });
});

describe('a missing SDK is said without the loader’s text', () => {
  it('the require failure’s words are not quoted', () => {
    const config: ISapRfcConfig = {
      connectionType: 'rfc',
      authType: 'basic',
      ashost: 'ASHOST-SENTINEL',
      sysnr: '00',
      client: '100',
      language: 'EN',
    };
    let thrown: unknown;
    withModule(
      '@mcp-abap-adt/sap-rfc-lite',
      {
        get Client(): never {
          throw new Error(SDK_TEXT);
        },
      },
      () => {
        try {
          rfcConversationFrom(config)({});
        } catch (error) {
          thrown = error;
        }
      },
    );

    assert.ok(thrown instanceof Error);
    assert.ok(
      thrown.message.startsWith('@mcp-abap-adt/sap-rfc-lite is not available'),
    );
    assertNoSdkText(thrown, 'the error');
  });
});
