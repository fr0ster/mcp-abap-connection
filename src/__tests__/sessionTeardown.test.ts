/**
 * disconnect() ends the session on the server, not only in the client.
 *
 * Dropping the cookie leaves the ABAP session alive until its own timeout, and
 * a process that connects repeatedly leaves one behind every time. Once enough
 * pile up the server stops issuing sessions at all — it answers with the XSRF
 * cookie instead — and a connection without a session still gets `200` for a
 * LOCK, handing back a handle the next request cannot use.
 */

import assert from 'node:assert/strict';
import { describe, it, type Mock, mock } from 'node:test';
import { TokenAuthProvider } from '@mcp-abap-adt/auth-providers';
import type { SapConfig } from '../config/sapConfig.js';
import { AdtCloudConnector } from '../connection/AdtCloudConnector.js';
import type { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import type { ILogger } from '../logger.js';
import { assertMatchObject } from './helpers/assertions.js';
import { reportableLogoff, wroteIt } from './helpers/logoffWrite.js';
import { cloudHttpTransport, onPrem } from './helpers/onPrem.js';
import { settled } from './helpers/settled.js';

const baseConfig: SapConfig = {
  url: 'https://sap.example.com',
  authType: 'basic',
  username: 'u',
  password: 'p',
  client: '100',
};

function makeLogger(): ILogger {
  return {
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
    debug: mock.fn(),
  };
}

type Seen = {
  url: string;
  method: string;
  headers: Record<string, string>;
  timeout?: number;
};

function attachMockAxios(
  conn: AdtOnPremConnector,
  seen: Seen[],
  answer: (cfg: any) => Promise<any> = async () => ({
    status: 200,
    data: '<service/>',
    headers: {
      'x-csrf-token': 'TOKEN',
      'set-cookie': ['SAP_SESSIONID_STUB_100=abc%3d; path=/'],
    },
  }),
): void {
  const instance = async (cfg: any) => {
    seen.push({
      url: cfg.url,
      method: cfg.method,
      headers: cfg.headers ?? {},
      timeout: cfg.timeout,
    });
    wroteIt(cfg);
    return answer(cfg);
  };
  // clearSessionState() detaches interceptors before dropping the instance, so
  // the double has to carry them — the earlier doubles never reached teardown.
  (instance as any).interceptors = {
    request: { clear: mock.fn() },
    response: { clear: mock.fn() },
  };
  (conn as any).transport.instance = instance;
  reportableLogoff((conn as any).transport);
}

/**
 * On-prem and cloud do not manage sessions the same way, and the two
 * implementations exist for that reason. Which one is used is decided by the
 * connection — not discovered by asking the server, which was tried and is
 * wrong: `/sap/bc/adt/core/http/sessions` answers on on-prem too, so a probe
 * tells the two systems apart not at all. It only says whether an endpoint
 * exists, and both have it.
 */
describe('the session mechanism is chosen by the connection, not probed', () => {
  it('on-prem keeps the platform logoff, even where the session resource answers', async () => {
    const conn = onPrem(baseConfig, makeLogger());
    const seen: Seen[] = [];
    // A system that publishes BOTH — which is what S/4HANA on-prem does.
    attachMockAxios(conn, seen, async () => ({
      status: 200,
      data: '<http:session><atom:link href="/sap/bc/adt/core/http/sessions/ABC" rel="http://www.sap.com/adt/categories/core/http/sessions/securitysession"/></http:session>',
      headers: {
        'x-csrf-token': 'TOKEN',
        'set-cookie': ['SAP_SESSIONID_STUB_100=abc%3d; path=/'],
      },
    }));

    await conn.connect();
    await conn.disconnect();
    await settled();

    // Nothing was asked of the session resource, and the goodbye is the ICF one.
    assert.strictEqual(
      seen.some((r) => r.url.includes('/core/http/sessions')),
      false,
    );
    assert.strictEqual(
      seen.some(
        (r) =>
          r.url.includes('/sap/public/bc/icf/logoff') && r.method === 'GET',
      ),
      true,
    );
  });

  it('cloud opens the session resource and gives it back through the logoff it links to', async () => {
    const conn = new AdtCloudConnector(
      { ...baseConfig, authType: 'jwt', jwtToken: 'TOKEN' } as never,
      TokenAuthProvider.fixed('TOKEN'),
      cloudHttpTransport(
        { ...baseConfig, authType: 'jwt', jwtToken: 'TOKEN' } as never,
        makeLogger(),
      ),
      makeLogger(),
    );
    const seen: Seen[] = [];
    attachMockAxios(conn as never, seen, async () => ({
      status: 200,
      data: '<http:session xmlns:http="http://www.sap.com/adt/http" xmlns:atom="http://www.w3.org/2005/Atom"><atom:link href="/sap/bc/adt/core/http/sessions/ABC" rel="http://www.sap.com/adt/categories/core/http/sessions/securitysession"/><atom:link href="/sap/public/bc/icf/logoff" rel="http://www.sap.com/adt/categories/core/http/sessions/logoff"/></http:session>',
      headers: {
        'x-csrf-token': 'TOKEN',
        'set-cookie': ['SAP_SESSIONID_STUB_100=abc%3d; path=/'],
      },
    }));

    await conn.connect();
    await conn.disconnect();
    await settled();

    assert.strictEqual(
      seen.some((r) => r.url.includes('/core/http/sessions')),
      true,
    );
    const goodbye = seen.find((r) =>
      r.url.includes('/sap/public/bc/icf/logoff'),
    );
    assert.strictEqual(goodbye?.method, 'GET');
    assert.ok(goodbye?.headers.Cookie.includes('SAP_SESSIONID_STUB_100'));
    assert.strictEqual(goodbye?.headers['x-sap-security-session'], 'use');
    assert.strictEqual(goodbye?.headers.Authorization, undefined);
    assert.strictEqual(goodbye?.headers.Accept, '*/*');
    assert.strictEqual(goodbye?.headers['sap-cancel-on-close'], 'true');
    assert.match(goodbye?.headers['sap-adt-request-id'], /^[0-9a-f]{32}$/);
    // Never the DELETE on the session's own address: from inside that session
    // it answers 200 and ends nothing (measured on a BTP trial, 2026-10-12).
    assert.strictEqual(
      seen.some((r) => r.method === 'DELETE'),
      false,
    );
  });

  it('cloud ends a session the server linked no logoff for with the platform logoff, without sap-contextid, resolving on the write', async () => {
    const logger = makeLogger();
    const conn = new AdtCloudConnector(
      { ...baseConfig, authType: 'jwt', jwtToken: 'TOKEN' } as never,
      TokenAuthProvider.fixed('TOKEN'),
      cloudHttpTransport(
        { ...baseConfig, authType: 'jwt', jwtToken: 'TOKEN' } as never,
        logger,
      ),
      makeLogger(),
    );
    const seen: Seen[] = [];
    attachMockAxios(conn as never, seen, async (cfg) =>
      // The logoff's answer never comes: disconnect() resolves on its write.
      String(cfg.url).includes('/icf/logoff')
        ? new Promise(() => {})
        : {
            status: 200,
            data: '<http:session xmlns:http="http://www.sap.com/adt/http" xmlns:atom="http://www.w3.org/2005/Atom"><atom:link href="/sap/bc/adt/core/http/sessions/ABC" rel="http://www.sap.com/adt/categories/core/http/sessions/securitysession"/></http:session>',
            headers: {
              'x-csrf-token': 'TOKEN',
              'set-cookie': [
                'SAP_SESSIONID_STUB_100=abc%3d; path=/',
                'sap-contextid=CTX; path=/',
              ],
            },
          },
    );

    await conn.connect();
    const before = seen.length;
    await conn.disconnect();
    await settled();

    const sent = seen.slice(before);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0]?.method, 'GET');
    assert.strictEqual(
      sent[0]?.url,
      'https://sap.example.com/sap/public/bc/icf/logoff',
    );
    assert.ok(sent[0]?.headers.Cookie.includes('SAP_SESSIONID_STUB_100'));
    assert.ok(!sent[0]?.headers.Cookie.includes('sap-contextid'));
    assert.strictEqual(sent[0]?.headers['x-sap-security-session'], undefined);
    assert.strictEqual(sent[0]?.headers.Authorization, undefined);
    assert.ok(
      (
        logger.debug as unknown as Mock<(...args: any[]) => void>
      ).mock.calls.some(
        ({ arguments: args }) =>
          args.length === 1 &&
          typeof args[0] === 'string' &&
          args[0].includes('published no logoff resource'),
      ),
    );
  });
});

