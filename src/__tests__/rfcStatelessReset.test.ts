/**
 * Over RFC, with a client that can reset its context (sap-rfc-lite >= 0.2.0),
 * the non-stateful calls share one kept conversation, reset after each call —
 * a fresh ABAP context without a new logon (~0.1 s against ~0.5 s on E19).
 * Measured on E19, 2026-09-27: create, read after create, two
 * lock/PUT/unlock rounds and a delete all pass on one connection this way.
 */
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
  open: jest.Mock;
  close: jest.Mock;
  call: jest.Mock;
  resetServerContext: jest.Mock;
};

function resettable(
  options: { failReset?: boolean; slowCall?: Promise<void> } = {},
) {
  const opened: Fake[] = [];
  const connect = () => {
    const conversation: Fake = {
      alive: true,
      open: jest.fn(async () => {}),
      close: jest.fn(async () => {
        conversation.alive = false;
      }),
      call: jest.fn(async () => {
        if (options.slowCall && opened.indexOf(conversation) === 1) {
          await options.slowCall;
        }
        return ok;
      }),
      resetServerContext: jest.fn(async () => {
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

    expect(opened).toHaveLength(2);
    expect(opened[1].call).toHaveBeenCalledTimes(3);
    expect(opened[1].resetServerContext).toHaveBeenCalledTimes(3);
    expect(opened[1].close).not.toHaveBeenCalled();
  });

  it('keeps the stateful requests on the lock conversation, never reset', async () => {
    const { opened, transport } = resettable();
    await transport.open();

    await transport.send(stateful);
    await transport.send(stateless);
    await transport.send(stateful);

    expect(opened[0].call).toHaveBeenCalledTimes(2);
    expect(opened[0].resetServerContext).not.toHaveBeenCalled();
    expect(opened[1].call).toHaveBeenCalledTimes(1);
  });

  it('drops a conversation whose reset failed; the next call opens another', async () => {
    const { opened, transport } = resettable({ failReset: true });
    await transport.open();

    await transport.send(stateless);
    await transport.send(stateless);

    expect(opened).toHaveLength(3);
    expect(opened[1].close).toHaveBeenCalledTimes(1);
    expect(opened[2].call).toHaveBeenCalledTimes(1);
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

    expect(opened).toHaveLength(3);
    expect(opened[1].call).toHaveBeenCalledTimes(1);
    expect(opened[2].call).toHaveBeenCalledTimes(1);
    expect(opened[2].close).toHaveBeenCalledTimes(1);
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
    opened[1].close.mockImplementationOnce(async () => {
      await slowClose;
    });

    const closing = transport.close();
    await expect(transport.send(stateful)).rejects.toThrow(/not open/);
    await expect(transport.send(stateless)).rejects.toThrow(/not open/);
    finishClose();
    await closing;

    expect(opened).toHaveLength(2);
    expect(opened[0].call).not.toHaveBeenCalled();
    expect(opened[1].call).toHaveBeenCalledTimes(1);
  });

  it('close() closes the kept stateless conversation too', async () => {
    const { opened, transport } = resettable();
    await transport.open();
    await transport.send(stateless);

    await transport.close();

    expect(opened[1].close).toHaveBeenCalledTimes(1);
    expect(opened[0].close).toHaveBeenCalledTimes(1);
  });
});
