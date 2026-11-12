/**
 * A stateless request keeps its answer when the SAP session was replaced
 * (fr0ster/mcp-abap-adt#354).
 *
 * SAP replaces an idle session behind a connection; the next request's answer
 * carries a new `SAP_SESSIONID`. For a stateless request that answer is SAP's
 * and is returned — a success resolves, a refusal rejects as itself — marked
 * `sessionLost`, with the session already lost and nothing sent again. A
 * stateful request keeps failing with `ADT_SESSION_REPLACED`. What the
 * connection does on its own exchanges, at `connect()`, on resume and on a
 * session-dead page is unchanged, and pinned here first.
 *
 * A real `OnPremHttpTransport` against the local SAP stand-in: every request
 * is recorded, so each case counts what was sent.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { BasicAuthProvider } from '@mcp-abap-adt/auth-providers';
import {
  ADT_SESSION_ERROR,
  type IAdtWireResponse,
} from '@mcp-abap-adt/interfaces-adt-connection';
import type { AuthOutcome } from '@mcp-abap-adt/interfaces-auth';
import type { ISapRfcConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import type { SapHttpConfig } from '../../config/sapConfig.js';
import { AdtCloudConnector } from '../../connection/AdtCloudConnector.js';
import { AdtOnPremConnector } from '../../connection/AdtOnPremConnector.js';
import { OnPremHttpTransport } from '../../connection/OnPremHttpTransport.js';
import { RfcTransport } from '../../connection/RfcTransport.js';
import { assertMatchObject } from '../helpers/assertions.js';
import { cloudHttpTransport } from '../helpers/onPrem.js';
import { standInFactory } from '../helpers/rfcStandIn.js';
import { type SapStub, startSapStub } from '../helpers/sapStub.js';
import { type StubScript, stubProvider } from '../helpers/stubProvider.js';

const WORK = '/sap/bc/adt/work';
const OTHER = '/sap/bc/adt/other';
const DISCOVERY = '/sap/bc/adt/core/discovery';
const LOGOFF = '/sap/public/bc/icf/logoff';
const SESSIONS = '/sap/bc/adt/core/http/sessions';
const COOKIE = 'SAP_SESSIONID_STUB_100';
const REPLACING = `${COOKIE}=R1; Path=/`;
const REPLACED = ADT_SESSION_ERROR.SESSION_REPLACED;
const OK: AuthOutcome = { ok: true };

let stub: SapStub;

beforeEach(async () => {
  stub = await startSapStub();
});

afterEach(async () => {
  await stub.close();
});

function config(): SapHttpConfig {
  return {
    url: stub.baseUrl,
    client: '100',
    authType: 'basic',
    username: 'u',
    password: 'p',
  };
}

/** A connected on-prem instance over the real HTTP wire, its provider recording. */
async function connected(script: StubScript = {}) {
  const provider = stubProvider(script);
  const transport = new OnPremHttpTransport(() => ({}), null, {
    client: '100',
    baseUrl: stub.baseUrl,
  });
  const conn = new AdtOnPremConnector(config(), provider, transport, null);
  await conn.connect();
  const rejected = () =>
    provider.calls.filter((call) => call.method === 'rejected').length;
  return { conn, transport, rejected };
}

/** What a request sent: the work requests to `path`, discoveries and logoffs. */
function counts(path = WORK) {
  return {
    work: stub.sentTo(path).length,
    discovery: stub.sentTo(DISCOVERY).length,
    logoff: stub.sentTo(LOGOFF).length,
  };
}

/** The `sessionLost` an error carries as its own property, if any. */
function markOf(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  return Object.getOwnPropertyDescriptor(error, 'sessionLost')?.value;
}

/** The caller's settled answer: the resolved response or the rejection. */
async function settle(
  sending: Promise<IAdtWireResponse>,
): Promise<{ response?: IAdtWireResponse; error?: unknown }> {
  try {
    return { response: await sending };
  } catch (error) {
    return { error };
  }
}

const get = (
  conn: AdtOnPremConnector,
  path = WORK,
  headers?: Record<string, string>,
) =>
  conn.makeAdtRequest({
    url: path,
    method: 'GET',
    timeout: 0,
    ...(headers ? { headers } : {}),
  });

