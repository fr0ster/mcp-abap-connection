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
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BasicAuthProvider } from '@mcp-abap-adt/auth-providers';
import { ADT_SESSION_ERROR } from '@mcp-abap-adt/interfaces-adt-connection';
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
function conversation(
  body = 'Session not found',
  status = 400,
  statusText = 'Bad Request',
) {
  let dead = false;
  let closed = true;
  let refusals = 0;
  return {
    get refusals() {
      return refusals;
    },
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
    call: async () => {
      if (dead) refusals++;
      return {
        RESPONSE: dead
          ? {
              STATUS_LINE: {
                STATUS_CODE: status,
                REASON_PHRASE: statusText,
              },
              HEADER_FIELDS: [{ NAME: 'content-type', VALUE: 'text/plain' }],
              MESSAGE_BODY: Buffer.from(body, 'utf-8'),
            }
          : {
              STATUS_LINE: { STATUS_CODE: 200, REASON_PHRASE: 'OK' },
              HEADER_FIELDS: [
                { NAME: 'content-type', VALUE: 'application/xml' },
              ],
              MESSAGE_BODY: Buffer.from('<service/>', 'utf-8'),
            },
      };
    },
  };
}

function overRfc(wire: ReturnType<typeof conversation>) {
  return new AdtOnPremConnector(
    config,
    new BasicAuthProvider('u', 'p'),
    new RfcTransport(() => wire, null),
    null,
    undefined,
  );
}

describe('a refusal that is not an AxiosError', () => {
  it('takes the connection off the session the server says is gone', async () => {
    const wire = conversation();
    const conn = overRfc(wire);
    await conn.connect();
    assert.strictEqual(conn.isConnected(), true);

    wire.die();
    await assert.rejects(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/oo/classes/ZCL_X',
        method: 'GET',
        timeout: 5000,
      }),
    );

    // The conversation is still alive; only the answer said the session was
    // gone. If the lifecycle reads that answer, this is false — if it only
    // reads the wire's health, it stays true and the caller locks over a
    // session that does not exist.
    assert.strictEqual(conn.isConnected(), false);
  });
});

describe('dead-session refusal phrases', () => {
  const icmBody =
    '400 Session Timed Out or Not Found\r\nSession no longer exists';

  for (const body of [
    icmBody,
    'SESSION TIMED OUT OR NOT FOUND',
    'SeSsIoN No LoNgEr ExIsTs',
    'SESSION NOT FOUND',
  ]) {
    it(`diagnoses a dead session from ${JSON.stringify(body)}`, async () => {
      const wire = conversation(body);
      const conn = overRfc(wire);
      await conn.connect();
      wire.die();

      await assert.rejects(
        conn.makeAdtRequest({
          url: '/sap/bc/adt/oo/classes/ZCL_X',
          method: 'GET',
          timeout: 0,
        }),
        { code: ADT_SESSION_ERROR.SESSION_REPLACED },
      );
      assert.strictEqual(conn.isConnected(), false);
      assert.strictEqual(wire.refusals, 1);
    });
  }

  it('diagnoses an ICM refusal at LOCK without retrying it', async () => {
    const wire = conversation(icmBody);
    const conn = overRfc(wire);
    await conn.connect();
    wire.die();

    await assert.rejects(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/oo/classes/ZCL_X?_action=LOCK&accessMode=MODIFY',
        method: 'POST',
        timeout: 0,
        headers: { 'x-sap-adt-sessiontype': 'stateful' },
      }),
      {
        code: ADT_SESSION_ERROR.SESSION_REPLACED,
        message:
          'The SAP session no longer exists; any lock handle from it is dead',
      },
    );
    assert.strictEqual(conn.isConnected(), false);
    assert.strictEqual(wire.refusals, 1);
  });

  for (const refusal of [
    { body: 'Invalid lock request', status: 400, statusText: 'Bad Request' },
    { body: icmBody, status: 500, statusText: 'Internal Server Error' },
  ]) {
    it(`preserves a non-session refusal: ${refusal.status} ${refusal.body}`, async () => {
      const wire = conversation(
        refusal.body,
        refusal.status,
        refusal.statusText,
      );
      const conn = overRfc(wire);
      await conn.connect();
      wire.die();

      await assert.rejects(
        conn.makeAdtRequest({
          url: '/sap/bc/adt/oo/classes/ZCL_X',
          method: 'GET',
          timeout: 0,
        }),
        {
          message: `Request failed with status ${refusal.status}: GET /sap/bc/adt/oo/classes/ZCL_X`,
        },
      );
      assert.strictEqual(conn.isConnected(), true);
      assert.strictEqual(wire.refusals, 1);
    });
  }
});
