/**
 * A failed RFC call reaches the caller with the SDK's error as fields — `rfc`:
 * `{ key, group, code, codeString }` — so a consumer reads which failure it was
 * from a field, never from words.
 *
 * The SDK's error comes from outside the type system: it is checked once, where
 * the wire receives it. Only own data properties count, no getter runs, a
 * hostile object reads as no shape, and the return code must be one of the
 * closed list `RFC_RCS`. Everything else goes in fixed words, no rfc and no
 * text of the thrown value's.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type IRfcConversation,
  RfcTransport,
} from '../connection/RfcTransport.js';

const FAILED = 'RFC call to SADT_REST_RFC_ENDPOINT failed: ';

/** What sap-rfc-lite rejects with when the other side closed the conversation. */
function rfcLibError(): Record<string, unknown> {
  return {
    name: 'RfcLibError',
    group: 4,
    code: 6,
    codeString: 'RFC_CLOSED',
    key: 'RFC_CLOSED',
    message: 'Connection closed by the partner',
  };
}

/** What sap-rfc-lite rejects with for an ABAP exception: more fields, the same four. */
function abapError(): Record<string, unknown> {
  return {
    name: 'ABAPError',
    group: 5,
    code: 5,
    codeString: 'RFC_ABAP_EXCEPTION',
    key: 'NOT_FOUND',
    message: 'NOT_FOUND',
    abapMsgClass: 'SADT_REST',
    abapMsgType: 'E',
    abapMsgNumber: '001',
    abapMsgV1: 'v1',
    abapMsgV2: '',
    abapMsgV3: '',
    abapMsgV4: '',
  };
}

/** A conversation whose every call rejects with `rejection`, alive afterwards. */
function rejecting(rejection: unknown): IRfcConversation {
  return {
    alive: true,
    open: async () => {},
    close: async () => {},
    resetServerContext: async () => {},
    call: async () => {
      throw rejection;
    },
  };
}

type Route = 'stateful' | 'kept' | 'throwaway';

/** The error the caller receives for one request on `route`. */
async function failureOf(
  rejection: unknown,
  route: Route = 'stateful',
): Promise<Error> {
  const transport = new RfcTransport(() => {
    const conversation = rejecting(rejection);
    if (route !== 'throwaway') return conversation;
    // No reset: the wire opens a conversation of its own per call.
    const { resetServerContext: _reset, ...withoutReset } = conversation;
    return withoutReset;
  });
  await transport.open();
  try {
    await transport.send({
      method: 'GET',
      url: '/sap/bc/adt/discovery',
      stateful: route === 'stateful',
    });
  } catch (error) {
    assert.ok(error instanceof Error, 'an Error reaches the caller');
    return error;
  }
  assert.fail('the request was expected to fail');
}

function rfcOf(error: Error): unknown {
  return Object.getOwnPropertyDescriptor(error, 'rfc')?.value;
}

describe('a failed RFC call carries the SDK error as fields', () => {
  for (const route of ['stateful', 'kept', 'throwaway'] as const) {
    it(`an RfcLibError-shaped rejection gives rfc with its four fields (${route})`, async () => {
      const rejection = rfcLibError();
      const error = await failureOf(rejection, route);

      assert.deepStrictEqual(rfcOf(error), {
        key: 'RFC_CLOSED',
        group: 4,
        code: 6,
        codeString: 'RFC_CLOSED',
      });
      assert.ok(Object.isFrozen(rfcOf(error)));
      assert.strictEqual(error.message, `${FAILED}RFC_CLOSED`);
    });
  }

  it('an AbapError-shaped rejection gives the same four fields and no more', async () => {
    const error = await failureOf(abapError());

    assert.deepStrictEqual(rfcOf(error), {
      key: 'NOT_FOUND',
      group: 5,
      code: 5,
      codeString: 'RFC_ABAP_EXCEPTION',
    });
  });

  it('keeps the top-level code unset: rfc does not change what code means', async () => {
    const error = await failureOf(rfcLibError());

    assert.notStrictEqual(rfcOf(error), undefined);
    assert.strictEqual(Object.hasOwn(error, 'code'), false);
  });
});

describe('a rejection that is not the SDK error shape carries no rfc', () => {
  async function assertNoRfc(rejection: unknown): Promise<void> {
    const error = await failureOf(rejection);
    assert.strictEqual(Object.hasOwn(error, 'rfc'), false);
    assert.ok(error.message.startsWith(FAILED), error.message);
  }

  for (const field of ['key', 'group', 'code', 'codeString']) {
    it(`${field} missing`, async () => {
      const { [field]: _gone, ...rest } = rfcLibError();
      await assertNoRfc(rest);
    });
  }

  const wrongTypes: ReadonlyArray<readonly [string, unknown]> = [
    ['key', 42],
    ['group', '4'],
    ['group', 4.5],
    ['code', '6'],
    ['code', 6.5],
    ['code', Number.NaN],
    ['codeString', 6],
  ];
  for (const [field, value] of wrongTypes) {
    it(`${field} of the wrong type (${String(value)})`, async () => {
      await assertNoRfc({ ...rfcLibError(), [field]: value });
    });
  }

  for (const field of ['key', 'group', 'code', 'codeString']) {
    it(`${field} behind a getter, which is never run`, async () => {
      const { [field]: value, ...rest } = rfcLibError();
      let ran = false;
      const rejection: Record<string, unknown> = { ...rest };
      // Not enumerable, so nothing that serialises the object runs it either:
      // what is proven is that the check did not.
      Object.defineProperty(rejection, field, {
        enumerable: false,
        get: () => {
          ran = true;
          return value;
        },
      });
      await assertNoRfc(rejection);
      assert.strictEqual(ran, false);
    });
  }

  it('an inherited field does not count', async () => {
    const rejection: object = Object.create(rfcLibError());
    await assertNoRfc(rejection);
  });

  for (const field of ['key', 'group', 'code', 'codeString']) {
    it(`${field} inherited, the other three own and valid`, async () => {
      const { [field]: value, ...rest } = rfcLibError();
      const rejection: object = Object.assign(
        Object.create({ [field]: value }),
        rest,
      );
      await assertNoRfc(rejection);
    });
  }

  it('a Proxy whose traps throw reads as no shape, and the check throws nothing', async () => {
    const hostile = new Proxy(
      {},
      {
        // The trap the check meets. No `get` trap: what is proven here is the
        // check alone.
        getOwnPropertyDescriptor: () => {
          throw new Error('trap');
        },
      },
    );
    await assertNoRfc(hostile);
  });

  for (const codeString of ['RFC_NOT_A_CODE', '', 'rfc_closed']) {
    it(`a codeString outside RFC_RCS (${JSON.stringify(codeString)})`, async () => {
      await assertNoRfc({ ...rfcLibError(), codeString });
    });
  }

  it('the closed-connection error (nodeRfcError)', async () => {
    await assertNoRfc({
      name: 'nodeRfcError',
      message: 'RFM client request over closed connection',
    });
  });

  it('a TypeError', async () => {
    await assertNoRfc(new TypeError('passport refused'));
  });

  it('null and a string', async () => {
    await assertNoRfc(null);
    await assertNoRfc('RFC_CLOSED');
  });
});