describe('the cloud logoff link', () => {
  function cloudWithLogoffHref(href: string, logger: ILogger, seen: Seen[]) {
    const conn = new AdtCloudConnector(
      { ...baseConfig, authType: 'jwt', jwtToken: 'TOKEN' } as never,
      TokenAuthProvider.fixed('TOKEN'),
      cloudHttpTransport(
        { ...baseConfig, authType: 'jwt', jwtToken: 'TOKEN' } as never,
        logger,
      ),
      makeLogger(),
    );
    attachMockAxios(conn as never, seen, async () => ({
      status: 200,
      data: `<http:session xmlns:http="http://www.sap.com/adt/http" xmlns:atom="http://www.w3.org/2005/Atom"><atom:link href="/sap/bc/adt/core/http/sessions/ABC" rel="http://www.sap.com/adt/categories/core/http/sessions/securitysession"/><atom:link href="${href}" rel="http://www.sap.com/adt/categories/core/http/sessions/logoff"/></http:session>`,
      headers: {
        'x-csrf-token': 'TOKEN',
        'set-cookie': ['SAP_SESSIONID_STUB_100=abc%3d; path=/'],
      },
    }));
    return conn;
  }

  it('resolves a relative href against the session document, as an Atom link is', async () => {
    const seen: Seen[] = [];
    const conn = cloudWithLogoffHref('logoff', makeLogger(), seen);

    await conn.connect();
    await conn.disconnect();
    await settled();

    assert.strictEqual(
      seen.at(-1)?.url,
      'https://sap.example.com/sap/bc/adt/core/http/logoff',
    );
  });

  it('an href that is no URL is said once; the platform logoff goes instead, and the close still settles', async () => {
    const logger = makeLogger();
    const seen: Seen[] = [];
    const conn = cloudWithLogoffHref('http://[', logger, seen);

    await conn.connect();
    const before = seen.length;
    const transport = (conn as any).transport;
    assert.strictEqual(await conn.disconnect(), undefined);
    await settled();
    // And the wire's own close, asked again, has nothing left that can throw.
    assert.strictEqual(
      await transport.close({ baseUrl: 'https://sap.example.com' }),
      undefined,
    );

    // One logoff, the platform's; the second close has no session left.
    assert.deepStrictEqual(
      seen.slice(before).map((r) => r.url),
      ['https://sap.example.com/sap/public/bc/icf/logoff'],
    );
    assert.ok(
      (
        logger.debug as unknown as Mock<(...args: any[]) => void>
      ).mock.calls.some(
        ({ arguments: args }) =>
          args.length === 1 &&
          typeof args[0] === 'string' &&
          args[0].includes('logoff link that is no URL'),
      ),
    );
  });

  it('carries no credential even when the context holds one', async () => {
    const transport = cloudHttpTransport(
      { ...baseConfig, authType: 'jwt', jwtToken: 'TOKEN' } as never,
      makeLogger(),
    );
    transport.ingest({
      'set-cookie': ['SAP_SESSIONID_STUB_100=abc%3d; path=/'],
    });
    (transport as any).logoff =
      'https://sap.example.com/sap/public/bc/icf/logoff';
    const seen: Seen[] = [];
    const instance = async (cfg: any) => {
      seen.push({
        url: cfg.url,
        method: cfg.method,
        headers: cfg.headers ?? {},
      });
      return { status: 200, data: '', headers: {} };
    };
    (instance as any).interceptors = {
      request: { clear: mock.fn() },
      response: { clear: mock.fn() },
    };
    (transport as any).instance = instance;
    const authorize = mock.fn();

    await transport.close({
      baseUrl: 'https://sap.example.com',
      authorize,
      extraHeaders: {
        authorization: 'Bearer LEAKED',
        'sap-adt-connection-id': 'C-1',
      },
    } as never);

    assert.strictEqual(seen.length, 1);
    const names = Object.keys(seen[0].headers).map((n) => n.toLowerCase());
    assert.ok(!names.includes('authorization'));
    assert.strictEqual(seen[0].headers['sap-adt-connection-id'], 'C-1');
    assert.strictEqual(authorize.mock.callCount(), 0);
  });
});

