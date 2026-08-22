/**
 * A refusal is read from its shape, not from which client threw it.
 *
 * `IAdtTransport` promises one thing about a failure: it carries `response`.
 * `HttpTransport` throws an `AxiosError`, which happens to satisfy that;
 * `RfcTransport` throws a plain `Error` with the field, which is exactly what
 * the contract asks for. The base lifecycle asked `instanceof AxiosError`
 * instead, so everything it does with a failing response — observing its
 * headers, noticing a dead session — was reachable over one wire only.
 *
 * The consequence is not cosmetic. An RFC conversation stays `alive` when the
 * ABAP session behind it is gone, so nothing else can notice: the identity
 * comparison cannot see it (there is no cookie to change), and `isConnected()`
 * goes on answering true over a session that no longer exists.
 */
import { BasicAuthProvider } from '../../auth/providers.js';
import type { SapConfig } from '../../config/sapConfig.js';
import { AdtOnPremConnector } from '../../connection/AdtOnPremConnector.js';
import { RfcTransport } from '../../connection/RfcTransport.js';

const config: SapConfig = {
  url: 'https://sap.example.com',
  authType: 'basic',
  username: 'u',
  password: 'p',
  client: '100',
};

/** A conversation that answers, then answers "session not found" once open. */
function conversation() {
  let dead = false;
  let closed = true;
  return {
    die: () => {
      dead = true;
    },
    get alive() {
      // Deliberately still alive: losing the ABAP session does not drop the
      // RFC conversation, which is the whole reason the lifecycle has to be
      // told by the answer rather than by the wire's own health.
      return !closed;
    },
    open: async () => {
      closed = false;
    },
    close: async () => {
      closed = true;
    },
    call: async () => ({
      RESPONSE: dead
        ? {
            STATUS_LINE: {
              STATUS_CODE: 400,
              REASON_PHRASE: 'Session not found',
            },
            HEADER_FIELDS: [{ NAME: 'content-type', VALUE: 'text/plain' }],
            MESSAGE_BODY: Buffer.from('Session not found', 'utf-8'),
          }
        : {
            STATUS_LINE: { STATUS_CODE: 200, REASON_PHRASE: 'OK' },
            HEADER_FIELDS: [{ NAME: 'content-type', VALUE: 'application/xml' }],
            MESSAGE_BODY: Buffer.from('<service/>', 'utf-8'),
          },
    }),
  };
}

function overRfc(wire: ReturnType<typeof conversation>) {
  return new AdtOnPremConnector(
    config,
    new BasicAuthProvider('u', 'p'),
    null,
    undefined,
    { transport: new RfcTransport(() => wire as never, null) },
  );
}

describe('a refusal that is not an AxiosError', () => {
  it('takes the connection off the session the server says is gone', async () => {
    const wire = conversation();
    const conn = overRfc(wire);
    await conn.connect();
    expect(conn.isConnected()).toBe(true);

    wire.die();
    await expect(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/oo/classes/ZCL_X',
        method: 'GET',
        timeout: 5000,
      }),
    ).rejects.toThrow();

    // The conversation is still alive; only the answer said the session was
    // gone. If the lifecycle reads that answer, this is false — if it only
    // reads the wire's health, it stays true and the caller locks over a
    // session that does not exist.
    expect(conn.isConnected()).toBe(false);
  });
});
