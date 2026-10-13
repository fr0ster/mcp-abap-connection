/**
 * An instance built on an existing session (`session`) may be disconnected
 * WITHOUT `connect()`: `disconnect()` then logs that session off — the ICF
 * logoff with the handed cookies, as for any instance (on cloud too) — and
 * sends nothing before it: no CSRF probe, no credential, the provider's
 * `prepare()` never called. For a server ending a leftover session of a
 * process that is gone.
 *
 * Against the local SAP stand-in with `authenticate` on.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { Duplex } from 'node:stream';
import { BasicAuthProvider } from '@mcp-abap-adt/auth-providers';
import { ADT_SESSION_ERROR } from '@mcp-abap-adt/interfaces-adt-connection';
import type { SapConfig } from '../config/sapConfig.js';
import { AdtCloudConnector } from '../connection/AdtCloudConnector.js';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import { createConnection } from '../connection/createConnection.js';
import { cloudHttpTransport, onPremHttpTransport } from './helpers/onPrem.js';
import { type SapStub, startSapStub } from './helpers/sapStub.js';
import { stubProvider } from './helpers/stubProvider.js';

const LOGOFF = '/sap/public/bc/icf/logoff';
const LOCK = '/sap/bc/adt/oo/classes/zcl_x';
const COOKIE = 'SAP_SESSIONID_STUB_100';

const SPENT = {
  code: ADT_SESSION_ERROR.NOT_CONNECTED,
  message:
    "This connection's SAP session has ended (it was disconnected, logged off or lost); one connection instance is one session. Create a new connection for a new session.",
};
const TWICE = {
  code: ADT_SESSION_ERROR.NOT_CONNECTED,
  message:
    'disconnect() was already called for this connection; call it once per instance',
};

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

/** A live session with a stateful context in it, opened the ordinary way. */
async function liveSession(): Promise<string> {
  const first = createConnection({
    system: 'onprem',
    transport: 'http',
    config: config(),
    credential: new BasicAuthProvider('u', 'p'),
  });
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
  const cookies = first.sessionCookies();
  if (cookies === null) throw new Error('the first instance holds no session');
  // The first instance is left as a process killed with it would leave it:
  // never disconnected.
  return cookies;
}

function onPremOn(session: string | undefined) {
  const provider = stubProvider();
  const transport = onPremHttpTransport(config());
  const conn = new AdtOnPremConnector(
    config(),
    provider,
    transport,
    null,
    undefined,
    session,
  );
  return { conn, provider, transport };
}

function cloudOn(session: string) {
  const provider = stubProvider();
  const conn = new AdtCloudConnector(
    config(),
    provider,
    cloudHttpTransport(config()),
    null,
    undefined,
    session,
  );
  return { conn, provider };
}

const pairs = (cookie: string | undefined) =>
  new Set((cookie ?? '').split(/;\s*/).filter((pair) => pair !== ''));