describe('a connection the server gave no session says so', () => {
  /**
   * The cookie's absence is the server saying it opened nothing, and that was
   * checked rather than assumed: a connection that got no cookie was held open
   * against an on-prem system and SM04 listed nothing for it, while one that
   * got a cookie appeared there.
   *
   * So it is a failed connect. There is no count to plan around — the same
   * system allowed 21 sessions one day and refused an eleventh the next — so a
   * caller cannot avoid this by being frugal, and the only reliable signal is
   * whether this connect got a session.
   */
  it('refuses to connect when the server issued no SAP_SESSIONID', async () => {
    const conn = onPrem(baseConfig, makeLogger());
    // What an on-prem server answers when it will not open a session: the CSRF
    // cookie, and nothing to hold a lock against.
    attachMockAxios(conn, [], async () => ({
      status: 200,
      data: '<service/>',
      headers: {
        'x-csrf-token': 'TOKEN',
        'set-cookie': ['sap-XSRF_STUB_100=xyz; path=/'],
      },
    }));

    await assert.rejects(conn.connect(), (e: unknown) =>
      /opened no ABAP session/.test((e as Error).message),
    );
    assert.strictEqual(conn.isConnected(), false);
    assert.strictEqual(conn.getSessionIdentity(), null);
  });

  // The message is the whole point: this is reported so the caller can decide,
  // and it cannot decide from "NOT_CONNECTED" alone. It has to say what the
  // server did, what still works, what does not, and who is expected to act.
  it('says what happened, what it costs, and whose call it is', async () => {
    const conn = onPrem(baseConfig, makeLogger());
    attachMockAxios(conn, [], async () => ({
      status: 200,
      data: '<service/>',
      headers: {
        'x-csrf-token': 'TOKEN',
        'set-cookie': ['sap-XSRF_STUB_100=xyz; path=/'],
      },
    }));

    const error = await conn.connect().catch((e: Error) => e);

    assert.ok(error instanceof Error);
    const message = (error as Error).message;
    // Names the WIRE rather than the cookie: what a session is addressed by is
    // the wire's business, and the base no longer knows that HTTP's answer is a
    // SAP_SESSIONID.
    assert.match(message, /wire reports it is on none/); // what was missing
    assert.match(message, /lock/i); // what it costs
    assert.match(message, /limited per user/); // the likely cause
    assert.match(message, /does not retry/); // whose call it is
  });

  it('stays quiet when a session was established', async () => {
    const logger = makeLogger();
    const conn = onPrem(baseConfig, logger);
    attachMockAxios(conn, []);

    await conn.connect();

    assert.ok(
      !(
        logger.warn as unknown as Mock<(...args: any[]) => void>
      ).mock.calls.some(
        ({ arguments: args }) =>
          args.length === 1 &&
          typeof args[0] === 'string' &&
          args[0].includes('no SAP_SESSIONID'),
      ),
    );
    assert.notStrictEqual(conn.getSessionIdentity(), null);
  });
});

