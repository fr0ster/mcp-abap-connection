/**
 * An instance built on an existing session (`createConnection({ …, session })`).
 *
 * `connect()` does not log on: the wire seeds its jar with the session's
 * cookies and makes ONE request in that session without the credential — a
 * dead session must not quietly become a new one, and a credential on that
 * request would open one (measured: a dead cookie with a good password gets a
 * new `SAP_SESSIONID`). SAP's answer says whether the session is alive.
 *
 * Against the local SAP stand-in with `authenticate` on, so a request with no
 * credential and no live session is refused `401`, as SAP refuses it.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { BasicAuthProvider } from '@mcp-abap-adt/auth-providers';
import { ADT_SESSION_ERROR } from '@mcp-abap-adt/interfaces-adt-connection';
import type { SapConfig } from '../config/sapConfig.js';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import {
  type CreatedConnection,
  createConnection,
} from '../connection/createConnection.js';
import { RfcTransport } from '../connection/RfcTransport.js';
import { assertMatchObject } from './helpers/assertions.js';
import { type SapStub, startSapStub } from './helpers/sapStub.js';

const DISCOVERY = '/sap/bc/adt/core/discovery';
const LOGOFF = '/sap/public/bc/icf/logoff';
const LOCK = '/sap/bc/adt/oo/classes/zcl_x';
const COOKIE = 'SAP_SESSIONID_STUB_100';

let stub: SapStub;

beforeEach(async () => {
  stub = await startSapStub();
  stub.authenticate = true;
});

afterEach(async () => {
  await stub.close();
});

function config(): SapConfig {
  return {
    url: stub.baseUrl,
    client: '100',
    authType: 'basic',
    username: 'u',
    password: 'p',
  };
}

function onPremHttp(session?: string): CreatedConnection {
  return createConnection({
    system: 'onprem',
    transport: 'http',
    config: config(),
    credential: new BasicAuthProvider('u', 'p'),
    ...(session !== undefined ? { session } : {}),
  });
}

function cloudHttp(session?: string): CreatedConnection {
  return createConnection({
    system: 'cloud',
    transport: 'http',
    config: config(),
    credential: new BasicAuthProvider('u', 'p'),
    ...(session !== undefined ? { session } : {}),
  });
}

/** A session opened the ordinary way, with a stateful context in it, and its cookies. */
async function openedSession(): Promise<{
  first: CreatedConnection;
  cookies: string;
}> {
  const first = onPremHttp();
  await first.connect();
  stub.work(LOCK, [
    {
      status: 200,
      headers: { 'set-cookie': ['sap-contextid=CTX1; path=/'] },
      body: '<lock/>',
    },
  ]);
  first.setSessionType('stateful');
  await first.makeAdtRequest({
    url: LOCK,
    method: 'POST',
    params: { _action: 'LOCK' },
    timeout: 0,
  });
  first.setSessionType('stateless');
  const cookies = first.sessionCookies();
  if (cookies === null) throw new Error('the first instance holds no session');
  return { first, cookies };
}

const pairs = (cookie: string | undefined) =>
  new Set((cookie ?? '').split(/;\s*/).filter((pair) => pair !== ''));

describe('sessionCookies()', () => {
  it('is null before a session, and the session’s cookies once there is one', async () => {
    const conn = onPremHttp();
    assert.strictEqual(conn.sessionCookies(), null);
    await conn.connect();
    assert.deepStrictEqual(
      pairs(conn.sessionCookies() ?? ''),
      new Set([`${COOKIE}=S1`, 'sap-usercontext=sap-client=100']),
    );
  });

  it('carries the stateful context, and not the CSRF token’s cookie', async () => {
    stub.discovery.push({
      status: 200,
      headers: {
        'set-cookie': [`${COOKIE}=S1; path=/`, 'sap-XSRF_STUB_100=x1; path=/'],
      },
    });
    const { cookies } = await openedSession();
    assert.deepStrictEqual(
      pairs(cookies),
      new Set([
        `${COOKIE}=S1`,
        'sap-usercontext=sap-client=100',
        'sap-contextid=CTX1',
      ]),
    );
  });

  it('is null after disconnect(), and over RFC', async () => {
    const conn = onPremHttp();
    await conn.connect();
    await conn.disconnect();
    assert.strictEqual(conn.sessionCookies(), null);
    assert.strictEqual(
      new RfcTransport(() => ({}) as never).sessionCookies(),
      null,
    );
  });
});

