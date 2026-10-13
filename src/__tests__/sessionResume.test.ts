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
import { BasicAuthProvider } from '@mcp-abap-adt/auth-providers';
import { ADT_SESSION_ERROR } from '@mcp-abap-adt/interfaces-adt-connection';
import type { SapConfig } from '../config/sapConfig.js';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import {
  type CreatedConnection,
  createConnection,
} from '../connection/createConnection.js';
import { RfcTransport } from '../connection/RfcTransport.js';
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
    expect(conn.sessionCookies()).toBeNull();
    await conn.connect();
    expect(pairs(conn.sessionCookies() ?? '')).toStrictEqual(
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
    expect(pairs(cookies)).toStrictEqual(
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
    expect(conn.sessionCookies()).toBeNull();
    expect(new RfcTransport(() => ({}) as never).sessionCookies()).toBeNull();
  });
});

describe('an instance on a live session', () => {
  it('logs on nowhere: one request, carrying the cookies and no credential', async () => {
    const { cookies } = await openedSession();
    const before = stub.requests.length;

    const conn = onPremHttp(cookies);
    await conn.connect();

    const sent = stub.requests.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0].path).toBe(DISCOVERY);
    expect(sent[0].headers['x-csrf-token']).toBe('fetch');
    expect(sent[0].headers.authorization).toBeUndefined();
    expect(pairs(sent[0].headers.cookie).has(`${COOKIE}=S1`)).toBe(true);
    // Not stateful, so not in the lock's context.
    expect(pairs(sent[0].headers.cookie).has('sap-contextid=CTX1')).toBe(false);
    // No session was opened for it.
    expect([...stub.sessions]).toStrictEqual(['S1']);
    expect(conn.isConnected()).toBe(true);
    expect(conn.getSessionIdentity()).not.toBeNull();
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
    expect(sent.map((request) => request.status)).toStrictEqual([200, 200]);
    for (const request of sent) {
      expect(pairs(request.headers.cookie).has(`${COOKIE}=S1`)).toBe(true);
      expect(request.headers.authorization).toMatch(/^Basic /);
    }
    // The PUT went with the token the takeover earned.
    expect(sent[1].headers['x-csrf-token']).toBe(stub.tokens.at(-1));
    expect([...stub.sessions]).toStrictEqual(['S1']);
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
    expect(pairs(unlock.headers.cookie).has('sap-contextid=CTX1')).toBe(true);
    expect(unlock.headers['x-sap-adt-sessiontype']).toBe('stateful');
  });

  it('logs the session off at disconnect(), as any instance does', async () => {
    const { cookies } = await openedSession();
    const conn = onPremHttp(cookies);
    await conn.connect();

    await conn.disconnect();
    await conn.flushGoodbye();

    const logoffs = stub.sentTo(LOGOFF);
    expect(logoffs).toHaveLength(1);
    expect(pairs(logoffs[0].headers.cookie).has(`${COOKIE}=S1`)).toBe(true);
    expect(stub.sessions.size).toBe(0);
  });

  it('hands out cookies that build the next instance on the same session', async () => {
    const { cookies } = await openedSession();
    const second = onPremHttp(cookies);
    await second.connect();
    const again = second.sessionCookies();
    expect(pairs(again ?? '')).toStrictEqual(pairs(cookies));

    const third = onPremHttp(again as string);
    await third.connect();
    expect(third.isConnected()).toBe(true);
    expect([...stub.sessions]).toStrictEqual(['S1']);
  });

  it('on the cloud wire: says `use`, asks for no new security session, and logs off at the ICF', async () => {
    const { cookies } = await openedSession();
    const before = stub.requests.length;

    const conn = cloudHttp(cookies);
    await conn.connect();

    const sent = stub.requests.slice(before);
    expect(sent.map((request) => request.path)).toStrictEqual([DISCOVERY]);
    expect(sent[0].headers['x-sap-security-session']).toBe('use');
    expect(sent[0].headers.authorization).toBeUndefined();

    await conn.disconnect();
    await conn.flushGoodbye();
    expect(stub.sentTo(LOGOFF)).toHaveLength(1);
    expect(stub.sessions.size).toBe(0);
  });
});