/**
 * The lifecycle is create → connect → disconnect → connect → disconnect, and
 * every session in it has to be released, not only the first.
 *
 * The default deadline is `0`, so `disconnect()` does not wait for the logoff —
 * which means a release is routinely still in flight when the next `connect()`
 * happens. That is the normal path, not an edge case, and a release keyed to
 * nothing in particular made it a leak: the in-flight one for session A was
 * taken for "the release still owed", so session B's logoff was never sent.
 */
describe('every session of a reconnect cycle is released', () => {
  /** A double that survives clearSessionState(), as a reconnect requires. */
  function surviving(
    conn: AdtOnPremConnector,
    seen: Seen[],
    answer: (cfg: any) => Promise<any>,
  ): void {
    const instance = async (cfg: any) => {
      seen.push({
        url: cfg.url,
        method: cfg.method,
        headers: cfg.headers ?? {},
        timeout: cfg.timeout,
      });
      wroteIt(cfg);
      return answer(cfg);
    };
    (instance as any).interceptors = {
      request: { clear: mock.fn() },
      response: { clear: mock.fn() },
    };
    (conn as any).transport.instance = instance;
    reportableLogoff((conn as any).transport);
  }

  /**
   * A repeat connect() is a NEW session, with a new SAP_SESSIONID. The release
   * of the previous one is not this session's — reusing it, on the reasoning
   * that "a release already on its way is the release still owed", left the
   * second session never released at all.
   */
  it('a reconnect on a disconnected instance is refused: its one logoff carries its own session', async () => {
    const conn = onPrem(baseConfig, makeLogger());
    const seen: Seen[] = [];
    // A server issues ONE session and keeps handing back the same id until it
    // is told the session is finished — it does not mint a new one per request.
    // Modelling it the other way made every count depend on how many requests
    // connect() happens to make.
    let session = 1;
    surviving(conn, seen, async (cfg) => {
      if (String(cfg.url).includes('logoff')) {
        // Never answers: the first release stays in flight across the reconnect.
        // The next connect is a new session all the same.
        session += 1;
        await new Promise<never>(() => undefined);
      }
      return {
        status: 200,
        data: '<service/>',
        headers: {
          'x-csrf-token': 'TOKEN',
          'set-cookie': [`SAP_SESSIONID_STUB_100=S${session}%3d; path=/`],
        },
      };
    });

    await conn.connect();
    await conn.disconnect();
    // One instance is one session: a second session is a new instance.
    await assert.rejects(conn.connect(), (e: unknown) => {
      assertMatchObject(e, {
        code: 'ADT_NOT_CONNECTED',
      });
      return true;
    });
    await settled();

    const logoffs = seen.filter((r) => r.url.includes('/logoff'));
    assert.strictEqual(logoffs.length, 1);
    assert.ok(logoffs[0].headers.Cookie.includes('S1'));
  });

  /**
   * The logoff carries no request timeout by design, so one that never answers
   * stays outstanding for ever. Waiting on every release in flight therefore
   * charged each later caller its whole deadline for a request nobody can
   * finish — measured at 2002 ms for a `deadlineMs: 2000` whose own logoff had
   * already answered.
   */

  /**
   * A concurrent disconnect JOINS the transition, and `SessionLifecycle` hands a
   * joiner the existing promise without running its callback — so anything the
   * callback computes is invisible to it. A joiner that asked for a 30-second
   * budget was returning the moment the logoff had been dispatched, never
   * waiting for it to land.
   *
   * Deliberately the SECOND caller who is patient: with the patient one first,
   * this passes either way.
   */

  it('refuses a repeat disconnect() and does not re-send the release', async () => {
    const conn = onPrem(baseConfig, makeLogger());
    const seen: Seen[] = [];
    surviving(conn, seen, async (cfg) => {
      if (String(cfg.url).includes('logoff')) {
        await new Promise<never>(() => undefined);
      }
      return {
        status: 200,
        data: '<service/>',
        headers: {
          'x-csrf-token': 'TOKEN',
          'set-cookie': ['SAP_SESSIONID_STUB_100=same%3d; path=/'],
        },
      };
    });

    await conn.connect();
    await conn.disconnect();
    // Nothing reconnected, so there is no second session to close: the
    // repeat is refused — disconnect() is called once — and asks nothing.
    await assert.rejects(conn.disconnect(), (e: unknown) => {
      assertMatchObject(e, {
        code: 'ADT_NOT_CONNECTED',
      });
      return true;
    });
    await settled();

    assert.strictEqual(seen.filter((r) => r.url.includes('/logoff')).length, 1);
  });
});