describe('an instance on a live session', () => {
  it('logs on nowhere: one request, carrying the cookies and no credential', async () => {
    const { cookies } = await openedSession();
    const before = stub.requests.length;

    const conn = onPremHttp(cookies);
    await conn.connect();

    const sent = stub.requests.slice(before);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].path, DISCOVERY);
    assert.strictEqual(sent[0].headers['x-csrf-token'], 'fetch');
    assert.strictEqual(sent[0].headers.authorization, undefined);
    assert.strictEqual(pairs(sent[0].headers.cookie).has(`${COOKIE}=S1`), true);
    // Not stateful, so not in the lock's context.
    assert.strictEqual(
      pairs(sent[0].headers.cookie).has('sap-contextid=CTX1'),
      false,
    );
    // No session was opened for it.
    assert.deepStrictEqual([...stub.sessions], ['S1']);
    assert.strictEqual(conn.isConnected(), true);
    assert.notStrictEqual(conn.getSessionIdentity(), null);
  });

  it('then sends its requests in that session, with the credential as usual', async () => {
    const { cookies } = await openedSession();
    const conn = onPremHttp(cookies);
    await conn.connect();
    const before = stub.requests.length;

    await conn.makeAdtRequest({
      url: '/sap/bc/adt/x',
      method: 'GET',
      timeout: 0,
    });
    await conn.makeAdtRequest({
      url: '/sap/bc/adt/y',
      method: 'PUT',
      data: 'x',
      timeout: 0,
    });

    const sent = stub.requests.slice(before);
    assert.deepStrictEqual(
      sent.map((request) => request.status),
      [200, 200],
    );
    for (const request of sent) {
      assert.strictEqual(
        pairs(request.headers.cookie).has(`${COOKIE}=S1`),
        true,
      );
      assert.match(request.headers.authorization, /^Basic /);
    }
    // The PUT went with the token the takeover earned.
    assert.strictEqual(sent[1].headers['x-csrf-token'], stub.tokens.at(-1));
    assert.deepStrictEqual([...stub.sessions], ['S1']);
  });

  it('sends a stateful request into the adopted ABAP context', async () => {
    const { cookies } = await openedSession();
    const conn = onPremHttp(cookies);
    await conn.connect();
    const before = stub.requests.length;

    conn.setSessionType('stateful');
    await conn.makeAdtRequest({
      url: LOCK,
      method: 'POST',
      params: { _action: 'UNLOCK' },
      timeout: 0,
    });

    const [unlock] = stub.requests.slice(before);
    assert.strictEqual(
      pairs(unlock.headers.cookie).has('sap-contextid=CTX1'),
      true,
    );
    assert.strictEqual(unlock.headers['x-sap-adt-sessiontype'], 'stateful');
  });

  it('logs the session off at disconnect(), as any instance does', async () => {
    const { cookies } = await openedSession();
    const conn = onPremHttp(cookies);
    await conn.connect();

    await conn.disconnect();
    await conn.flushGoodbye();

    const logoffs = stub.sentTo(LOGOFF);
    assert.strictEqual(logoffs.length, 1);
    assert.strictEqual(
      pairs(logoffs[0].headers.cookie).has(`${COOKIE}=S1`),
      true,
    );
    assert.strictEqual(stub.sessions.size, 0);
  });

  it('hands out cookies that build the next instance on the same session', async () => {
    const { cookies } = await openedSession();
    const second = onPremHttp(cookies);
    await second.connect();
    const again = second.sessionCookies();
    assert.deepStrictEqual(pairs(again ?? ''), pairs(cookies));

    const third = onPremHttp(again as string);
    await third.connect();
    assert.strictEqual(third.isConnected(), true);
    assert.deepStrictEqual([...stub.sessions], ['S1']);
  });

  it('on the cloud wire: says `use`, asks for no new security session, and logs off at the ICF', async () => {
    const { cookies } = await openedSession();
    const before = stub.requests.length;

    const conn = cloudHttp(cookies);
    await conn.connect();

    const sent = stub.requests.slice(before);
    assert.deepStrictEqual(
      sent.map((request) => request.path),
      [DISCOVERY],
    );
    assert.strictEqual(sent[0].headers['x-sap-security-session'], 'use');
    assert.strictEqual(sent[0].headers.authorization, undefined);

    await conn.disconnect();
    await conn.flushGoodbye();
    assert.strictEqual(stub.sentTo(LOGOFF).length, 1);
    assert.strictEqual(stub.sessions.size, 0);
  });
});

