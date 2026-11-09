/**
 * Over RFC, a request's `sap-language` is the language it runs in — the same
 * as over HTTP.
 *
 * Over HTTP the ICF layer reads `sap-language` (a header or a query
 * parameter) and runs the request in it. `SADT_REST_RFC_ENDPOINT` has no ICF
 * logon: it runs every request in the conversation's logon language and
 * ignores the header, the query parameter and the body attribute alike.
 * Measured on S/4HANA 2025, 2026-11-09: a class created over RFC with
 * `sap-language: RU` on an EN logon got master language EN.
 *
 * So the wire carries such a request on a conversation logged on in that
 * language: a non-stateful one on a conversation of its own, opened for the
 * call and closed after it; a stateful one is refused, because a session
 * cannot change its language.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ISapRfcApplicationServer } from '@mcp-abap-adt/interfaces-auth-sap';
import type {
  IAdtSessionContext,
  IAdtTransportRequest,
  IAdtTransportResponse,
} from '../connection/IAdtTransport.js';
import {
  type IRfcConversation,
  RfcTransport,
} from '../connection/RfcTransport.js';
import { rfcConversationFrom } from '../connection/rfcConversation.js';
import type { ILogger } from '../logger.js';
import { withModuleAsync } from './helpers/moduleCache.js';

const ok = {
  RESPONSE: {
    STATUS_LINE: { STATUS_CODE: 200, REASON_PHRASE: 'OK' },
    HEADER_FIELDS: [],
    MESSAGE_BODY: Buffer.from('<ok/>', 'utf-8'),
  },
};

/** One conversation the fake factory opened, and what was done with it. */
class FakeConversation implements IRfcConversation {
  alive = false;
  opens = 0;
  closes = 0;
  readonly calls: Record<string, unknown>[] = [];
  resets = 0;

  constructor(
    readonly logon: Readonly<Record<string, string>>,
    private readonly failCall: boolean,
    canReset = true,
  ) {
    if (canReset) {
      this.resetServerContext = async () => {
        this.resets += 1;
      };
    }
  }

  async open(): Promise<void> {
    this.opens += 1;
    this.alive = true;
  }

  async close(): Promise<void> {
    this.closes += 1;
    this.alive = false;
  }

  async call(
    _fm: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.calls.push(params);
    if (this.failCall) throw new Error('RFC_COMMUNICATION_FAILURE');
    return ok;
  }

  /** Absent on a client that cannot reset: every non-stateful call then opens its own. */
  readonly resetServerContext?: () => Promise<void>;
}

/**
 * A wire whose factory logs on in `language`, as `rfcConversationFrom` states
 * it, and records every conversation it opens. The first is the stateful one
 * `open()` makes.
 */
function wire(
  options: {
    language?: string;
    failCallsAfter?: number;
    /** What the provider writes at every logon, as `context.logon()` would. */
    providerWrites?: Readonly<Record<string, string>>;
    logger?: ILogger;
    canReset?: boolean;
  } = {},
): {
  opened: FakeConversation[];
  transport: RfcTransport;
  context: IAdtSessionContext | undefined;
} {
  const opened: FakeConversation[] = [];
  const open = (logon: Readonly<Record<string, string>>) => {
    const failCall =
      options.failCallsAfter !== undefined &&
      opened.length >= options.failCallsAfter;
    const conversation = new FakeConversation(
      logon,
      failCall,
      options.canReset ?? true,
    );
    opened.push(conversation);
    return conversation;
  };
  const factory =
    options.language === undefined
      ? open
      : Object.assign(open, { language: options.language });
  const writes = options.providerWrites;
  const context: IAdtSessionContext | undefined =
    writes === undefined
      ? undefined
      : {
          authorize: async () => {},
          logon: async (target) => {
            target.logonParameters(writes);
          },
          observe: () => {},
        };
  return {
    opened,
    context,
    transport: new RfcTransport(factory, options.logger ?? null),
  };
}

/** A logger whose `debug` throws on the lines that start with `prefix`. */
function throwingOn(prefix: string): ILogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: (message) => {
      if (message.startsWith(prefix)) throw new Error('logger broke');
    },
  };
}