/**
 * A session belongs to ONE application server. On a multi-node system a request
 * that lands on another gets another session, and a lock held on the first dies
 * — no inactivity, nobody at fault. Eclipse pins itself with these headers on
 * every request; without them each one is a fresh throw of the dice.
 */
describe('requests stay on the server the session lives on', () => {
  function pinning(
    conn: AdtOnPremConnector,
    seen: Seen[],
    server?: string,
  ): void {
    const instance = async (cfg: any) => {
      seen.push({
        url: cfg.url,
        method: cfg.method,
        headers: cfg.headers ?? {},
        timeout: cfg.timeout,
      });
      return {
        status: 200,
        data: '<service/>',
        headers: {
          'x-csrf-token': 'TOKEN',
          'set-cookie': ['SAP_SESSIONID_STUB_100=abc%3d; path=/'],
          ...(server ? { 'sap-adt-saplb': server } : {}),
        },
      };
    };
    // UNDER the wire, not instead of it: the affinity headers this test is
    // about are what the wire adds to its own requests, so a stub that replaced
    // `send()` would be measuring a wire that never ran.
    (conn as any).transport.client = () => instance;
  }

  it('asks the server to name itself, then sends that name back', async () => {
    const conn = onPrem(baseConfig, makeLogger());
    const seen: Seen[] = [];
    pinning(conn, seen, 'appserver-c5zhg');

    await conn.connect();
    await conn.makeAdtRequest({
      url: '/sap/bc/adt/discovery',
      method: 'GET',
      timeout: 5000,
    });

    // Every request asks, because a restart can move us and the answer is how
    // we find out.
    for (const request of seen) {
      assert.strictEqual(request.headers['sap-adt-saplb'], 'fetch');
    }
    // The name can only be sent once it has been answered, so the first
    // request cannot carry it — every one after it must.
    const afterNamed = seen.slice(1);
    assert.ok(afterNamed.length > 0);
    for (const request of afterNamed) {
      assert.strictEqual(request.headers.saplb, 'appserver-c5zhg');
      assert.strictEqual(
        request.headers['saplb-options'],
        'REDISPATCH_ON_SHUTDOWN',
      );
    }
  });

  it('sends no name when the server never gave one', async () => {
    const conn = onPrem(baseConfig, makeLogger());
    const seen: Seen[] = [];
    pinning(conn, seen);

    await conn.connect();

    // Never invented: a single-node system names nobody, and a guessed
    // `saplb` would pin us to a server that may not exist.
    for (const request of seen) {
      assert.strictEqual(request.headers.saplb, undefined);
    }
  });

  it('forgets the server when the session it belonged to is gone', async () => {
    const conn = onPrem(baseConfig, makeLogger());
    const seen: Seen[] = [];
    pinning(conn, seen, 'appserver-c5zhg');

    await conn.connect();
    assert.strictEqual(
      conn.transport.affinityHeaders().saplb,
      'appserver-c5zhg',
    );
    // The session is lost (a dead session, a changed SAP_SESSIONID): the wire
    // forgets the server it lived on, and asks again rather than asserting it.
    (conn as unknown as { raiseSessionLost(r: string): void }).raiseSessionLost(
      'test: the session was lost',
    );
    await settled();

    assert.strictEqual(conn.transport.affinityHeaders().saplb, undefined);
    assert.strictEqual(
      conn.transport.affinityHeaders()['sap-adt-saplb'],
      'fetch',
    );
  });
});