const post = (conn: AdtOnPremConnector, path = WORK) =>
  conn.makeAdtRequest({ url: path, method: 'POST', timeout: 0, data: 'x' });

/** Runs `send` as a stateful request: by the session mode, as adt-clients does. */
async function statefully<T>(
  conn: AdtOnPremConnector,
  send: () => Promise<T>,
): Promise<T> {
  conn.setSessionType('stateful');
  try {
    return await send();
  } finally {
    conn.setSessionType('stateless');
  }
}

/**
 * A request to `path` the stand-in holds: `arrived` settles when it reaches
 * the server, and the answer leaves when `release` is called.
 */
function held(path: string, answer: { status: number; body?: string }) {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrive: () => void = () => {};
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  stub.work(path, [
    {
      ...answer,
      hold: () => {
        arrive();
        return released;
      },
    },
  ]);
  return { arrived, release };
}

function assertReplaced(error: unknown): void {
  assertMatchObject(error, { code: REPLACED });
  assert.strictEqual(markOf(error), undefined);
}

/**
 * The replacing session's logoff reached the server, carrying its cookie —
 * awaited through `flushGoodbye()`, which settles on the logoff's answer.
 */
async function assertReplacingLoggedOff(
  conn: AdtOnPremConnector,
  before: number,
): Promise<void> {
  await conn.flushGoodbye();
  const logoffs = stub.sentTo(LOGOFF);
  assert.strictEqual(logoffs.length, before + 1);
  assert.ok(logoffs.at(-1)?.headers.cookie?.includes(`${COOKIE}=R1`));
}

// ---------------------------------------------------------------------------
// Pinned first: what does not change.
// ---------------------------------------------------------------------------

describe('unchanged: the exchanges inside a request', () => {
  it('the upfront token fetch answered by a new session: ADT_SESSION_REPLACED, nothing of the request sent', async () => {
    const { conn, transport } = await connected();
    transport.adoptCsrfToken(null);
    stub.sessions.clear();

    const { error } = await settle(post(conn));

    assertReplaced(error);
    assert.strictEqual(conn.isConnected(), false);
    assert.strictEqual(counts().work, 0);
  });

  it('the upfront token fetch refused with a new session: ADT_SESSION_REPLACED, nothing of the request sent', async () => {
    const { conn, transport } = await connected();
    transport.adoptCsrfToken(null);
    stub.discovery.push({ status: 500, headers: { 'set-cookie': REPLACING } });

    const { error } = await settle(post(conn));

    assertReplaced(error);
    assert.strictEqual(conn.isConnected(), false);
    assert.strictEqual(counts().work, 0);
  });

  it("the CSRF retry's fetch answered by a new session: ADT_SESSION_REPLACED, the request not resent", async () => {
    const { conn } = await connected();
    stub.work(WORK, [
      {
        status: 403,
        body: 'CSRF token validation failed',
        hold: async () => {
          stub.sessions.clear();
        },
      },
    ]);

    const { error } = await settle(post(conn));

    assertReplaced(error);
    assert.strictEqual(counts().work, 1);
  });

  it("the CSRF retry's fetch refused with a new session: ADT_SESSION_REPLACED, the request not resent", async () => {
    const { conn } = await connected();
    stub.work(WORK, [{ status: 403, body: 'CSRF token validation failed' }]);
    stub.discovery.push({ status: 500, headers: { 'set-cookie': REPLACING } });

    const { error } = await settle(post(conn));

    assertReplaced(error);
    assert.strictEqual(counts().work, 1);
  });

  it('the logon after a refused logon answered by a new session: ADT_SESSION_REPLACED, the request not resent', async () => {
    const { conn, rejected } = await connected({ rejected: [OK] });
    stub.work(WORK, [{ status: 403, body: 'CSRF token validation failed' }]);
    stub.discovery.push({
      status: 401,
      hold: async () => {
        stub.sessions.clear();
      },
    });

    const { error } = await settle(post(conn));

    assertReplaced(error);
    assert.strictEqual(rejected(), 1);
    assert.strictEqual(counts().work, 1);
  });

  it('the logon after a refused logon refused with a new session: ADT_SESSION_REPLACED, the request not resent', async () => {
    const { conn, rejected } = await connected({ rejected: [OK] });
    stub.work(WORK, [{ status: 403, body: 'CSRF token validation failed' }]);
    stub.discovery.push(401, {
      status: 500,
      headers: { 'set-cookie': REPLACING },
    });

    const { error } = await settle(post(conn));

    assertReplaced(error);
    assert.strictEqual(rejected(), 1);
    assert.strictEqual(counts().work, 1);
  });
});