describe('an instance on a session that is gone', () => {
  it('rejects connect() with SAP’s 401, opens no session and logs nothing off', async () => {
    const { cookies } = await openedSession();
    stub.sessions.delete('S1');
    const before = stub.requests.length;

    const conn = onPremHttp(cookies);
    const rejected = assert.rejects(conn.connect(), (e: unknown) => {
      assertMatchObject(e, {
        response: { status: 401 },
      });
      return true;
    });
    await rejected;

    const sent = stub.requests.slice(before);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].status, 401);
    assert.strictEqual(sent[0].headers.authorization, undefined);
    assert.strictEqual(stub.sessions.size, 0);
    assert.strictEqual(conn.isConnected(), false);
    assert.strictEqual(conn.sessionCookies(), null);
  });

  it('leaves the instance spent: connect() refuses, disconnect() sends nothing', async () => {
    const { cookies } = await openedSession();
    stub.sessions.delete('S1');
    const conn = onPremHttp(cookies);
    await assert.rejects(conn.connect(), (e: unknown) => {
      assertMatchObject(e, {
        response: { status: 401 },
      });
      return true;
    });
    const before = stub.requests.length;

    await assert.rejects(conn.connect(), (e: unknown) => {
      assertMatchObject(e, {
        code: ADT_SESSION_ERROR.NOT_CONNECTED,
      });
      return true;
    });
    await conn.disconnect();
    await conn.flushGoodbye();

    assert.strictEqual(stub.requests.slice(before).length, 0);
    assert.strictEqual(stub.sessions.size, 0);
  });

  it('rejects an answer that names another session, with that answer, and sends no logoff', async () => {
    const { cookies } = await openedSession();
    stub.discovery.push({
      status: 200,
      headers: { 'set-cookie': [`${COOKIE}=S9; path=/`] },
    });
    const before = stub.requests.length;

    const conn = onPremHttp(cookies);
    await assert.rejects(conn.connect(), (e: unknown) => {
      assertMatchObject(e, { response: { status: 200 } });
      assert.ok((e as Error).message.includes('another session'));
      return true;
    });
    await conn.disconnect();
    await conn.flushGoodbye();

    assert.deepStrictEqual(
      stub.requests.slice(before).map((request) => request.path),
      [DISCOVERY],
    );
  });

  it('follows no redirect: rejects with the 302 as SAP gave it, the target never asked', async () => {
    const { cookies } = await openedSession();
    stub.discovery.push({
      status: 302,
      headers: {
        location: '/sap/public/bc/icf/login',
        'set-cookie': [`${COOKIE}=S9; path=/`],
      },
    });
    const before = stub.requests.length;

    const conn = onPremHttp(cookies);
    const rejected = assert.rejects(conn.connect(), (e: unknown) => {
      assertMatchObject(e, {
        response: {
          status: 302,
          headers: { location: '/sap/public/bc/icf/login' },
        },
      });
      return true;
    });
    await rejected;
    const afterConnect = stub.requests.length;

    assert.deepStrictEqual(
      stub.requests.slice(before).map((request) => request.path),
      [DISCOVERY],
    );
    assert.strictEqual(stub.sentTo('/sap/public/bc/icf/login').length, 0);
    assert.strictEqual(conn.isConnected(), false);
    // Spent, and nothing logged off.
    await assert.rejects(conn.connect(), (e: unknown) => {
      assertMatchObject(e, {
        code: ADT_SESSION_ERROR.NOT_CONNECTED,
      });
      return true;
    });
    await conn.disconnect();
    await conn.flushGoodbye();
    assert.strictEqual(stub.requests.length, afterConnect);
    assert.strictEqual(stub.sentTo(LOGOFF).length, 0);
  });

  it('rejects an answer without a CSRF token', async () => {
    const { cookies } = await openedSession();
    stub.discovery.push({
      status: 200,
      headers: { 'x-csrf-token': '' },
    });
    const conn = onPremHttp(cookies);
    await assert.rejects(conn.connect(), (e: unknown) => {
      assertMatchObject(e, { response: { status: 200 } });
      assert.ok((e as Error).message.includes('no CSRF token'));
      return true;
    });
  });

  it('sends nothing for cookies that name no SAP_SESSIONID', async () => {
    const before = stub.requests.length;
    const conn = onPremHttp('sap-usercontext=sap-client=100');
    await assert.rejects(conn.connect(), (e: unknown) =>
      (e as Error).message.includes('names no SAP_SESSIONID'),
    );
    assert.strictEqual(stub.requests.length, before);
  });
});

describe('what `session` may be', () => {
  it('is refused over RFC, at construction', () => {
    assert.throws(
      () =>
        // @ts-expect-error — the RFC spec takes no session.
        createConnection({
          system: 'onprem',
          transport: 'rfc',
          config: { ...config(), systemNumber: '00' } as SapConfig,
          credential: new BasicAuthProvider('u', 'p'),
          session: `${COOKIE}=S1`,
        }),
      (e: unknown) =>
        (e as Error).message.includes('an RFC session cannot be taken over'),
    );
  });

  it('is refused over RFC at connect() when the connector was built by hand, with nothing sent', async () => {
    let opened = false;
    const conn = new AdtOnPremConnector(
      config(),
      new BasicAuthProvider('u', 'p'),
      new RfcTransport(() => {
        opened = true;
        return {} as never;
      }),
      null,
      undefined,
      `${COOKIE}=S1`,
    );
    await assert.rejects(conn.connect(), (e: unknown) =>
      (e as Error).message.includes('An RFC session cannot be taken over'),
    );
    assert.strictEqual(opened, false);
  });

  it('is refused empty, at construction', () => {
    assert.throws(
      () => onPremHttp('  '),
      (e: unknown) =>
        (e as Error).message.includes('an empty one names no session'),
    );
  });
});