/**
 * A session opened by the preflight, on a connect that then failed.
 *
 * The preflight opens the session on its own request; establishing runs after
 * it and can still fail on a credential the preflight never used. Clearing the
 * local state then would leave that session open AND unreachable: the
 * connection is not connected, so `disconnect()` sends nothing, and the cookie
 * that was the only permission to close it is gone.
 */
describe('a session opened before a failed connect is not abandoned', () => {
  const SESSION_DOC =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<http:session xmlns:http="http://www.sap.com/adt/http" xmlns:atom="http://www.w3.org/2005/Atom">' +
    '<atom:link href="/sap/bc/adt/core/http/sessions/S-1" rel="http://www.sap.com/adt/categories/core/http/sessions/securitysession" title="Security session"/>' +
    '<atom:link href="/sap/public/bc/icf/logoff" rel="http://www.sap.com/adt/categories/core/http/sessions/logoff" title="Logoff resource"/>' +
    '</http:session>';

  function cloudThenFailing(conn: AdtOnPremConnector, seen: Seen[]): void {
    const instance = async (cfg: any) => {
      seen.push({
        url: cfg.url,
        method: cfg.method,
        headers: cfg.headers ?? {},
        timeout: cfg.timeout,
      });
      // The preflight succeeds and opens a session.
      if (String(cfg.url).includes('/core/http/sessions?')) {
        return {
          status: 200,
          data: SESSION_DOC,
          headers: { 'set-cookie': ['SAP_SESSIONID_STUB_100=abc%3d; path=/'] },
        };
      }
      // The logoff that says goodbye.
      if (String(cfg.url).includes('/icf/logoff')) {
        return { status: 200, data: '', headers: {} };
      }
      // Establishing then fails, as it can on a credential the preflight did
      // not use.
      throw new Error('establishment refused');
    };
    (instance as any).interceptors = {
      request: { clear: mock.fn() },
      response: { clear: mock.fn() },
    };
    (conn as any).transport.instance = instance;
  }

  it('says goodbye to it when establishing fails afterwards', async () => {
    // A CLOUD connection: it is the one that opens a session resource, so it is
    // the one that can leave one open when establishing fails after the
    // preflight. On-prem opens nothing to leave behind.
    const conn = new AdtCloudConnector(
      { ...baseConfig, authType: 'jwt', jwtToken: 'TOKEN' } as never,
      TokenAuthProvider.fixed('TOKEN'),
      cloudHttpTransport(
        { ...baseConfig, authType: 'jwt', jwtToken: 'TOKEN' } as never,
        makeLogger(),
      ),
      makeLogger(),
    );
    const seen: Seen[] = [];
    cloudThenFailing(conn as never, seen);

    await assert.rejects(conn.connect());
    // The goodbye is dispatched but not awaited — the caller is owed the
    // establishment error, not a round trip.
    await new Promise((r) => setTimeout(r, 20));

    const goodbye = seen.find(
      (r) => r.method === 'GET' && r.url.includes('/sap/public/bc/icf/logoff'),
    );
    assert.notStrictEqual(goodbye, undefined);
    // With the cookie that is the whole permission to close it, taken before
    // the local state was cleared.
    assert.ok(goodbye?.headers.Cookie.includes('SAP_SESSIONID_STUB_100'));
  });

  it('says nothing when the preflight opened nothing', async () => {
    const conn = new AdtCloudConnector(
      { ...baseConfig, authType: 'jwt', jwtToken: 'TOKEN' } as never,
      TokenAuthProvider.fixed('TOKEN'),
      cloudHttpTransport(
        { ...baseConfig, authType: 'jwt', jwtToken: 'TOKEN' } as never,
        makeLogger(),
      ),
      makeLogger(),
    ) as never as AdtOnPremConnector;
    const seen: Seen[] = [];
    const instance = async (cfg: any) => {
      seen.push({
        url: cfg.url,
        method: cfg.method,
        headers: cfg.headers ?? {},
        timeout: cfg.timeout,
      });
      // No session resource on this system.
      if (String(cfg.url).includes('/core/http/sessions')) {
        return { status: 404, data: '', headers: {} };
      }
      throw new Error('establishment refused');
    };
    (instance as any).interceptors = {
      request: { clear: mock.fn() },
      response: { clear: mock.fn() },
    };
    (conn as any).transport.instance = instance;
    // The debris: a cookie left behind by the response that rejected us. It
    // looks exactly like a session and is not one, which is why "there are
    // cookies" cannot be the test for whether to say goodbye.
    (conn as unknown as { cookies: string }).cookies =
      'SAP_SESSIONID_STUB_100=junk%3d';

    await assert.rejects(conn.connect());
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(
      seen.some((r) => r.url.includes('/icf/logoff')),
      false,
    );
    assert.strictEqual(
      seen.some((r) => r.method === 'DELETE'),
      false,
    );
  });
});

