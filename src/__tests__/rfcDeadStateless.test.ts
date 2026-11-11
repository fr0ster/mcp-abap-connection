/**
 * A non-stateful conversation that an RFC error ended.
 *
 * Such a conversation carries no session of the instance — the kept one is
 * reset after every call, a throwaway closed — so it is replaced as a reset
 * replaces it: dropped, never reset or closed (sap-rfc-lite already released
 * it, and both would reject), and the next call opens another. The call's
 * error still carries its `rfc` fields, and the instance is not spent.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BasicAuthProvider } from '@mcp-abap-adt/auth-providers';
import type { ISapRfcConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import { RfcTransport } from '../connection/RfcTransport.js';
import {
  abapExceptionError,
  dies,
  fails,
  RFC_CLOSED_FIELDS,
  type RfcStandIn,
  standInFactory,
} from './helpers/rfcStandIn.js';

const request = { method: 'GET', url: '/sap/bc/adt/discovery' };

async function rejection(sending: Promise<unknown>): Promise<Error> {
  try {
    await sending;
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail('the request was expected to fail');
}

function rfcOf(error: Error): unknown {
  return Object.getOwnPropertyDescriptor(error, 'rfc')?.value;
}

function nth(made: RfcStandIn[], index: number): RfcStandIn {
  const conversation = made[index];
  assert.ok(conversation, `conversation ${index} was opened`);
  return conversation;
}

describe('a dead kept stateless conversation', () => {
  it('is dropped without a reset or a close; the error carries rfc; the next call opens another', async () => {
    // 0: the stateful one; 1: the kept one, whose first call dies.
    const { factory, made } = standInFactory([[], [dies()]], true);
    const transport = new RfcTransport(factory);
    await transport.open();

    const error = await rejection(transport.send(request));

    assert.deepStrictEqual(rfcOf(error), RFC_CLOSED_FIELDS);
    const dead = nth(made, 1);
    assert.strictEqual(dead.resets, 0, 'no reset of a released conversation');
    assert.strictEqual(dead.closes, 0, 'no close of a released conversation');

    const response = await transport.send(request);

    assert.strictEqual(response.status, 200);
    assert.strictEqual(made.length, 3, 'a new kept conversation was opened');
    assert.strictEqual(nth(made, 2).calls, 1);
    assert.strictEqual(dead.calls, 1, 'nothing more was sent on the dead one');
    // The stateful conversation is untouched.
    assert.strictEqual(nth(made, 0).alive, true);
    assert.strictEqual(nth(made, 0).closes, 0);
  });

  it('is no longer the wire’s: close() does not close it', async () => {
    const { factory, made } = standInFactory([[], [dies()]], true);
    const transport = new RfcTransport(factory);
    await transport.open();
    await rejection(transport.send(request));

    await transport.close();

    assert.strictEqual(nth(made, 1).closes, 0);
    assert.strictEqual(nth(made, 0).closes, 1);
  });

  it('one that failed and lives on is reset and kept, as before', async () => {
    const { factory, made } = standInFactory(
      [[], [fails(abapExceptionError())]],
      true,
    );
    const transport = new RfcTransport(factory);
    await transport.open();

    await rejection(transport.send(request));
    await transport.send(request);

    const kept = nth(made, 1);
    assert.strictEqual(kept.resets, 2);
    assert.strictEqual(kept.closes, 0);
    assert.strictEqual(kept.calls, 2);
    assert.strictEqual(made.length, 2);
  });
});

describe('a dead throwaway conversation', () => {
  it('is not closed, on either path that opens one; the error carries rfc', async () => {
    // A client without reset: the first non-stateful call is the probe that
    // learns so, every later one opens a conversation of its own.
    const { factory, made } = standInFactory([[], [dies()], [dies()]], false);
    const transport = new RfcTransport(factory);
    await transport.open();

    const first = await rejection(transport.send(request));
    const second = await rejection(transport.send(request));

    assert.deepStrictEqual(rfcOf(first), RFC_CLOSED_FIELDS);
    assert.deepStrictEqual(rfcOf(second), RFC_CLOSED_FIELDS);
    assert.strictEqual(nth(made, 1).closes, 0);
    assert.strictEqual(nth(made, 2).closes, 0);
  });

  it('one that failed and lives on is closed, as before', async () => {
    const { factory, made } = standInFactory(
      [[], [fails(abapExceptionError())], [fails(abapExceptionError())]],
      false,
    );
    const transport = new RfcTransport(factory);
    await transport.open();

    await rejection(transport.send(request));
    await rejection(transport.send(request));

    assert.strictEqual(nth(made, 1).closes, 1);
    assert.strictEqual(nth(made, 2).closes, 1);
  });
});

describe('through a connector', () => {
  const config: ISapRfcConfig = {
    connectionType: 'rfc',
    authType: 'basic',
    ashost: 'saphost',
    sysnr: '00',
    client: '100',
    language: 'EN',
  };

  it('a dead stateless conversation does not spend the instance', async () => {
    const { factory, made } = standInFactory([[], [dies()]], true);
    const conn = new AdtOnPremConnector(
      config,
      new BasicAuthProvider('USER', 'PASS'),
      new RfcTransport(factory),
      null,
    );
    await conn.connect();
    try {
      const error = await rejection(
        conn.makeAdtRequest({ ...request, timeout: 30000 }),
      );
      assert.deepStrictEqual(rfcOf(error), RFC_CLOSED_FIELDS);
      assert.strictEqual(Object.hasOwn(error, 'code'), false);

      const response = await conn.makeAdtRequest({
        ...request,
        timeout: 30000,
      });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(conn.isConnected(), true);
      assert.strictEqual(nth(made, 0).alive, true);
    } finally {
      await conn.disconnect();
    }
  });
});