describe('unchanged: connect() and the cloud preflight', () => {
  const SESSION_DOCUMENT =
    '<http:session xmlns:http="http://www.sap.com/adt/http" xmlns:atom="http://www.w3.org/2005/Atom">' +
    '<atom:link href="/sap/bc/adt/core/http/sessions/ABC" rel="http://www.sap.com/adt/categories/core/http/sessions/securitysession"/>' +
    '</http:session>';

  function cloud(): AdtCloudConnector {
    return new AdtCloudConnector(
      config(),
      new BasicAuthProvider('u', 'p'),
      cloudHttpTransport(config()),
      null,
    );
  }

  it('connects when its open and its establishment each bring a new SAP_SESSIONID', async () => {
    stub.work(SESSIONS, [
      {
        status: 200,
        body: SESSION_DOCUMENT,
        headers: { 'set-cookie': `${COOKIE}=P1; Path=/` },
      },
    ]);
    const conn = cloud();

    await conn.connect();

    assert.strictEqual(conn.isConnected(), true);
    assert.ok(conn.sessionCookies()?.includes(`${COOKIE}=S1`));
    await conn.disconnect();
  });

  it('absorbs a preflight refused with a new SAP_SESSIONID, and connects', async () => {
    stub.work(SESSIONS, [
      { status: 500, headers: { 'set-cookie': `${COOKIE}=P1; Path=/` } },
    ]);
    const conn = cloud();

    await conn.connect();

    assert.strictEqual(conn.isConnected(), true);
    assert.ok(conn.sessionCookies()?.includes(`${COOKIE}=S1`));
    await conn.disconnect();
  });
});

describe('unchanged: the session-dead pages', () => {
  for (const phrase of [
    'Session not found',
    'Session Timed Out or Not Found',
    'Session no longer exists',
  ]) {
    for (const stateful of [false, true]) {
      it(`a 400 "${phrase}" (${stateful ? 'stateful' : 'stateless'}): ADT_SESSION_REPLACED, no logoff`, async () => {
        const { conn } = await connected();
        stub.work(WORK, [
          { status: 400, body: `<html><body>${phrase}</body></html>` },
        ]);

        const sending = () => get(conn);
        const { error } = await settle(
          stateful ? statefully(conn, sending) : sending(),
        );

        assertReplaced(error);
        assert.strictEqual(conn.isConnected(), false);
        assert.strictEqual(counts().logoff, 0);
        assert.strictEqual(counts().work, 1);
      });
    }
  }
});

describe('unchanged: answers that show no replacement', () => {
  for (const stateful of [false, true]) {
    const mode = stateful ? 'stateful' : 'stateless';

    it(`an unchanged SAP_SESSIONID (${mode}): the answer as it came, no mark`, async () => {
      const { conn } = await connected();
      stub.work(WORK, [{ status: 200, body: 'payload' }]);

      const sending = () => get(conn);
      const response = await (stateful ? statefully(conn, sending) : sending());

      assert.strictEqual(response.data, 'payload');
      assert.strictEqual(Object.hasOwn(response, 'sessionLost'), false);
      assert.strictEqual(conn.isConnected(), true);
    });

    it(`a newly established SAP_SESSIONID (${mode}): the answer as it came, no mark`, async () => {
      const { conn } = await connected();
      stub.work(WORK, [
        {
          status: 200,
          body: 'payload',
          headers: { 'set-cookie': 'SAP_SESSIONID_OTHER_200=E1; Path=/' },
        },
      ]);

      const sending = () => get(conn);
      const response = await (stateful ? statefully(conn, sending) : sending());

      assert.strictEqual(response.data, 'payload');
      assert.strictEqual(Object.hasOwn(response, 'sessionLost'), false);
      assert.strictEqual(conn.isConnected(), true);
    });
  }
});