describe('an instance on a session that is gone', () => {
  it('rejects connect() with SAP’s 401, opens no session and logs nothing off', async () => {
    const { cookies } = await openedSession();
    stub.sessions.delete('S1');
    const before = stub.requests.length;

    const conn = onPremHttp(cookies);
    const rejected = expect(conn.connect()).rejects.toMatchObject({
      response: { status: 401 },
    });
    await rejected;

    const sent = stub.requests.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBe(401);
    expect(sent[0].headers.authorization).toBeUndefined();
    expect(stub.sessions.size).toBe(0);
    expect(conn.isConnected()).toBe(false);
    expect(conn.sessionCookies()).toBeNull();
  });

  it('leaves the instance spent: connect() refuses, disconnect() sends nothing', async () => {
    const { cookies } = await openedSession();
    stub.sessions.delete('S1');
    const conn = onPremHttp(cookies);
    await expect(conn.connect()).rejects.toMatchObject({
      response: { status: 401 },
    });
    const before = stub.requests.length;

    await expect(conn.connect()).rejects.toMatchObject({
      code: ADT_SESSION_ERROR.NOT_CONNECTED,
    });
    await conn.disconnect();
    await conn.flushGoodbye();

    expect(stub.requests.slice(before)).toHaveLength(0);
    expect(stub.sessions.size).toBe(0);
  });

  it('rejects an answer that names another session, with that answer, and sends no logoff', async () => {
    const { cookies } = await openedSession();
    stub.discovery.push({
      status: 200,
      headers: { 'set-cookie': [`${COOKIE}=S9; path=/`] },
    });
    const before = stub.requests.length;

    const conn = onPremHttp(cookies);
    await expect(conn.connect()).rejects.toMatchObject({
      response: { status: 200 },
      message: expect.stringContaining('another session'),
    });
    await conn.disconnect();
    await conn.flushGoodbye();

    expect(
      stub.requests.slice(before).map((request) => request.path),
    ).toStrictEqual([DISCOVERY]);
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
    const rejected = expect(conn.connect()).rejects.toMatchObject({
      response: {
        status: 302,
        headers: { location: '/sap/public/bc/icf/login' },
      },
    });
    await rejected;
    const afterConnect = stub.requests.length;

    expect(
      stub.requests.slice(before).map((request) => request.path),
    ).toStrictEqual([DISCOVERY]);
    expect(stub.sentTo('/sap/public/bc/icf/login')).toHaveLength(0);
    expect(conn.isConnected()).toBe(false);
    // Spent, and nothing logged off.
    await expect(conn.connect()).rejects.toMatchObject({
      code: ADT_SESSION_ERROR.NOT_CONNECTED,
    });
    await conn.disconnect();
    await conn.flushGoodbye();
    expect(stub.requests.length).toBe(afterConnect);
    expect(stub.sentTo(LOGOFF)).toHaveLength(0);
  });

  it('rejects an answer without a CSRF token', async () => {
    const { cookies } = await openedSession();
    stub.discovery.push({
      status: 200,
      headers: { 'x-csrf-token': '' },
    });
    const conn = onPremHttp(cookies);
    await expect(conn.connect()).rejects.toMatchObject({
      response: { status: 200 },
      message: expect.stringContaining('no CSRF token'),
    });
  });

  it('sends nothing for cookies that name no SAP_SESSIONID', async () => {
    const before = stub.requests.length;
    const conn = onPremHttp('sap-usercontext=sap-client=100');
    await expect(conn.connect()).rejects.toThrow('names no SAP_SESSIONID');
    expect(stub.requests.length).toBe(before);
  });
});

describe('what `session` may be', () => {
  it('is refused over RFC, at construction', () => {
    expect(() =>
      // @ts-expect-error — the RFC spec takes no session.
      createConnection({
        system: 'onprem',
        transport: 'rfc',
        config: { ...config(), systemNumber: '00' } as SapConfig,
        credential: new BasicAuthProvider('u', 'p'),
        session: `${COOKIE}=S1`,
      }),
    ).toThrow('an RFC session cannot be taken over');
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
    await expect(conn.connect()).rejects.toThrow(
      'An RFC session cannot be taken over',
    );
    expect(opened).toBe(false);
  });

  it('is refused empty, at construction', () => {
    expect(() => onPremHttp('  ')).toThrow('an empty one names no session');
  });
});
