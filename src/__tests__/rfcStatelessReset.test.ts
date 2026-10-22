/**
 * Over RFC, with a client that can reset its context (sap-rfc-lite >= 0.2.0),
 * the non-stateful calls share one kept conversation, reset after each call —
 * a fresh ABAP context without a new logon (~0.1 s against ~0.5 s on E19).
 * Measured on E19, 2026-09-27: create, read after create, two
 * lock/PUT/unlock rounds and a delete all pass on one connection this way.
 */
import assert from 'node:assert/strict';
import { describe, it, type Mock, mock } from 'node:test';
import { RfcTransport } from '../connection/RfcTransport.js';

const ok = {
  RESPONSE: {
    STATUS_LINE: { STATUS_CODE: 200, REASON_PHRASE: 'OK' },
    HEADER_FIELDS: [],
    MESSAGE_BODY: Buffer.from('<ok/>', 'utf-8'),
  },
};

type Fake = {
  alive: boolean;
  open: Mock<(...args: any[]) => any>;
  close: Mock<(...args: any[]) => any>;
  call: Mock<(...args: any[]) => any>;
  resetServerContext: Mock<(...args: any[]) => any>;
};

function resettable(
  options: {
    failReset?: boolean;
    slowCall?: Promise<void>;
    slowOpen?: { index: number; until: Promise<void> };
  } = {},
) {
  const opened: Fake[] = [];
  const connect = () => {
    const conversation: Fake = {
      alive: true,
      open: mock.fn(async () => {
        if (
          options.slowOpen &&
          opened.indexOf(conversation) === options.slowOpen.index
        ) {
          await options.slowOpen.until;
        }
      }),
      close: mock.fn(async () => {
        conversation.alive = false;
      }),
      call: mock.fn(async () => {
        if (options.slowCall && opened.indexOf(conversation) === 1) {
          await options.slowCall;
        }
        return ok;
      }),
      resetServerContext: mock.fn(async () => {
        if (options.failReset) throw new Error('reset refused');
      }),
    };
    opened.push(conversation);
    return conversation;
  };
  return { opened, transport: new RfcTransport(connect as never, null) };
}

const stateless = { method: 'PUT', url: '/put' };
const stateful = { method: 'POST', url: '/lock', stateful: true };

describe('RFC: one kept stateless conversation, reset after each call', () => {
  it('serves the non-stateful calls on one conversation, reset after each', async () => {
    const { opened, transport } = resettable();
    await transport.open();

    await transport.send(stateless);
    await transport.send(stateless);
    await transport.send(stateless);

    assert.strictEqual(opened.length, 2);
    assert.strictEqual(opened[1].call.mock.callCount(), 3);
    assert.strictEqual(opened[1].resetServerContext.mock.callCount(), 3);
    assert.strictEqual(opened[1].close.mock.callCount(), 0);
  });

  it('keeps the stateful requests on the lock conversation, never reset', async () => {
    const { opened, transport } = resettable();
    await transport.open();

    await transport.send(stateful);
    await transport.send(stateless);
    await transport.send(stateful);

    assert.strictEqual(opened[0].call.mock.callCount(), 2);
    assert.strictEqual(opened[0].resetServerContext.mock.callCount(), 0);
    assert.strictEqual(opened[1].call.mock.callCount(), 1);
  });

  it('drops a conversation whose reset failed; the next call opens another', async () => {
    const { opened, transport } = resettable({ failReset: true });
    await transport.open();

    await transport.send(stateless);
    await transport.send(stateless);

    assert.strictEqual(opened.length, 3);
    assert.strictEqual(opened[1].close.mock.callCount(), 1);
    assert.strictEqual(opened[2].call.mock.callCount(), 1);
  });

  it('a call made while the kept one is busy takes a conversation of its own', async () => {
    let release: () => void = () => {};
    const slowCall = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { opened, transport } = resettable({ slowCall });
    await transport.open();

    const first = transport.send(stateless);
    // let the first call reach its (slow) call on the kept conversation
    await new Promise((r) => setImmediate(r));
    const second = transport.send(stateless);
    await second;
    release();
    await first;

    assert.strictEqual(opened.length, 3);
    assert.strictEqual(opened[1].call.mock.callCount(), 1);
    assert.strictEqual(opened[2].call.mock.callCount(), 1);
    assert.strictEqual(opened[2].close.mock.callCount(), 1);
  });

  it('a send() made while close() is under way is refused, stateful or not', async () => {
    // close() used to await the stateless conversation's close before it let
    // go of the stateful one: in that window a LOCK still found the old
    // session alive, and a stateless call opened a conversation of its own
    // and sent after close().
    let finishClose: () => void = () => {};
    const slowClose = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const { opened, transport } = resettable();
    await transport.open();
    await transport.send(stateless);
    opened[1].close.mock.mockImplementationOnce(async () => {
      await slowClose;
    });

    const closing = transport.close();
    await assert.rejects(transport.send(stateful), (e: unknown) =>
      /not open/.test((e as Error).message),
    );
    await assert.rejects(transport.send(stateless), (e: unknown) =>
      /not open/.test((e as Error).message),
    );
    finishClose();
    await closing;

    assert.strictEqual(opened.length, 2);
    assert.strictEqual(opened[0].call.mock.callCount(), 0);
    assert.strictEqual(opened[1].call.mock.callCount(), 1);
  });

  it('open() closed meanwhile does not hand out the session it logged on to', async () => {
    let finishLogon: () => void = () => {};
    const until = new Promise<void>((resolve) => {
      finishLogon = resolve;
    });
    const { opened, transport } = resettable({ slowOpen: { index: 0, until } });

    const opening = transport.open();
    await transport.close();
    finishLogon();

    await assert.rejects(opening, (e: unknown) =>
      /closed while it was being opened/.test((e as Error).message),
    );
    assert.strictEqual(opened[0].close.mock.callCount(), 1);
    await assert.rejects(transport.send(stateful), (e: unknown) =>
      /not open/.test((e as Error).message),
    );
  });

  it('a stateless logon that close() overtook neither sends nor becomes the kept one', async () => {
    let finishLogon: () => void = () => {};
    const until = new Promise<void>((resolve) => {
      finishLogon = resolve;
    });
    const { opened, transport } = resettable({ slowOpen: { index: 1, until } });
    await transport.open();

    const sending = transport.send(stateless);
    await new Promise((r) => setImmediate(r));
    await transport.close();
    finishLogon();

    await assert.rejects(sending, (e: unknown) =>
      /closed/.test((e as Error).message),
    );
    assert.strictEqual(opened[1].call.mock.callCount(), 0);
    assert.notStrictEqual(opened[1].close.mock.callCount(), 0);

    // The next generation opens its own: the overtaken one was not kept.
    await transport.open();
    await transport.send(stateless);
    assert.strictEqual(opened[1].call.mock.callCount(), 0);
    assert.strictEqual(opened.length, 4);
    assert.strictEqual(opened[3].call.mock.callCount(), 1);
  });

  it('close() closes the kept stateless conversation too', async () => {
    const { opened, transport } = resettable();
    await transport.open();
    await transport.send(stateless);

    await transport.close();

    assert.strictEqual(opened[1].close.mock.callCount(), 1);
    assert.strictEqual(opened[0].close.mock.callCount(), 1);
  });
});
