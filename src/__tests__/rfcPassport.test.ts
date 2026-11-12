/**
 * A request's `SAP-PASSPORT` header becomes the RFC call's own passport.
 *
 * `SADT_REST_RFC_ENDPOINT` does not read a passport from a header field, so
 * over RFC the header is taken off the request, hex-decoded, and handed to the
 * SDK for that one call. A value that is not a passport in hex is refused before
 * anything is sent, naming the header and never quoting its value; a request
 * without the header carries no passport, exactly as before.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type IRfcConversation,
  RfcTransport,
} from '../connection/RfcTransport.js';
import type { ILogger } from '../logger.js';

type CallArguments = [
  fm: string,
  params: Record<string, unknown>,
  options?: { passport?: Buffer | undefined },
];

const answer = {
  RESPONSE: {
    STATUS_LINE: { STATUS_CODE: 200, REASON_PHRASE: 'OK' },
    HEADER_FIELDS: [],
    MESSAGE_BODY: Buffer.from('<ok/>', 'utf-8'),
  },
};

/** A passport's hex, as the ADT client writes it (structure is the SDK's to check). */
const PASSPORT_HEX = '2A54482A0300E60000534150';

type Route = 'stateful' | 'kept' | 'throwaway';

function setup(route: Route = 'stateful') {
  const calls: CallArguments[] = [];
  const lines: string[] = [];
  let opened = 0;
  const logger: ILogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: (line: string) => {
      lines.push(line);
    },
  };
  const transport = new RfcTransport(
    () => {
      opened += 1;
      const conversation: IRfcConversation = {
        alive: true,
        open: async () => {},
        close: async () => {},
        call: async (...args: CallArguments) => {
          calls.push(args);
          return answer;
        },
      };
      if (route === 'throwaway') return conversation;
      return { ...conversation, resetServerContext: async () => {} };
    },
    logger,
    { logWire: true },
  );
  return {
    transport,
    calls,
    lines,
    opened: () => opened,
    send: (headers: Record<string, string>) =>
      transport.send({
        method: 'GET',
        url: '/sap/bc/adt/discovery',
        headers,
        stateful: route === 'stateful',
      }),
  };
}

const NOT_HEX =
  'The SAP-PASSPORT header is not a passport in hex; nothing was sent.';
const TWICE =
  'The request names SAP-PASSPORT more than once; nothing was sent.';

describe('the SAP-PASSPORT header over RFC', () => {
  for (const name of ['SAP-PASSPORT', 'sap-passport', 'Sap-Passport']) {
    it(`${name}: the decoded passport goes to the call, not as a header field`, async () => {
      const { transport, calls, lines, send } = setup();
      await transport.open();

      await send({ [name]: PASSPORT_HEX, Accept: 'application/xml' });

      assert.strictEqual(calls.length, 1);
      const [, params, options] = calls[0] ?? [];
      assert.deepStrictEqual(options, {
        passport: Buffer.from(PASSPORT_HEX, 'hex'),
      });
      assert.ok(
        !JSON.stringify(params).toLowerCase().includes('sap-passport'),
        'no HEADER_FIELDS entry names the passport',
      );
      const headersLine = lines.find((line) => line.startsWith('RFC HEADERS:'));
      assert.notStrictEqual(headersLine, undefined);
      assert.ok(!headersLine?.toLowerCase().includes('sap-passport'));
      assert.ok(!headersLine?.includes(PASSPORT_HEX));
      // The rest of the request is still carried.
      assert.ok(JSON.stringify(params).includes('application/xml'));
    });
  }

  it('a lower-case hex value is decoded the same', async () => {
    const { transport, calls, send } = setup();
    await transport.open();

    await send({ 'SAP-PASSPORT': PASSPORT_HEX.toLowerCase() });

    assert.deepStrictEqual(calls[0]?.[2], {
      passport: Buffer.from(PASSPORT_HEX, 'hex'),
    });
  });

  it('no header: the call gets exactly two arguments, as before', async () => {
    const { transport, calls, send } = setup();
    await transport.open();

    await send({ Accept: 'application/xml' });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]?.length, 2);
  });

  it('a request without the header after one with it carries no passport', async () => {
    const { transport, calls, send } = setup();
    await transport.open();

    await send({ 'SAP-PASSPORT': PASSPORT_HEX });
    await send({});

    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0]?.length, 3);
    assert.strictEqual(calls[1]?.length, 2);
  });

  for (const route of ['stateful', 'kept', 'throwaway'] as const) {
    it(`is carried on the ${route} conversation`, async () => {
      const { transport, calls, send } = setup(route);
      await transport.open();

      await send({ 'SAP-PASSPORT': PASSPORT_HEX });

      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0]?.[2], {
        passport: Buffer.from(PASSPORT_HEX, 'hex'),
      });
    });
  }
});

describe('a SAP-PASSPORT value that is not a passport in hex is refused', () => {
  const refused: ReadonlyArray<readonly [string, string]> = [
    ['empty', ''],
    ['odd length', '2A54482A0'],
    ['a non-hex character first', 'Z054482A'],
    ['a non-hex character in the middle', '2A54Q82A'],
    ['a non-hex character last', '2A54482Z'],
    ['a space', '2A54 82A'],
    ['a sign', '+A54482A'],
  ];
  for (const route of ['stateful', 'kept', 'throwaway'] as const) {
    for (const [title, value] of refused) {
      it(`${title} (${route}): nothing sent, the header named, the value not quoted`, async () => {
        const { transport, calls, opened, send } = setup(route);
        await transport.open();
        const openedBefore = opened();

        await assert.rejects(send({ 'SAP-PASSPORT': value }), (error) => {
          assert.ok(error instanceof Error);
          assert.strictEqual(error.message, NOT_HEX);
          if (value !== '') assert.ok(!error.message.includes(value));
          assert.strictEqual(Object.hasOwn(error, 'rfc'), false);
          return true;
        });
        assert.strictEqual(calls.length, 0);
        assert.strictEqual(opened(), openedBefore, 'no conversation opened');
      });
    }
  }

  const twice: ReadonlyArray<readonly [string, Record<string, string>]> = [
    [
      'different values',
      { 'SAP-PASSPORT': PASSPORT_HEX, 'sap-passport': '2A54482A' },
    ],
    [
      'equal values',
      { 'SAP-PASSPORT': PASSPORT_HEX, 'sap-passport': PASSPORT_HEX },
    ],
    [
      'the second one empty',
      { 'SAP-PASSPORT': PASSPORT_HEX, 'Sap-Passport': '' },
    ],
  ];
  for (const [title, headers] of twice) {
    it(`named twice, ${title}: refused, nothing sent`, async () => {
      const { transport, calls, send } = setup();
      await transport.open();

      await assert.rejects(send(headers), (error) => {
        assert.ok(error instanceof Error);
        assert.strictEqual(error.message, TWICE);
        return true;
      });
      assert.strictEqual(calls.length, 0);
    });
  }
});
