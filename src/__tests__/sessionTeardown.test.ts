/**
 * disconnect() ends the session on the server, not only in the client.
 *
 * Dropping the cookie leaves the ABAP session alive until its own timeout, and
 * a process that connects repeatedly leaves one behind every time. Once enough
 * pile up the server stops issuing sessions at all — it answers with the XSRF
 * cookie instead — and a connection without a session still gets `200` for a
 * LOCK, handing back a handle the next request cannot use.
 */
import type { SapConfig } from '../config/sapConfig.js';
import { BaseAbapConnection } from '../connection/BaseAbapConnection.js';
import type { ILogger } from '../logger.js';

const baseConfig: SapConfig = {
  url: 'https://sap.example.com',
  authType: 'basic',
  username: 'u',
  password: 'p',
  client: '100',
};

function makeLogger(): ILogger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

type Seen = {
  url: string;
  method: string;
  headers: Record<string, string>;
  timeout?: number;
};

function attachMockAxios(
  conn: BaseAbapConnection,
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
    return answer(cfg);
  };
  // clearSessionState() detaches interceptors before dropping the instance, so
  // the double has to carry them — the earlier doubles never reached teardown.
  (instance as any).interceptors = {
    request: { clear: jest.fn() },
    response: { clear: jest.fn() },
  };
  (conn as any).axiosInstance = instance;
}

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
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
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

    await expect(conn.connect()).rejects.toThrow(/opened no ABAP session/);
    expect(conn.isConnected()).toBe(false);
    expect(conn.getSessionIdentity()).toBeNull();
  });

  // The message is the whole point: this is reported so the caller can decide,
  // and it cannot decide from "NOT_CONNECTED" alone. It has to say what the
  // server did, what still works, what does not, and who is expected to act.
  it('says what happened, what it costs, and whose call it is', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    attachMockAxios(conn, [], async () => ({
      status: 200,
      data: '<service/>',
      headers: {
        'x-csrf-token': 'TOKEN',
        'set-cookie': ['sap-XSRF_STUB_100=xyz; path=/'],
      },
    }));

    const error = await conn.connect().catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/SAP_SESSIONID/); // what was missing
    expect(message).toMatch(/lock/i); // what it costs
    expect(message).toMatch(/limited per user/); // the likely cause
    expect(message).toMatch(/does not retry/); // whose call it is
  });

  it('stays quiet when a session was established', async () => {
    const logger = makeLogger();
    const conn = new BaseAbapConnection(baseConfig, logger);
    attachMockAxios(conn, []);

    await conn.connect();

    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('no SAP_SESSIONID'),
    );
    expect(conn.getSessionIdentity()).not.toBeNull();
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
    conn: BaseAbapConnection,
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
      return answer(cfg);
    };
    (instance as any).interceptors = {
      request: { clear: jest.fn() },
      response: { clear: jest.fn() },
    };
    Object.defineProperty(conn, 'axiosInstance', {
      get: () => instance,
      set: () => undefined,
      configurable: true,
    });
  }

  /**
   * A repeat connect() is a NEW session, with a new SAP_SESSIONID. The release
   * of the previous one is not this session's — reusing it, on the reasoning
   * that "a release already on its way is the release still owed", left the
   * second session never released at all.
   */
  it('sends a logoff for the second session while the first still hangs', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
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
    await conn.connect();
    await conn.disconnect();

    const logoffs = seen.filter((r) => r.url.includes('/logoff'));
    expect(logoffs).toHaveLength(2);
    // Each carried its own session, which is what proves they are two releases
    // and not the same one sent twice.
    expect(logoffs[0].headers.Cookie).toContain('S1');
    expect(logoffs[1].headers.Cookie).toContain('S2');
  });

  /**
   * The logoff carries no request timeout by design, so one that never answers
   * stays outstanding for ever. Waiting on every release in flight therefore
   * charged each later caller its whole deadline for a request nobody can
   * finish — measured at 2002 ms for a `deadlineMs: 2000` whose own logoff had
   * already answered.
   */
  it('does not spend a caller’s deadline on a release that never answers', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    const seen: Seen[] = [];
    // Counted per CONNECT, not per request: establishment is two requests now
    // (the preflight, then the establishing call), and numbering by request
    // made every logoff carry a cookie the hang branch below never matched —
    // the test passed while testing nothing.
    let session = 0;
    let firstGoodbyeHung = false;
    surviving(conn, seen, async (cfg) => {
      if (String(cfg.url).includes('logoff')) {
        // The first session's goodbye hangs; the second's answers at once.
        if (String(cfg.headers?.Cookie ?? '').includes('S1')) {
          firstGoodbyeHung = true;
          await new Promise<never>(() => undefined);
        }
        return { status: 200, data: '', headers: {} };
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

    session = 1;
    await conn.connect();
    await conn.disconnect();
    session = 2;
    await conn.connect();

    const startedAt = Date.now();
    await conn.disconnect({ deadlineMs: 2000 });
    const spent = Date.now() - startedAt;

    // The hang is real — without this the assertion below passes for the wrong
    // reason, which is exactly what happened.
    expect(firstGoodbyeHung).toBe(true);
    // And its own release answered, so it had no reason to wait at all.
    expect(spent).toBeLessThan(1000);
  });

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
  it('a joining caller waits for the release it asked about', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    const seen: Seen[] = [];
    let releaseLogoff: (() => void) | undefined;
    let landed = false;
    surviving(conn, seen, async (cfg) => {
      if (String(cfg.url).includes('logoff')) {
        await new Promise<void>((resolve) => {
          releaseLogoff = () => {
            landed = true;
            resolve();
          };
        });
        return { status: 200, data: '', headers: {} };
      }
      return {
        status: 200,
        data: '<service/>',
        headers: {
          'x-csrf-token': 'TOKEN',
          'set-cookie': ['SAP_SESSIONID_STUB_100=S1%3d; path=/'],
        },
      };
    });

    await conn.connect();

    const impatient = conn.disconnect({ deadlineMs: 0 });
    const patient = conn.disconnect({ deadlineMs: 30_000 });

    await impatient;
    expect(landed).toBe(false);

    let patientDone = false;
    void patient.then(() => {
      patientDone = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    // Still waiting: its budget was for the logoff to land, and it has not.
    expect(patientDone).toBe(false);

    releaseLogoff?.();
    await patient;
    expect(landed).toBe(true);
  });

  it('does not re-send a release already on its way for the same session', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
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
    // Nothing reconnected, so there is no second session to close: the repeat
    // joins the release already going rather than asking twice.
    await conn.disconnect();

    expect(seen.filter((r) => r.url.includes('/logoff'))).toHaveLength(1);
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
    conn: BaseAbapConnection,
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
    (instance as any).interceptors = {
      request: { clear: jest.fn() },
      response: { clear: jest.fn() },
    };
    Object.defineProperty(conn, 'axiosInstance', {
      get: () => instance,
      set: () => undefined,
      configurable: true,
    });
  }

  it('asks the server to name itself, then sends that name back', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
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
      expect(request.headers['sap-adt-saplb']).toBe('fetch');
    }
    // The name can only be sent once it has been answered, so the first
    // request cannot carry it — every one after it must.
    const afterNamed = seen.slice(1);
    expect(afterNamed.length).toBeGreaterThan(0);
    for (const request of afterNamed) {
      expect(request.headers.saplb).toBe('appserver-c5zhg');
      expect(request.headers['saplb-options']).toBe('REDISPATCH_ON_SHUTDOWN');
    }
  });

  it('sends no name when the server never gave one', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    const seen: Seen[] = [];
    pinning(conn, seen);

    await conn.connect();

    // Never invented: a single-node system names nobody, and a guessed
    // `saplb` would pin us to a server that may not exist.
    for (const request of seen) {
      expect(request.headers.saplb).toBeUndefined();
    }
  });

  it('forgets the server when the session it belonged to is gone', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    const seen: Seen[] = [];
    pinning(conn, seen, 'appserver-c5zhg');

    await conn.connect();
    await conn.disconnect({ deadlineMs: 500 });
    const before = seen.length;
    await conn.connect();

    // A fresh connect starts by asking again rather than by asserting where
    // the last session used to live.
    expect(seen[before].headers.saplb).toBeUndefined();
    expect(seen[before].headers['sap-adt-saplb']).toBe('fetch');
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

  function cloudThenFailing(conn: BaseAbapConnection, seen: Seen[]): void {
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
      // The DELETE that says goodbye.
      if (String(cfg.url).includes('/core/http/sessions/')) {
        return { status: 200, data: '', headers: {} };
      }
      // Establishing then fails, as it can on a credential the preflight did
      // not use.
      throw new Error('establishment refused');
    };
    (instance as any).interceptors = {
      request: { clear: jest.fn() },
      response: { clear: jest.fn() },
    };
    Object.defineProperty(conn, 'axiosInstance', {
      get: () => instance,
      set: () => undefined,
      configurable: true,
    });
  }

  it('says goodbye to it when establishing fails afterwards', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    const seen: Seen[] = [];
    cloudThenFailing(conn, seen);

    await expect(conn.connect()).rejects.toThrow();
    // The goodbye is dispatched but not awaited — the caller is owed the
    // establishment error, not a round trip.
    await new Promise((r) => setTimeout(r, 20));

    const goodbye = seen.find(
      (r) => r.method === 'DELETE' && r.url.includes('/core/http/sessions/S-1'),
    );
    expect(goodbye).toBeDefined();
    // With the cookie that is the whole permission to close it, taken before
    // the local state was cleared.
    expect(goodbye?.headers.Cookie).toContain('SAP_SESSIONID_STUB_100');
  });

  it('says nothing when the preflight opened nothing', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
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
      request: { clear: jest.fn() },
      response: { clear: jest.fn() },
    };
    Object.defineProperty(conn, 'axiosInstance', {
      get: () => instance,
      set: () => undefined,
      configurable: true,
    });
    // The debris: a cookie left behind by the response that rejected us. It
    // looks exactly like a session and is not one, which is why "there are
    // cookies" cannot be the test for whether to say goodbye.
    (conn as unknown as { cookies: string }).cookies =
      'SAP_SESSIONID_STUB_100=junk%3d';

    await expect(conn.connect()).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 20));

    expect(seen.some((r) => r.url.includes('/icf/logoff'))).toBe(false);
    expect(seen.some((r) => r.method === 'DELETE')).toBe(false);
  });
});