describe('unchanged: a request whose lease went stale', () => {
  it('a success answered after the loss is returned as it came, unmarked, and nothing more is acted on', async () => {
    const { conn } = await connected();
    const { arrived, release } = held(OTHER, { status: 200, body: 'late' });
    stub.work(WORK, [
      { status: 200, body: 'payload', headers: { 'set-cookie': REPLACING } },
    ]);

    const late = get(conn, OTHER);
    // The held request is in flight before the replacing one is sent.
    await arrived;
    await settle(get(conn));
    const logoffs = counts().logoff;
    release();
    const response = await late;

    assert.strictEqual(response.data, 'late');
    assert.strictEqual(Object.hasOwn(response, 'sessionLost'), false);
    assert.strictEqual(counts().logoff, logoffs);
  });

  it('a refusal answered after the loss rejects as itself, unmarked', async () => {
    const { conn } = await connected();
    const { arrived, release } = held(OTHER, { status: 404 });
    stub.work(WORK, [
      { status: 200, body: 'payload', headers: { 'set-cookie': REPLACING } },
    ]);

    const late = settle(get(conn, OTHER));
    await arrived;
    await settle(get(conn));
    release();
    const { error } = await late;

    assertMatchObject(error, { response: { status: 404 } });
    assert.strictEqual(markOf(error), undefined);
  });
});

describe('unchanged: RFC answers carry no mark', () => {
  const rfcConfig: ISapRfcConfig = {
    connectionType: 'rfc',
    authType: 'basic',
    ashost: 'saphost',
    sysnr: '00',
    client: '100',
    language: 'EN',
  };

  for (const stateful of [false, true]) {
    it(`a ${stateful ? 'stateful' : 'stateless'} request over RFC`, async () => {
      const { factory } = standInFactory([], true);
      const conn = new AdtOnPremConnector(
        rfcConfig,
        new BasicAuthProvider('USER', 'PASS'),
        new RfcTransport(factory),
        null,
      );
      await conn.connect();
      if (stateful) conn.setSessionType('stateful');

      const response = await conn.makeAdtRequest({
        url: WORK,
        method: 'GET',
        timeout: 0,
      });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(Object.hasOwn(response, 'sessionLost'), false);
      await conn.disconnect();
    });
  }
});

// ---------------------------------------------------------------------------
// The change: a stateless request keeps the answer that showed the replacement.
// ---------------------------------------------------------------------------

describe('a success that shows the replacement', () => {
  /** Each attempt that carries the caller's request, answering 200 with a new session. */
  const attempts: {
    name: string;
    script?: StubScript;
    queue: () => void;
    send: (conn: AdtOnPremConnector) => Promise<IAdtWireResponse>;
    works: number;
  }[] = [
    {
      name: 'the first attempt',
      queue: () =>
        stub.work(WORK, [
          {
            status: 200,
            body: 'payload',
            headers: { 'set-cookie': REPLACING },
          },
        ]),
      send: (conn) => get(conn),
      works: 1,
    },
    {
      name: "the CSRF retry's resend",
      queue: () =>
        stub.work(WORK, [
          { status: 403, body: 'CSRF token validation failed' },
          {
            status: 200,
            body: 'payload',
            headers: { 'set-cookie': REPLACING },
          },
        ]),
      send: (conn) => post(conn),
      works: 2,
    },
    {
      name: 'the resend after a credential renewal',
      script: { rejected: [OK] },
      queue: () =>
        stub.work(WORK, [
          401,
          {
            status: 200,
            body: 'payload',
            headers: { 'set-cookie': REPLACING },
          },
        ]),
      send: (conn) => get(conn),
      works: 2,
    },
  ];

  for (const attempt of attempts) {
    it(`on ${attempt.name}, stateless: resolves that answer, marked; nothing sent after it`, async () => {
      const { conn } = await connected(attempt.script);
      attempt.queue();
      const before = counts();

      const response = await attempt.send(conn);

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.data, 'payload');
      assert.strictEqual(response.sessionLost, REPLACED);
      assert.strictEqual(counts().work - before.work, attempt.works);
      await assertReplacingLoggedOff(conn, before.logoff);
    });

    it(`on ${attempt.name}, stateful: ADT_SESSION_REPLACED; nothing sent after it`, async () => {
      const { conn } = await connected(attempt.script);
      attempt.queue();
      const before = counts();

      const { error } = await settle(
        statefully(conn, () => attempt.send(conn)),
      );

      assertReplaced(error);
      assert.strictEqual(counts().work - before.work, attempt.works);
      await assertReplacingLoggedOff(conn, before.logoff);
    });
  }

  it("stateful by the caller's own header: ADT_SESSION_REPLACED", async () => {
    const { conn } = await connected();
    stub.work(WORK, [
      { status: 200, body: 'payload', headers: { 'set-cookie': REPLACING } },
    ]);

    const { error } = await settle(
      get(conn, WORK, { 'x-sap-adt-sessiontype': 'stateful' }),
    );

    assertReplaced(error);
    assert.strictEqual(counts().work, 1);
  });
});