describe('disconnect ends the server session', () => {
  it('calls the logoff endpoint with the session cookies', async () => {
    const conn = onPrem(baseConfig, makeLogger());
    const seen: Seen[] = [];
    attachMockAxios(conn, seen);

    await conn.connect();
    await conn.disconnect();
    await settled();

    const logoff = seen.find((r) =>
      r.url.includes('/sap/public/bc/icf/logoff'),
    );
    assert.notStrictEqual(logoff, undefined);
    assert.ok(logoff?.headers.Cookie.includes('SAP_SESSIONID_STUB_100'));
    // As Eclipse sends it: the cookie and nothing that logs on — the service
    // answers `sap-authenticated: not required`.
    assert.strictEqual(logoff?.headers.Authorization, undefined);
    assert.strictEqual(logoff?.headers.Accept, '*/*');
    assert.strictEqual(logoff?.headers['sap-cancel-on-close'], 'true');
    assert.match(logoff?.headers['sap-adt-request-id'], /^[0-9a-f]{32}$/);
    // On-prem names no security session: its session arrives with the logon.
    assert.strictEqual(logoff?.headers['x-sap-security-session'], undefined);
  });

  it('disconnects anyway when the logoff fails', async () => {
    // A session we could not close is strictly better than a teardown that
    // hangs or throws — disconnect() must always settle.
    const conn = onPrem(baseConfig, makeLogger());
    const seen: Seen[] = [];
    attachMockAxios(conn, seen, async (cfg) => {
      if (String(cfg.url).includes('logoff')) {
        throw new Error('network is down');
      }
      return {
        status: 200,
        data: '<service/>',
        headers: {
          'x-csrf-token': 'TOKEN',
          'set-cookie': ['SAP_SESSIONID_STUB_100=abc%3d; path=/'],
        },
      };
    });

    await conn.connect();
    assert.strictEqual(await conn.disconnect(), undefined);
    assert.strictEqual(conn.isConnected(), false);
    assert.strictEqual(conn.getSessionIdentity(), null);
  });

  /**
   * The default is not to wait, and that is the point rather than a tuning
   * choice: waiting is for steps whose successor needs the server to have
   * caught up — lock, update, unlock, activate. A teardown has no successor.
   */
  it('does not wait by default, even if the logoff never answers', async () => {
    const conn = onPrem(baseConfig, makeLogger());
    const seen: Seen[] = [];
    attachMockAxios(conn, seen, async (cfg) => {
      if (String(cfg.url).includes('logoff')) {
        // Never answers at all.
        await new Promise<never>(() => undefined);
      }
      return {
        status: 200,
        data: '<service/>',
        headers: {
          'x-csrf-token': 'TOKEN',
          'set-cookie': ['SAP_SESSIONID_STUB_100=abc%3d; path=/'],
        },
      };
    });

    await conn.connect();
    await conn.disconnect();
    await settled();

    assert.strictEqual(
      seen.some((r) => r.url.includes('/logoff')),
      true,
    );
    assert.strictEqual(conn.isConnected(), false);
  });

  /**
   * The deadline is the caller's instrument, and it was published before this
   * code existed: `ISessionLifecycleAware.disconnect` documents `deadlineMs`,
   * `0` included. While disconnect() did no I/O, ignoring it cost nothing — a
   * caller asking not to wait was not waiting anyway. The logoff is the first
   * thing that makes the parameter mean something, so it is the first thing
   * that can violate it.
   */

  /**
   * The deadline bounds the WAIT, never the request — the contract's words are
   * "how long to wait for the transport release before **detaching** it". Handed
   * to axios instead, it would abort the socket on expiry and cancel the release
   * it was waiting for, leaving the session open: the precise failure this whole
   * change exists to prevent, reintroduced by the parameter meant to bound it.
   */

  it('refuses a repeat call and sends nothing when the first logoff succeeded', async () => {
    const conn = onPrem(baseConfig, makeLogger());
    const seen: Seen[] = [];
    attachMockAxios(conn, seen);

    await conn.connect();
    await conn.disconnect();
    await assert.rejects(conn.disconnect(), (e: unknown) => {
      assertMatchObject(e, {
        code: 'ADT_NOT_CONNECTED',
      });
      return true;
    });

    assert.strictEqual(seen.filter((r) => r.url.includes('/logoff')).length, 1);
  });

  it('refuses a repeat call while the release is still in flight, and opens no second', async () => {
    const conn = onPrem(baseConfig, makeLogger());
    const seen: Seen[] = [];
    let releaseLogoff: (() => void) | undefined;
    attachMockAxios(conn, seen, async (cfg) => {
      if (String(cfg.url).includes('logoff')) {
        await new Promise<void>((resolve) => {
          releaseLogoff = resolve;
        });
      }
      return {
        status: 200,
        data: '<service/>',
        headers: {
          'x-csrf-token': 'TOKEN',
          'set-cookie': ['SAP_SESSIONID_STUB_100=abc%3d; path=/'],
        },
      };
    });

    await conn.connect();
    // Detaches while the logoff is still on its way.
    await conn.disconnect();
    await assert.rejects(conn.disconnect(), (e: unknown) => {
      assertMatchObject(e, {
        code: 'ADT_NOT_CONNECTED',
      });
      return true;
    });

    assert.strictEqual(seen.filter((r) => r.url.includes('/logoff')).length, 1);
    releaseLogoff?.();
  });

  /**
   * Concurrent disconnects join one transition and are handed the same promise,
   * so a wait placed inside it would be the first caller's wait imposed on
   * everyone: a caller passing `0` would sit through another's long budget,
   * which is the one thing the parameter exists to prevent. The work happens
   * once; the waiting is each caller's own.
   */

  /**
   * Assembling the request can fail on its own — a certificate connection whose
   * material is not loaded throws while building the agent. `disconnect()` is
   * called from a `finally`, so a throw here would replace the error that sent
   * the caller there, and would leave the teardown half-done.
   */
  it('disconnects even when the logoff cannot be assembled', async () => {
    const conn = onPrem(baseConfig, makeLogger());
    const seen: Seen[] = [];
    attachMockAxios(conn, seen);

    await conn.connect();
    // Building the request throws, as a certificate connection's agent can.
    (conn as any).transport.client = () => {
      throw new Error('no material to build the agent from');
    };

    assert.strictEqual(await conn.disconnect(), undefined);
    await settled();
    assert.strictEqual(conn.isConnected(), false);
    assert.strictEqual(conn.getSessionIdentity(), null);
  });

  it('asks nothing of the credential to say goodbye', async () => {
    const conn = onPrem(baseConfig, makeLogger());
    const seen: Seen[] = [];
    attachMockAxios(conn, seen);

    await conn.connect();
    // The session context's `authorize` is `credentialHeaders`: the logoff
    // never reaches it, so a credential that cannot build a header any more
    // does not keep the session open.
    (conn as any).credentialHeaders = async () => {
      throw new Error('no credential to build a header from');
    };

    assert.strictEqual(await conn.disconnect(), undefined);
    await settled();
    assert.strictEqual(seen.filter((r) => r.url.includes('/logoff')).length, 1);
  });

  it('sends nothing when there is no session to end', async () => {
    const conn = onPrem(baseConfig, makeLogger());
    const seen: Seen[] = [];
    attachMockAxios(conn, seen);

    await conn.disconnect();

    assert.strictEqual(seen.length, 0);
  });
});