describe('disconnect ends the server session', () => {
  it('calls the logoff endpoint with the session cookies', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    const seen: Seen[] = [];
    attachMockAxios(conn, seen);

    await conn.connect();
    await conn.disconnect();

    const logoff = seen.find((r) =>
      r.url.includes('/sap/public/bc/icf/logoff'),
    );
    expect(logoff).toBeDefined();
    expect(logoff?.headers.Cookie).toContain('SAP_SESSIONID_STUB_100');
  });

  it('disconnects anyway when the logoff fails', async () => {
    // A session we could not close is strictly better than a teardown that
    // hangs or throws — disconnect() must always settle.
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
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
    await expect(conn.disconnect()).resolves.toBeUndefined();
    expect(conn.isConnected()).toBe(false);
    expect(conn.getSessionIdentity()).toBeNull();
  });

  /**
   * The default is not to wait, and that is the point rather than a tuning
   * choice: waiting is for steps whose successor needs the server to have
   * caught up — lock, update, unlock, activate. A teardown has no successor.
   */
  it('does not wait by default, even if the logoff never answers', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
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

    expect(seen.some((r) => r.url.includes('/logoff'))).toBe(true);
    expect(conn.isConnected()).toBe(false);
  });

  /**
   * The deadline is the caller's instrument, and it was published before this
   * code existed: `ISessionLifecycleAware.disconnect` documents `deadlineMs`,
   * `0` included. While disconnect() did no I/O, ignoring it cost nothing — a
   * caller asking not to wait was not waiting anyway. The logoff is the first
   * thing that makes the parameter mean something, so it is the first thing
   * that can violate it.
   */
  it('deadlineMs: 0 sends the logoff but does not wait for it', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    const seen: Seen[] = [];
    let releaseLogoff: (() => void) | undefined;
    attachMockAxios(conn, seen, async (cfg) => {
      if (String(cfg.url).includes('logoff')) {
        // Never answers until the test lets it.
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
    await conn.disconnect({ deadlineMs: 0 });

    // It resolved without the logoff having answered — and the logoff was sent,
    // because closing what we opened is not conditional on wanting to wait.
    expect(seen.some((r) => r.url.includes('/logoff'))).toBe(true);
    expect(conn.isConnected()).toBe(false);
    releaseLogoff?.();
  });

  /**
   * The deadline bounds the WAIT, never the request — the contract's words are
   * "how long to wait for the transport release before **detaching** it". Handed
   * to axios instead, it would abort the socket on expiry and cancel the release
   * it was waiting for, leaving the session open: the precise failure this whole
   * change exists to prevent, reintroduced by the parameter meant to bound it.
   */
  it('a deadline detaches the logoff rather than aborting it', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    const seen: Seen[] = [];
    let releaseLogoff: (() => void) | undefined;
    let logoffFinished = false;
    attachMockAxios(conn, seen, async (cfg) => {
      if (String(cfg.url).includes('logoff')) {
        await new Promise<void>((resolve) => {
          releaseLogoff = resolve;
        });
        logoffFinished = true;
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
    await conn.disconnect({ deadlineMs: 20 });

    const logoff = seen.find((r) => r.url.includes('/logoff'));
    expect(logoff).toBeDefined();
    // No axios deadline at any budget: the one request whose purpose is to
    // reach the server must be allowed to get there.
    expect(logoff?.timeout).toBeUndefined();
    // The wait ended without it, and it is still on its way rather than killed.
    expect(logoffFinished).toBe(false);
    expect(conn.isConnected()).toBe(false);

    releaseLogoff?.();
    await Promise.resolve();
    expect(logoffFinished).toBe(true);
  });

  // Its place is a `finally`, so it does not throw there — an exception raised
  // in a cleanup path replaces the error that sent the caller into it. A bad
  // number is reported and the default used: refusing to release the session is
  // a worse answer to it than releasing it on the default schedule.
  it.each([[-1], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'reports a deadlineMs of %p and disconnects anyway',
    async (deadlineMs) => {
      const logger = makeLogger();
      const conn = new BaseAbapConnection(baseConfig, logger);
      const seen: Seen[] = [];
      attachMockAxios(conn, seen);
      await conn.connect();

      await expect(conn.disconnect({ deadlineMs })).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('deadlineMs'),
      );
      expect(conn.isConnected()).toBe(false);
      expect(seen.some((r) => r.url.includes('/logoff'))).toBe(true);
    },
  );

  it('refuses to construct on a malformed SAP_RELEASE_DEADLINE_MS', () => {
    // The startup fault it is: same on every call, nobody's argument, and
    // discovered at teardown otherwise — in the `finally` of every consumer.
    const previous = process.env.SAP_RELEASE_DEADLINE_MS;
    process.env.SAP_RELEASE_DEADLINE_MS = 'abc';
    try {
      expect(() => new BaseAbapConnection(baseConfig, makeLogger())).toThrow(
        /SAP_RELEASE_DEADLINE_MS/,
      );
    } finally {
      if (previous === undefined) {
        process.env.SAP_RELEASE_DEADLINE_MS = undefined;
        delete process.env.SAP_RELEASE_DEADLINE_MS;
      } else {
        process.env.SAP_RELEASE_DEADLINE_MS = previous;
      }
    }
  });

  /**
   * "measured from this call and including any time spent queued behind another
   * lifecycle transition" — the contract's words. Transitions run one at a time
   * on a serializing tail, so a disconnect called while a recovery is running
   * does not start until that recovery finishes. A budget that started when the
   * queued callback finally ran would hand a delayed teardown its full
   * allowance again, which is the one thing the caller was bounding.
   */
  it('spends the deadline while queued behind another transition', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    const seen: Seen[] = [];
    let gate: (() => void) | undefined;
    let gateArmed = false;
    attachMockAxios(conn, seen, async (cfg) => {
      // Only the re-establishment hangs; the first connect must complete so a
      // session exists to log off.
      // Only the establishing call is held. The session preflight that runs
      // before it is part of the same connect and gating it would hang the
      // recovery somewhere else than this test is about.
      if (gateArmed && String(cfg.url).includes('/discovery')) {
        await new Promise<void>((resolve) => {
          gate = resolve;
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

    // A recovery occupies the tail. It rejects once the teardown moves the
    // epoch under it, which is correct and not what this test is about.
    gateArmed = true;
    const recovering = (
      conn as unknown as { recoverSession(epoch: number): Promise<void> }
    )
      .recoverSession(
        (conn as unknown as { teardownEpoch: number }).teardownEpoch,
      )
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 5));

    const disconnecting = conn.disconnect({ deadlineMs: 20 });
    await new Promise((r) => setTimeout(r, 80));
    gate?.();

    await recovering;
    await disconnecting;

    const logoff = seen.find((r) => r.url.includes('/logoff'));
    expect(logoff).toBeDefined();
    // The budget was gone before the callback ran, so the logoff went out
    // detached — no deadline handed to axios, and nothing awaited.
    expect(logoff?.timeout).toBeUndefined();
  });

  it('sends nothing on a repeat call when the first logoff succeeded', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    const seen: Seen[] = [];
    attachMockAxios(conn, seen);

    await conn.connect();
    await conn.disconnect({ deadlineMs: 1000 });
    await conn.disconnect({ deadlineMs: 1000 });

    expect(seen.filter((r) => r.url.includes('/logoff'))).toHaveLength(1);
  });

  it('joins a release still in flight instead of opening a second', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
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
    await conn.disconnect({ deadlineMs: 20 });
    await conn.disconnect({ deadlineMs: 20 });

    expect(seen.filter((r) => r.url.includes('/logoff'))).toHaveLength(1);
    releaseLogoff?.();
  });

  /**
   * Concurrent disconnects join one transition and are handed the same promise,
   * so a wait placed inside it would be the first caller's wait imposed on
   * everyone: a caller passing `0` would sit through another's long budget,
   * which is the one thing the parameter exists to prevent. The work happens
   * once; the waiting is each caller's own.
   */
  it('does not charge one caller with another caller’s deadline', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
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

    const patient = conn.disconnect({ deadlineMs: 30_000 });
    const impatient = conn.disconnect({ deadlineMs: 0 });

    // The one that asked not to wait does not, even though a 30 s wait is in
    // progress next to it. Without its own budget this would hang until the
    // test times out.
    await impatient;
    expect(conn.isConnected()).toBe(false);
    // And one logoff for both.
    expect(seen.filter((r) => r.url.includes('/logoff'))).toHaveLength(1);

    releaseLogoff?.();
    await patient;
  });

  /**
   * Assembling the request can fail on its own — a certificate connection whose
   * material is not loaded throws while building the agent. `disconnect()` is
   * called from a `finally`, so a throw here would replace the error that sent
   * the caller there, and would leave the teardown half-done.
   */
  it('disconnects even when the logoff cannot be assembled', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    const seen: Seen[] = [];
    attachMockAxios(conn, seen);

    await conn.connect();
    (conn as any).getAuthHeaders = async () => {
      throw new Error('no credential to build a header from');
    };

    await expect(conn.disconnect()).resolves.toBeUndefined();
    expect(conn.isConnected()).toBe(false);
    expect(conn.getSessionIdentity()).toBeNull();
    expect(seen.filter((r) => r.url.includes('/logoff'))).toHaveLength(0);
  });

  it('sends nothing when there is no session to end', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    const seen: Seen[] = [];
    attachMockAxios(conn, seen);

    await conn.disconnect();

    expect(seen).toHaveLength(0);
  });
});