describe('the session is lost before the caller has the answer', () => {
  function replacingAnswer(): void {
    stub.work(WORK, [
      { status: 200, body: 'payload', headers: { 'set-cookie': REPLACING } },
    ]);
  }

  it('in the first continuation: not connected, no cookies, the replacing session logged off', async () => {
    const { conn, transport } = await connected();
    replacingAnswer();
    const close = mock.method(transport, 'close');

    const seen = await get(conn).then((response) => ({
      mark: response.sessionLost,
      connected: conn.isConnected(),
      cookies: conn.sessionCookies(),
      closes: close.mock.callCount(),
    }));

    assert.deepStrictEqual(seen, {
      mark: REPLACED,
      connected: false,
      cookies: null,
      closes: 1,
    });
    await assertReplacingLoggedOff(conn, 0);
  });

  it('the next request is NOT_CONNECTED with nothing sent; disconnect() and flushGoodbye() settle', async () => {
    const { conn } = await connected();
    replacingAnswer();
    await get(conn);
    const sent = stub.requests.length;

    const { error } = await settle(get(conn));

    assertMatchObject(error, { code: ADT_SESSION_ERROR.NOT_CONNECTED });
    assert.strictEqual(stub.requests.length, sent);
    await conn.disconnect();
    await conn.flushGoodbye();
    assert.strictEqual(counts().logoff, 1);
  });

  const ways: ('rejects' | 'throws')[] = ['rejects', 'throws'];
  for (const how of ways) {
    it(`a logoff whose close ${how} does not take the answer from the caller`, async () => {
      const { conn, transport } = await connected();
      replacingAnswer();
      mock.method(transport, 'close', () => {
        if (how === 'throws') throw new Error('close threw');
        return Promise.reject(new Error('close rejected'));
      });

      const response = await get(conn);

      assert.strictEqual(response.data, 'payload');
      assert.strictEqual(response.sessionLost, REPLACED);
      assert.strictEqual(conn.isConnected(), false);
      await conn.disconnect();
    });
  }
});

