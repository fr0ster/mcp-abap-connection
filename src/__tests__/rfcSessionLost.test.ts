/**
 * An RFC error that ends the stateful conversation ends the instance's session.
 *
 * The conversation IS the session, with every lock taken in it. When
 * sap-rfc-lite releases it after an error (`alive` false), the wire says so —
 * `WireSessionLostError`, carrying the call's `rfc` — and decides nothing
 * else; the connection reports it as the session lost (`ADT_SESSION_REPLACED`),
 * the instance is spent, and nothing opens a new session on its own: a new
 * session is a new instance, which only the caller creates.
 *
 * The verdict is `alive`, never a list of codes: the connection keeps no copy
 * of the library's.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BasicAuthProvider } from '@mcp-abap-adt/auth-providers';
import { ADT_SESSION_ERROR } from '@mcp-abap-adt/interfaces-adt-connection';
import type { ISapRfcConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import { WireSessionLostError } from '../connection/authErrors.js';
import type {
  IAdtTransportRequest,
  IAdtTransportResponse,
  IOnPremTransport,
} from '../connection/IAdtTransport.js';
import { RfcTransport } from '../connection/RfcTransport.js';
import * as packageSurface from '../index.js';
import type { ILogger } from '../logger.js';
import {
  abapExceptionError,
  type CallScript,
  closedConnectionError,
  dies,
  fails,
  RFC_CLOSED_FIELDS,
  type RfcStandIn,
  rfcClosedError,
  standInFactory,
} from './helpers/rfcStandIn.js';
import { holdsNoSession } from './helpers/transportStub.js';

const stateful: IAdtTransportRequest = {
  method: 'POST',
  url: '/sap/bc/adt/oo/classes/zcl_x?_action=LOCK',
  stateful: true,
};

const LOST_WORDS =
  "The RFC conversation that carried this connection's SAP session has ended; any lock held in it is gone. Create a new connection for a new session.";

async function rejection(sending: Promise<unknown>): Promise<Error> {
  try {
    await sending;
  } catch (error) {
    assert.ok(error instanceof Error, 'an Error reaches the caller');
    return error;
  }
  assert.fail('the request was expected to fail');
}

function own(error: Error, name: string): unknown {
  return Object.getOwnPropertyDescriptor(error, name)?.value;
}

function nth(made: RfcStandIn[], index: number): RfcStandIn {
  const conversation = made[index];
  assert.ok(conversation, `conversation ${index} was opened`);
  return conversation;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('the RFC wire, when the stateful conversation dies', () => {
  it('throws WireSessionLostError with rfc and drops the conversation without closing it', async () => {
    const { factory, made } = standInFactory([[dies()]], true);
    const transport = new RfcTransport(factory);
    await transport.open();

    const error = await rejection(transport.send(stateful));

    assert.ok(error instanceof WireSessionLostError);
    assert.deepStrictEqual(error.rfc, RFC_CLOSED_FIELDS);
    assert.ok(
      error.message.startsWith('RFC call to SADT_REST_RFC_ENDPOINT failed: '),
    );
    assert.strictEqual(nth(made, 0).closes, 0);
    assert.strictEqual(transport.sessionEstablished(), false);
    assert.deepStrictEqual([...transport.sessionFingerprint()], []);

    // Nothing more goes on it, and the wire opens no other in its place.
    await rejection(transport.send(stateful));
    assert.strictEqual(nth(made, 0).calls, 1);
    assert.strictEqual(made.length, 1);

    // Its close() finds no stateful conversation to close.
    await transport.close();
    assert.strictEqual(nth(made, 0).closes, 0);
  });

  it('a thrown value whose formatting throws does not bypass the verdict', async () => {
    // JSON.stringify runs an enumerable getter; this one throws.
    const hostile: Record<string, unknown> = {
      ...rfcClosedError(),
      get detail(): string {
        throw new Error('the getter’s own words');
      },
    };
    const { factory, made } = standInFactory([[dies(hostile)]], true);
    const transport = new RfcTransport(factory);
    await transport.open();

    const error = await rejection(transport.send(stateful));

    assert.ok(error instanceof WireSessionLostError);
    assert.deepStrictEqual(error.rfc, RFC_CLOSED_FIELDS);
    assert.strictEqual(
      error.message,
      'RFC call to SADT_REST_RFC_ENDPOINT failed: the failure could not be described',
    );
    assert.ok(!error.message.includes('getter'));
    assert.strictEqual(transport.sessionEstablished(), false);
    assert.strictEqual(nth(made, 0).closes, 0);
  });

  it('a logger that throws does not bypass the verdict', async () => {
    const { factory } = standInFactory([[dies()]], true);
    const throwing: ILogger = {
      info: () => {},
      warn: () => {},
      debug: () => {},
      error: () => {
        throw new Error('the logger’s own words');
      },
    };
    const transport = new RfcTransport(factory, throwing);
    await transport.open();

    const error = await rejection(transport.send(stateful));

    assert.ok(error instanceof WireSessionLostError);
    assert.deepStrictEqual(error.rfc, RFC_CLOSED_FIELDS);
    assert.ok(!error.message.includes('logger'));
    assert.strictEqual(transport.sessionEstablished(), false);
  });

  it('through the connection, a hostile thrown value is still the session lost', async () => {
    const hostile: Record<string, unknown> = {
      ...rfcClosedError(),
      get detail(): string {
        throw new Error('the getter’s own words');
      },
    };
    const { factory, made } = standInFactory([[dies(hostile)]], true);
    const conn = new AdtOnPremConnector(
      config,
      new BasicAuthProvider('USER', 'PASS'),
      new RfcTransport(factory),
      null,
    );
    await conn.connect();
    conn.setSessionType('stateful');

    const error = await rejection(
      conn.makeAdtRequest({
        url: stateful.url,
        method: 'POST',
        timeout: 30000,
      }),
    );
    assert.strictEqual(own(error, 'code'), ADT_SESSION_ERROR.SESSION_REPLACED);
    assert.deepStrictEqual(own(error, 'rfc'), RFC_CLOSED_FIELDS);
    const next = await rejection(
      conn.makeAdtRequest({
        url: stateful.url,
        method: 'POST',
        timeout: 30000,
      }),
    );
    assert.strictEqual(own(next, 'code'), ADT_SESSION_ERROR.NOT_CONNECTED);
    assert.strictEqual(nth(made, 0).calls, 1);
    await conn.disconnect();
  });

  it('a failure that leaves it alive is the call’s error, not a lost session', async () => {
    const { factory, made } = standInFactory(
      [[fails(abapExceptionError())]],
      true,
    );
    const transport = new RfcTransport(factory);
    await transport.open();

    const error = await rejection(transport.send(stateful));

    assert.ok(!(error instanceof WireSessionLostError));
    assert.deepStrictEqual(own(error, 'rfc'), {
      key: 'NOT_FOUND',
      group: 5,
      code: 5,
      codeString: 'RFC_ABAP_EXCEPTION',
    });
    assert.strictEqual(transport.sessionEstablished(), true);
    assert.strictEqual(nth(made, 0).closes, 0);
  });

  it('a close() of ours during the call is not a lost session', async () => {
    const gate = deferred();
    const closedUnderIt: CallScript = async () => {
      await gate.promise;
      throw rfcClosedError();
    };
    const { factory, made } = standInFactory([[closedUnderIt]], true);
    const transport = new RfcTransport(factory);
    await transport.open();

    const sending = rejection(transport.send(stateful));
    await transport.close();
    gate.resolve();
    const error = await sending;

    assert.strictEqual(nth(made, 0).alive, false);
    assert.ok(!(error instanceof WireSessionLostError));
  });

  it('a concurrent stateful call that meets the released conversation is reported the same, without rfc', async () => {
    const gate = deferred();
    const died = deferred();
    const first: CallScript = async (conversation) => {
      await gate.promise;
      conversation.alive = false;
      died.resolve();
      throw rfcClosedError();
    };
    const second: CallScript = async () => {
      await died.promise;
      throw closedConnectionError();
    };
    const { factory } = standInFactory([[first, second]], true);
    const transport = new RfcTransport(factory);
    await transport.open();

    const one = rejection(transport.send(stateful));
    const two = rejection(transport.send(stateful));
    gate.resolve();

    const [firstError, secondError] = await Promise.all([one, two]);
    assert.ok(firstError instanceof WireSessionLostError);
    assert.deepStrictEqual(firstError.rfc, RFC_CLOSED_FIELDS);
    assert.ok(secondError instanceof WireSessionLostError);
    assert.strictEqual(secondError.rfc, undefined);
  });
});

const config: ISapRfcConfig = {
  connectionType: 'rfc',
  authType: 'basic',
  ashost: 'saphost',
  sysnr: '00',
  client: '100',
  language: 'EN',
};

function recordingLogger(): { logger: ILogger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      info: () => {},
      error: () => {},
      debug: () => {},
      warn: (line: string) => {
        warnings.push(line);
      },
    },
  };
}

describe('the connection, when the wire reports the session lost', () => {
  it('reports ADT_SESSION_REPLACED with rfc, spends the instance, and opens nothing new', async () => {
    const { factory, made } = standInFactory([[dies()]], true);
    const conn = new AdtOnPremConnector(
      config,
      new BasicAuthProvider('USER', 'PASS'),
      new RfcTransport(factory),
      null,
    );
    await conn.connect();
    conn.setSessionType('stateful');

    const error = await rejection(
      conn.makeAdtRequest({
        url: stateful.url,
        method: 'POST',
        timeout: 30000,
      }),
    );

    assert.strictEqual(own(error, 'code'), ADT_SESSION_ERROR.SESSION_REPLACED);
    assert.deepStrictEqual(own(error, 'rfc'), RFC_CLOSED_FIELDS);
    assert.strictEqual(error.message, LOST_WORDS);
    const opened = made.length;

    const next = await rejection(
      conn.makeAdtRequest({
        url: stateful.url,
        method: 'POST',
        timeout: 30000,
      }),
    );
    assert.strictEqual(own(next, 'code'), ADT_SESSION_ERROR.NOT_CONNECTED);
    conn.setSessionType('stateless');
    const stateless = await rejection(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/discovery',
        method: 'GET',
        timeout: 30000,
      }),
    );
    assert.strictEqual(own(stateless, 'code'), ADT_SESSION_ERROR.NOT_CONNECTED);
    const reconnect = await rejection(conn.connect());
    assert.strictEqual(own(reconnect, 'code'), ADT_SESSION_ERROR.NOT_CONNECTED);

    assert.strictEqual(made.length, opened, 'no conversation opened after it');
    assert.strictEqual(nth(made, 0).calls, 1, 'nothing more sent on it');
    await conn.disconnect();
  });

  it('a stateful failure that leaves the conversation alive does not spend the instance', async () => {
    const { factory } = standInFactory([[fails(abapExceptionError())]], true);
    const conn = new AdtOnPremConnector(
      config,
      new BasicAuthProvider('USER', 'PASS'),
      new RfcTransport(factory),
      null,
    );
    await conn.connect();
    conn.setSessionType('stateful');
    try {
      const error = await rejection(
        conn.makeAdtRequest({
          url: stateful.url,
          method: 'POST',
          timeout: 30000,
        }),
      );
      assert.strictEqual(own(error, 'code'), undefined);

      const response = await conn.makeAdtRequest({
        url: stateful.url,
        method: 'POST',
        timeout: 30000,
      });
      assert.strictEqual(response.status, 200);
    } finally {
      await conn.disconnect();
    }
  });

  /** A wire that is not RFC, whose send answers as `answer` says. */
  function stubWire(
    answer: () => Promise<IAdtTransportResponse>,
  ): IOnPremTransport {
    return {
      kind: 'stub',
      system: 'onprem',
      ...holdsNoSession,
      sessionEstablished: () => true,
      sessionFingerprint: () => new Map([['stub-session', 'S1']]),
      send: () => answer(),
    };
  }

  it('acts on the marker, not on the kind of wire', async () => {
    const lost = new WireSessionLostError('the stub lost its session', {
      key: 'K',
      group: 4,
      code: 6,
      codeString: 'RFC_CLOSED',
    });
    let sent = 0;
    const conn = new AdtOnPremConnector(
      config,
      new BasicAuthProvider('USER', 'PASS'),
      stubWire(async () => {
        sent += 1;
        throw lost;
      }),
      null,
    );
    await conn.connect();

    const error = await rejection(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/discovery',
        method: 'GET',
        timeout: 30000,
      }),
    );

    assert.strictEqual(own(error, 'code'), ADT_SESSION_ERROR.SESSION_REPLACED);
    assert.deepStrictEqual(own(error, 'rfc'), {
      key: 'K',
      group: 4,
      code: 6,
      codeString: 'RFC_CLOSED',
    });
    const next = await rejection(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/discovery',
        method: 'GET',
        timeout: 30000,
      }),
    );
    assert.strictEqual(own(next, 'code'), ADT_SESSION_ERROR.NOT_CONNECTED);
    assert.strictEqual(sent, 1);
    await conn.disconnect();
  });

  it('without rfc, the verdict carries none', async () => {
    const conn = new AdtOnPremConnector(
      config,
      new BasicAuthProvider('USER', 'PASS'),
      stubWire(async () => {
        throw new WireSessionLostError('gone');
      }),
      null,
    );
    await conn.connect();

    const error = await rejection(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/discovery',
        method: 'GET',
        timeout: 30000,
      }),
    );

    assert.strictEqual(own(error, 'code'), ADT_SESSION_ERROR.SESSION_REPLACED);
    assert.strictEqual(Object.hasOwn(error, 'rfc'), false);
    await conn.disconnect();
  });

  it('a WireSessionLostError from an ended session is rethrown as it is, and nothing is raised', async () => {
    const gate = deferred();
    const entered = deferred();
    const lost = new WireSessionLostError('late');
    const { logger, warnings } = recordingLogger();
    const conn = new AdtOnPremConnector(
      config,
      new BasicAuthProvider('USER', 'PASS'),
      stubWire(async () => {
        entered.resolve();
        await gate.promise;
        throw lost;
      }),
      logger,
    );
    await conn.connect();

    const inFlight = rejection(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/discovery',
        method: 'GET',
        timeout: 30000,
      }),
    );
    // On the wire, then the session ends under it.
    await entered.promise;
    await conn.disconnect();
    gate.resolve();
    const error = await inFlight;

    assert.strictEqual(error, lost);
    assert.deepStrictEqual(
      warnings.filter((line) => line.startsWith('Session lost')),
      [],
    );
  });

  it('is exported beside WireLogonError, so a consumer’s own wire can say it', () => {
    assert.strictEqual(
      packageSurface.WireSessionLostError,
      WireSessionLostError,
    );
  });
});
