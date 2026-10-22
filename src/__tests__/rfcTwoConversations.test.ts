/**
 * Over RFC, the stateful requests share one conversation and every other
 * request has one of its own — the way Eclipse ADT holds them over JCo.
 *
 * One conversation for everything kept whatever an ABAP program left in the
 * session: a package saved in it could not be written or deleted in it again
 * (400 PAK/058), and a read straight after a create answered 400
 * SADT_RESOURCE/007. Measured on E19, 2026-09-27: LOCK/UNLOCK on one
 * conversation and the PUT on another pass twice in a row only when the PUT's
 * conversation is fresh each time.
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

/** Every conversation the transport opened, in order, with what it carried. */
function conversations(
  answer: () => Promise<Record<string, unknown>> = async () => ok,
) {
  const opened: Array<{
    open: Mock<(...args: any[]) => any>;
    close: Mock<(...args: any[]) => any>;
    call: Mock<(...args: any[]) => any>;
    alive: boolean;
  }> = [];
  const connect = () => {
    const conversation = {
      alive: true,
      open: mock.fn(async () => {}),
      close: mock.fn(async () => {
        conversation.alive = false;
      }),
      call: mock.fn(async () => answer()),
    };
    opened.push(conversation);
    return conversation;
  };
  return { opened, transport: new RfcTransport(connect as never, null) };
}

const request = (stateful: boolean) => ({
  method: stateful ? 'POST' : 'PUT',
  url: stateful ? '/lock' : '/put',
  stateful,
});

describe('RFC: one stateful conversation, one conversation per other call', () => {
  it('carries stateful requests on the conversation open() opened', async () => {
    const { opened, transport } = conversations();
    await transport.open();

    await transport.send(request(true));
    await transport.send(request(true));

    assert.strictEqual(opened.length, 1);
    assert.strictEqual(opened[0].call.mock.callCount(), 2);
    assert.strictEqual(opened[0].close.mock.callCount(), 0);
  });

  it('carries each other request on a conversation of its own, closed after', async () => {
    const { opened, transport } = conversations();
    await transport.open();

    await transport.send(request(false));
    await transport.send(request(false));

    assert.strictEqual(opened.length, 3);
    assert.strictEqual(opened[0].call.mock.callCount(), 0);
    for (const own of opened.slice(1)) {
      assert.strictEqual(own.open.mock.callCount(), 1);
      assert.strictEqual(own.call.mock.callCount(), 1);
      assert.strictEqual(own.close.mock.callCount(), 1);
    }
  });

  it('lock, write, unlock: the write goes elsewhere, the unlock back to the lock', async () => {
    const { opened, transport } = conversations();
    await transport.open();

    await transport.send(request(true));
    await transport.send(request(false));
    await transport.send(request(true));

    assert.strictEqual(opened[0].call.mock.callCount(), 2);
    assert.strictEqual(opened.length, 2);
    assert.strictEqual(opened[1].call.mock.callCount(), 1);
  });

  it('closes its own conversation when the call fails', async () => {
    const { opened, transport } = conversations(async () => {
      throw new Error('boom');
    });
    await transport.open();

    await assert.rejects(transport.send(request(false)), (e: unknown) =>
      /boom/.test((e as Error).message),
    );
    assert.strictEqual(opened[1].close.mock.callCount(), 1);
  });

  it('a caller that wrote the session header itself stays on the lock conversation', async () => {
    // The same verdict HTTP takes (#60): without it such a caller's LOCK went
    // to a conversation that closed straight after, and the lock with it.
    const { opened, transport } = conversations();
    await transport.open();

    await transport.send({
      method: 'POST',
      url: '/lock',
      headers: { 'X-sap-adt-sessiontype': 'stateful' },
    });

    assert.strictEqual(opened.length, 1);
    assert.strictEqual(opened[0].call.mock.callCount(), 1);
  });

  it('sends nothing when the wire is closed while its own conversation logs on', async () => {
    let releaseLogon: () => void = () => {};
    const logon = new Promise<void>((resolve) => {
      releaseLogon = resolve;
    });
    const opened: Array<{
      call: Mock<(...args: any[]) => any>;
      close: Mock<(...args: any[]) => any>;
    }> = [];
    const connect = () => {
      const isFirst = opened.length === 0;
      const conversation = {
        alive: true,
        open: mock.fn(async () => {
          if (!isFirst) await logon;
        }),
        close: mock.fn(async () => {
          conversation.alive = false;
        }),
        call: mock.fn(async () => ok),
      };
      opened.push(conversation);
      return conversation;
    };
    const transport = new RfcTransport(connect as never, null);
    await transport.open();

    const sending = transport.send({ method: 'DELETE', url: '/delete' });
    await transport.close();
    releaseLogon();

    await assert.rejects(sending, (e: unknown) =>
      /closed while the call was being opened/.test((e as Error).message),
    );
    assert.strictEqual(opened[1].call.mock.callCount(), 0);
    assert.strictEqual(opened[1].close.mock.callCount(), 1);
  });

  it('refuses before connect(), stateless or not', async () => {
    const { opened, transport } = conversations();

    await assert.rejects(transport.send(request(false)), (e: unknown) =>
      /not open/.test((e as Error).message),
    );
    assert.strictEqual(opened.length, 0);
  });
});