describe('disconnect() without connect() on an instance built on a session', () => {
  it('sends exactly one logoff, with the session’s SAP_SESSIONID and nothing else of it', async () => {
    const session = await liveSession();
    const before = stub.requests.length;
    const { conn, provider } = onPremOn(session);

    await conn.disconnect();
    await conn.flushGoodbye();

    const sent = stub.requests.slice(before);
    expect(sent.map((request) => request.path)).toStrictEqual([LOGOFF]);
    const cookie = pairs(sent[0]?.headers.cookie);
    expect(cookie.has(`${COOKIE}=S1`)).toBe(true);
    expect([...cookie].some((pair) => pair.startsWith('sap-contextid'))).toBe(
      false,
    );
    expect(sent[0]?.headers.authorization).toBeUndefined();
    expect(sent[0]?.headers['x-csrf-token']).toBeUndefined();
    // The credential was asked nothing — prepare() above all.
    expect(provider.calls).toStrictEqual([]);
    // The session is gone on the server.
    expect(stub.sessions.has('S1')).toBe(false);
    expect(conn.isConnected()).toBe(false);
    expect(conn.sessionCookies()).toBeNull();
  });

  it('on the cloud wire: the ICF logoff, and nothing before it', async () => {
    const session = await liveSession();
    const before = stub.requests.length;
    const { conn, provider } = cloudOn(session);

    await conn.disconnect();
    await conn.flushGoodbye();

    const sent = stub.requests.slice(before);
    expect(sent.map((request) => request.path)).toStrictEqual([LOGOFF]);
    expect(pairs(sent[0]?.headers.cookie).has(`${COOKIE}=S1`)).toBe(true);
    expect(sent[0]?.headers.authorization).toBeUndefined();
    expect(provider.calls).toStrictEqual([]);
    expect(stub.sessions.has('S1')).toBe(false);
  });

  it('through createConnection, as built for a kept session', async () => {
    const session = await liveSession();
    const before = stub.requests.length;
    const conn = createConnection({
      system: 'onprem',
      transport: 'http',
      config: config(),
      credential: new BasicAuthProvider('u', 'p'),
      session,
    });

    await conn.disconnect();
    await conn.flushGoodbye();

    expect(
      stub.requests.slice(before).map((request) => request.path),
    ).toStrictEqual([LOGOFF]);
    expect(stub.sessions.has('S1')).toBe(false);
  });

  it('resolves once the logoff is written, before SAP answers; flushGoodbye() waits for the answer', async () => {
    const session = await liveSession();
    let release!: () => void;
    const answer = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived!: () => void;
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    stub.work(LOGOFF, [
      {
        status: 200,
        hold: () => {
          arrived();
          return answer;
        },
      },
    ]);
    const { conn } = onPremOn(session);

    await conn.disconnect();
    await reached;

    let flushed = false;
    const flush = conn.flushGoodbye().then(() => {
      flushed = true;
    });
    // The answer is held: flushGoodbye() has not settled.
    for (let turn = 0; turn < 20; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(flushed).toBe(false);

    release();
    await flush;
    expect(flushed).toBe(true);
  });

  it('does not resolve before the logoff is written', async () => {
    const session = await liveSession();
    const { conn, transport } = onPremOn(session);
    const never = bytesNeverTaken(transport);

    let settled = false;
    const disconnected = conn.disconnect().then(() => {
      settled = true;
    });
    await never.requested;
    for (let turn = 0; turn < 20; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(settled).toBe(false);

    // The socket fails: logged, not thrown, and disconnect() settles.
    never.fail();
    await disconnected;
    expect(settled).toBe(true);
  });

  it('is once: a second disconnect() rejects, and connect() after it is refused', async () => {
    const session = await liveSession();
    const { conn, provider } = onPremOn(session);

    await conn.disconnect();
    await expect(conn.disconnect()).rejects.toMatchObject(TWICE);
    await expect(conn.connect()).rejects.toMatchObject(SPENT);
    await conn.flushGoodbye();

    expect(stub.sentTo(LOGOFF)).toHaveLength(1);
    expect(provider.calls).toStrictEqual([]);
  });

  it('sends nothing when the string names no SAP_SESSIONID, and the instance is spent', async () => {
    const before = stub.requests.length;
    const { conn, provider } = onPremOn(
      'sap-usercontext=sap-client=100; sap-contextid=CTX1',
    );

    await conn.disconnect();
    await conn.flushGoodbye();

    expect(stub.requests.length).toBe(before);
    expect(provider.calls).toStrictEqual([]);
    await expect(conn.connect()).rejects.toMatchObject(SPENT);
  });

  it('an instance built without a session still sends nothing', async () => {
    await liveSession();
    const before = stub.requests.length;
    const { conn, provider } = onPremOn(undefined);

    await conn.disconnect();
    await conn.flushGoodbye();

    expect(stub.requests.length).toBe(before);
    expect(provider.calls).toStrictEqual([]);
    await expect(conn.connect()).rejects.toMatchObject(SPENT);
    // The other process's session is untouched.
    expect(stub.sessions.has('S1')).toBe(true);
  });

  it('after connect() took the session over, logs it off once, as before', async () => {
    const session = await liveSession();
    const { conn } = onPremOn(session);
    await conn.connect();

    await conn.disconnect();
    await conn.flushGoodbye();

    expect(stub.sentTo(LOGOFF)).toHaveLength(1);
    expect(stub.sessions.has('S1')).toBe(false);
  });
});

/**
 * Sends the wire's logoffs over a socket that accepts nothing: every write
 * stays pending, so no request's `finish` comes. Destroying it fails them.
 */
function bytesNeverTaken(transport: unknown): {
  fail: () => void;
  requested: Promise<void>;
} {
  let opened!: () => void;
  const requested = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const socket = new Duplex({
    read() {},
    write(_chunk, _encoding, _done) {
      // never done
    },
  });
  Object.assign(socket, {
    setNoDelay: () => socket,
    setKeepAlive: () => socket,
    setTimeout: () => socket,
    ref: () => socket,
    unref: () => socket,
  });
  (
    transport as {
      logoffRequest: (
        options: Record<string, unknown>,
        onResponse: (response: IncomingMessage) => void,
      ) => unknown;
    }
  ).logoffRequest = (options, onResponse) => {
    opened();
    return httpRequest(
      { ...options, agent: undefined, createConnection: () => socket } as never,
      onResponse,
    );
  };
  return {
    fail: () => socket.destroy(new Error('the server never took the bytes')),
    requested,
  };
}