describe('a refusal that shows the replacement, on the first attempt', () => {
  const refusals: {
    name: string;
    status: number;
    body?: string;
    send: (conn: AdtOnPremConnector) => Promise<IAdtWireResponse>;
  }[] = [
    { name: '404', status: 404, send: (conn) => get(conn) },
    { name: '423', status: 423, send: (conn) => post(conn) },
    {
      name: '403 "CSRF token validation failed"',
      status: 403,
      body: 'CSRF token validation failed',
      send: (conn) => post(conn),
    },
    { name: '401', status: 401, send: (conn) => get(conn) },
    {
      name: '400 that also says the session is gone',
      status: 400,
      body: '<html><body>Session no longer exists</body></html>',
      send: (conn) => get(conn),
    },
  ];

  for (const refusal of refusals) {
    const queue = () =>
      stub.work(WORK, [
        {
          status: refusal.status,
          body: refusal.body ?? '',
          headers: { 'set-cookie': REPLACING },
        },
      ]);

    it(`a ${refusal.name}, stateless: rejects as itself, marked; no retry, no renewal, nothing sent after it`, async () => {
      const { conn, rejected } = await connected({ rejected: [OK] });
      queue();
      const before = counts();

      const { error } = await settle(refusal.send(conn));

      assertMatchObject(error, {
        code: 'ERR_BAD_REQUEST',
        response: { status: refusal.status },
      });
      assert.strictEqual(markOf(error), REPLACED);
      assert.strictEqual(rejected(), 0);
      assert.strictEqual(counts().work - before.work, 1);
      assert.strictEqual(counts().discovery, before.discovery);
      assert.strictEqual(conn.isConnected(), false);
      await assertReplacingLoggedOff(conn, before.logoff);
    });

    it(`a ${refusal.name}, stateful: ADT_SESSION_REPLACED; nothing sent after it`, async () => {
      const { conn, rejected } = await connected({ rejected: [OK] });
      queue();
      const before = counts();

      const { error } = await settle(
        statefully(conn, () => refusal.send(conn)),
      );

      assertReplaced(error);
      assert.strictEqual(rejected(), 0);
      assert.strictEqual(counts().work - before.work, 1);
      assert.strictEqual(counts().discovery, before.discovery);
    });
  }
});

describe('a refusal that shows the replacement, on a resend', () => {
  const resends: {
    name: string;
    script?: StubScript;
    queue: () => void;
    send: (conn: AdtOnPremConnector) => Promise<IAdtWireResponse>;
    renewals: number;
  }[] = [
    {
      name: "the CSRF retry's resend",
      queue: () =>
        stub.work(WORK, [
          { status: 403, body: 'CSRF token validation failed' },
          { status: 404, headers: { 'set-cookie': REPLACING } },
        ]),
      send: (conn) => post(conn),
      renewals: 0,
    },
    {
      name: 'the resend after a credential renewal',
      script: { rejected: [OK] },
      queue: () =>
        stub.work(WORK, [
          401,
          { status: 404, headers: { 'set-cookie': REPLACING } },
        ]),
      send: (conn) => get(conn),
      renewals: 1,
    },
  ];

  for (const resend of resends) {
    it(`on ${resend.name}, stateless: rejects that refusal, marked — not the first attempt's error; nothing sent after it`, async () => {
      const { conn, rejected } = await connected(resend.script);
      resend.queue();
      const before = counts();

      const { error } = await settle(resend.send(conn));

      assertMatchObject(error, { response: { status: 404 } });
      assert.strictEqual(markOf(error), REPLACED);
      assert.strictEqual(rejected(), resend.renewals);
      assert.strictEqual(counts().work - before.work, 2);
      await assertReplacingLoggedOff(conn, before.logoff);
    });

    it(`on ${resend.name}, stateful: ADT_SESSION_REPLACED; nothing sent after it`, async () => {
      const { conn, rejected } = await connected(resend.script);
      resend.queue();
      const before = counts();

      const { error } = await settle(statefully(conn, () => resend.send(conn)));

      assertReplaced(error);
      assert.strictEqual(rejected(), resend.renewals);
      assert.strictEqual(counts().work - before.work, 2);
      await assertReplacingLoggedOff(conn, before.logoff);
    });
  }
});

describe('attribution', () => {
  it('only the request whose answer showed the replacement is marked', async () => {
    const { conn } = await connected();
    const { arrived, release } = held(OTHER, { status: 200, body: 'late' });
    stub.work(WORK, [
      { status: 200, body: 'payload', headers: { 'set-cookie': REPLACING } },
    ]);

    const late = get(conn, OTHER);
    await arrived;
    const replacing = await get(conn);
    release();
    const other = await late;

    assert.strictEqual(replacing.sessionLost, REPLACED);
    assert.strictEqual(Object.hasOwn(other, 'sessionLost'), false);
  });
});