/** The header fields a conversation's one call carried. */
function sentHeaders(
  conversation: FakeConversation | undefined,
): { NAME: string; VALUE: string }[] {
  const request = conversation?.calls[0]?.REQUEST;
  if (typeof request !== 'object' || request === null) return [];
  const fields = Reflect.get(request, 'HEADER_FIELDS');
  return Array.isArray(fields) ? fields : [];
}

async function refusal(
  sending: Promise<IAdtTransportResponse>,
): Promise<string> {
  try {
    await sending;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  assert.fail('the request was carried; it should have been refused');
}

const put = (extra: Partial<IAdtTransportRequest>): IAdtTransportRequest => ({
  method: 'POST',
  url: '/sap/bc/adt/oo/classes',
  data: '<class:abapClass/>',
  ...extra,
});

describe('RFC: a non-stateful request in another sap-language', () => {
  it('goes on a conversation of its own, logged on in that language, closed after the call', async () => {
    const { opened, transport } = wire({ language: 'EN' });
    await transport.open();

    await transport.send(put({ headers: { 'sap-language': 'RU' } }));

    assert.strictEqual(opened.length, 2);
    const own = opened[1];
    assert.ok(own);
    assert.strictEqual(own.logon.lang, 'RU');
    assert.strictEqual(own.calls.length, 1);
    assert.strictEqual(own.closes, 1);
    assert.strictEqual(own.resets, 0);
    // the stateful conversation carried nothing
    assert.strictEqual(opened[0]?.calls.length, 0);
  });

  it('closes that conversation when the call fails', async () => {
    const { opened, transport } = wire({ language: 'EN', failCallsAfter: 1 });
    await transport.open();

    const message = await refusal(
      transport.send(put({ headers: { 'sap-language': 'RU' } })),
    );

    assert.match(message, /SADT_REST_RFC_ENDPOINT failed/);
    const own = opened[1];
    assert.strictEqual(own?.logon.lang, 'RU');
    assert.strictEqual(own?.calls.length, 1);
    assert.strictEqual(own?.closes, 1);
  });

  it('keeps nothing: each such call opens and closes a conversation of its own', async () => {
    const { opened, transport } = wire({ language: 'EN' });
    await transport.open();

    await transport.send(put({ headers: { 'sap-language': 'RU' } }));
    await transport.send(put({ headers: { 'sap-language': 'RU' } }));

    assert.strictEqual(opened.length, 3);
    assert.deepStrictEqual(
      opened.slice(1).map((c) => [c.logon.lang, c.calls.length, c.closes]),
      [
        ['RU', 1, 1],
        ['RU', 1, 1],
      ],
    );
  });

  it('reads the sap-language query parameter in params', async () => {
    const { opened, transport } = wire({ language: 'EN' });
    await transport.open();

    await transport.send(put({ params: { 'sap-language': 'RU' } }));

    assert.strictEqual(opened[1]?.logon.lang, 'RU');
    assert.strictEqual(opened[1]?.closes, 1);
  });

  it('reads the sap-language query parameter in the URL', async () => {
    const { opened, transport } = wire({ language: 'EN' });
    await transport.open();

    await transport.send(
      put({ url: '/sap/bc/adt/oo/classes?corrNr=X&sap-language=RU' }),
    );

    assert.strictEqual(opened[1]?.logon.lang, 'RU');
    assert.strictEqual(opened[1]?.closes, 1);
  });

  it('reads the header name in any case', async () => {
    const { opened, transport } = wire({ language: 'EN' });
    await transport.open();

    await transport.send(put({ headers: { 'SAP-Language': 'RU' } }));

    assert.strictEqual(opened[1]?.logon.lang, 'RU');
  });

  it('logs on in the language as the request names it, and still sends the header', async () => {
    const { opened, transport } = wire({ language: 'EN' });
    await transport.open();

    await transport.send(put({ headers: { 'sap-language': 'ru' } }));

    assert.strictEqual(opened[1]?.logon.lang, 'ru');
    assert.ok(
      sentHeaders(opened[1]).some(
        (h) => h.NAME === 'sap-language' && h.VALUE === 'ru',
      ),
    );
  });

  it('logs on in the language asked when the wire does not state its own', async () => {
    const { opened, transport } = wire();
    await transport.open();

    await transport.send(put({ headers: { 'sap-language': 'EN' } }));

    assert.strictEqual(opened[1]?.logon.lang, 'EN');
    assert.strictEqual(opened[1]?.closes, 1);
  });

  it('is refused, with nothing sent, when the request names two languages', async () => {
    const { opened, transport } = wire({ language: 'EN' });
    await transport.open();

    const message = await refusal(
      transport.send(
        put({
          headers: { 'sap-language': 'RU' },
          params: { 'sap-language': 'DE' },
        }),
      ),
    );

    assert.match(message, /RU/);
    assert.match(message, /DE/);
    assert.strictEqual(opened.length, 1);
    assert.strictEqual(opened[0]?.calls.length, 0);
  });
});

describe('RFC: a non-stateful request in the logon language, or naming none', () => {
  it('takes the kept conversation, as without sap-language', async () => {
    const { opened, transport } = wire({ language: 'EN' });
    await transport.open();

    await transport.send(put({ headers: { 'sap-language': 'EN' } }));
    await transport.send(put({}));

    assert.strictEqual(opened.length, 2);
    assert.strictEqual(opened[1]?.logon.lang, undefined);
    assert.strictEqual(opened[1]?.calls.length, 2);
    assert.strictEqual(opened[1]?.resets, 2);
    assert.strictEqual(opened[1]?.closes, 0);
  });

  it('compares the language without case', async () => {
    const { opened, transport } = wire({ language: 'EN' });
    await transport.open();

    await transport.send(put({ headers: { 'sap-language': 'en' } }));
    await transport.send(put({ params: { 'sap-language': 'En' } }));
    await transport.send(
      put({ url: '/sap/bc/adt/oo/classes?sap-language=eN' }),
    );

    assert.strictEqual(opened.length, 2);
    assert.strictEqual(opened[1]?.calls.length, 3);
  });

  it('reads the same language named twice as one', async () => {
    const { opened, transport } = wire({ language: 'EN' });
    await transport.open();

    await transport.send(
      put({
        headers: { 'sap-language': 'RU' },
        params: { 'sap-language': 'ru' },
      }),
    );

    assert.strictEqual(opened[1]?.logon.lang, 'RU');
  });
});

describe('RFC: a stateful request in another sap-language', () => {
  it('is refused, with nothing sent, naming both languages and why', async () => {
    const { opened, transport } = wire({ language: 'EN' });
    await transport.open();

    const message = await refusal(
      transport.send(
        put({ stateful: true, headers: { 'sap-language': 'RU' } }),
      ),
    );

    assert.match(message, /sap-language RU/);
    assert.match(message, /logged on in EN/);
    assert.match(message, /cannot change its language/);
    assert.strictEqual(opened.length, 1);
    assert.strictEqual(opened[0]?.calls.length, 0);
  });

  it('is refused for the query-parameter form too', async () => {
    const { opened, transport } = wire({ language: 'EN' });
    await transport.open();

    const message = await refusal(
      transport.send(
        put({ stateful: true, url: '/sap/bc/adt/oo/classes?sap-language=RU' }),
      ),
    );

    assert.match(message, /sap-language RU/);
    assert.strictEqual(opened[0]?.calls.length, 0);
  });

  it('is refused when the wire does not state its logon language', async () => {
    const { opened, transport } = wire();
    await transport.open();

    const message = await refusal(
      transport.send(
        put({ stateful: true, headers: { 'sap-language': 'EN' } }),
      ),
    );

    assert.match(message, /sap-language EN/);
    assert.strictEqual(opened[0]?.calls.length, 0);
  });

  it('in the logon language, in any case, goes on the stateful conversation', async () => {
    const { opened, transport } = wire({ language: 'EN' });
    await transport.open();

    await transport.send(
      put({ stateful: true, headers: { 'sap-language': 'en' } }),
    );
    await transport.send(put({ stateful: true }));

    assert.strictEqual(opened.length, 1);
    assert.strictEqual(opened[0]?.calls.length, 2);
  });
});

describe('RFC: the logon language from the config', () => {
  const config: ISapRfcApplicationServer = {
    connectionType: 'rfc',
    authType: 'basic',
    ashost: 'saphost',
    sysnr: '00',
    client: '100',
    language: 'EN',
  };

  it('is what rfcConversationFrom states, and what a request in another language is told apart from', async () => {
    assert.strictEqual(rfcConversationFrom(config).language, 'EN');

    const constructed: Record<string, unknown>[] = [];
    await withModuleAsync(
      '@mcp-abap-adt/sap-rfc-lite',
      {
        Client: class extends FakeConversation {
          constructor(params: Record<string, string>) {
            super(params, false);
            constructed.push({ ...params });
          }
        },
      },
      async () => {
        const transport = new RfcTransport(rfcConversationFrom(config), null);
        await transport.open();
        await transport.send(put({ headers: { 'sap-language': 'en' } }));
        await transport.send(put({ headers: { 'sap-language': 'RU' } }));
        await transport.close();
      },
    );

    assert.deepStrictEqual(
      constructed.map((params) => params.lang),
      ['EN', 'EN', 'RU'],
    );
  });
});

describe('RFC: the effective logon language, a provider’s lang included', () => {
  // The provider's logon parameters are spread over the config's address, and
  // win a shared key: a provider that writes `lang` logs every conversation on
  // in it, whatever the factory states.
  const french = { language: 'EN', providerWrites: { lang: 'FR' } };

  it('refuses a stateful request in the factory’s language when the session logged on in the provider’s', async () => {
    const { opened, transport, context } = wire(french);
    await transport.open(context);
    assert.strictEqual(opened[0]?.logon.lang, 'FR');

    const message = await refusal(
      transport.send(
        put({ stateful: true, headers: { 'sap-language': 'EN' } }),
      ),
    );

    assert.match(message, /sap-language EN/);
    assert.match(message, /logged on in FR/);
    assert.strictEqual(opened[0]?.calls.length, 0);
  });

  it('carries a stateful request in the provider’s language on the stateful conversation', async () => {
    const { opened, transport, context } = wire(french);
    await transport.open(context);

    await transport.send(
      put({ stateful: true, headers: { 'sap-language': 'fr' } }),
    );

    assert.strictEqual(opened.length, 1);
    assert.strictEqual(opened[0]?.calls.length, 1);
  });

  it('carries a non-stateful request in the factory’s language on a conversation logged on in it', async () => {
    const { opened, transport, context } = wire(french);
    await transport.open(context);

    await transport.send(put({ headers: { 'sap-language': 'EN' } }));

    assert.strictEqual(opened[1]?.logon.lang, 'EN');
    assert.strictEqual(opened[1]?.closes, 1);
  });

  it('carries a non-stateful request in the provider’s language on the kept conversation', async () => {
    const { opened, transport, context } = wire(french);
    await transport.open(context);

    await transport.send(put({ headers: { 'sap-language': 'FR' } }));

    assert.strictEqual(opened.length, 2);
    assert.strictEqual(opened[1]?.logon.lang, 'FR');
    assert.strictEqual(opened[1]?.resets, 1);
    assert.strictEqual(opened[1]?.closes, 0);
  });

  it('logs the conversation for another language on in the requested lang, over the provider’s', async () => {
    const { opened, transport, context } = wire(french);
    await transport.open(context);

    await transport.send(put({ headers: { 'sap-language': 'RU' } }));

    assert.strictEqual(opened[1]?.logon.lang, 'RU');
    assert.strictEqual(opened[1]?.closes, 1);
  });
});

describe('RFC: a conversation opened for one call is closed even when the logger throws', () => {
  it('in another language', async () => {
    const { opened, transport } = wire({
      language: 'EN',
      logger: throwingOn('RFC conversation opened for one'),
    });
    await transport.open();

    await refusal(transport.send(put({ headers: { 'sap-language': 'RU' } })));

    assert.strictEqual(opened[1]?.logon.lang, 'RU');
    assert.strictEqual(opened[1]?.closes, 1);
  });

  it('on a client that cannot reset', async () => {
    const { opened, transport } = wire({
      language: 'EN',
      canReset: false,
      logger: throwingOn('RFC conversation opened for one'),
    });
    await transport.open();
    // the first call finds the client cannot reset; the second opens its own
    await transport.send(put({}));

    await refusal(transport.send(put({})));

    assert.strictEqual(opened.length, 3);
    assert.strictEqual(opened[2]?.closes, 1);
  });
});
