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

  it('sends a logoff for the second session while the first still hangs', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    const seen: Seen[] = [];
    let session = 0;
    surviving(conn, seen, async (cfg) => {
      if (String(cfg.url).includes('logoff')) {
        // Never answers: the first release stays in flight across the reconnect.
        await new Promise<never>(() => undefined);
      }
      session += 1;
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
    let session = 0;
    surviving(conn, seen, async (cfg) => {
      if (String(cfg.url).includes('logoff')) {
        // The first session's logoff hangs; the second's answers at once.
        if (String(cfg.headers?.Cookie ?? '').includes('S1')) {
          await new Promise<never>(() => undefined);
        }
        return { status: 200, data: '', headers: {} };
      }
      session += 1;
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

    const startedAt = Date.now();
    await conn.disconnect({ deadlineMs: 2000 });
    const spent = Date.now() - startedAt;

    // Its own release answered, so it had no reason to wait at all.
    expect(spent).toBeLessThan(1000);
  });

  /**
   * A server that refuses the logoff — a proxy in the way, a 404, the network
   * down — cannot be fixed by asking again for ever. Retrying every owed session
   * on every teardown cost n(n+1)/2 requests: 210 of them over twenty reconnect
   * cycles, naming sessions that had idled out server-side long before.
   */
  it('stops retrying a release that keeps failing, and says so', async () => {
    const logger = makeLogger();
    const conn = new BaseAbapConnection(baseConfig, logger);
    const seen: Seen[] = [];
    let session = 0;
    surviving(conn, seen, async (cfg) => {
      if (String(cfg.url).includes('logoff')) {
        throw new Error('logoff is not reachable');
      }
      session += 1;
      return {
        status: 200,
        data: '<service/>',
        headers: {
          'x-csrf-token': 'TOKEN',
          'set-cookie': [`SAP_SESSIONID_STUB_100=S${session}%3d; path=/`],
        },
      };
    });

    for (let cycle = 0; cycle < 8; cycle++) {
      await conn.connect();
      await conn.disconnect({ deadlineMs: 1000 });
    }

    const logoffs = seen.filter((r) => r.url.includes('/logoff'));
    // Three attempts per session at most, not one per session per teardown.
    expect(logoffs.length).toBeLessThanOrEqual(8 * 3);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Giving up on releasing a server session'),
    );
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

  /**
   * The attempt limit lives on both failure paths or on neither. A request that
   * cannot even be built never reaches the rejection handler, so counting the
   * attempt there and giving up only here left that path retrying for ever —
   * the cost the limit was added to stop.
   */
  it('gives up too when the request cannot be built at all', async () => {
    const logger = makeLogger();
    const conn = new BaseAbapConnection(baseConfig, logger);
    const seen: Seen[] = [];
    surviving(conn, seen, async () => ({
      status: 200,
      data: '<service/>',
      headers: {
        'x-csrf-token': 'TOKEN',
        'set-cookie': ['SAP_SESSIONID_STUB_100=S1%3d; path=/'],
      },
    }));

    await conn.connect();
    // Assembling the header throws, as a Kerberos connection with no cookie and
    // no token does.
    (conn as any).getAuthHeaders = async () => {
      throw new Error('no credential to build a header from');
    };

    for (let attempt = 0; attempt < 5; attempt++) {
      await conn.disconnect({ deadlineMs: 100 });
    }

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Giving up on releasing a server session'),
    );
    // Dropped rather than kept for ever.
    expect((conn as any).owedReleaseCookies.size).toBe(0);
  });

  /**
   * The loop walks a snapshot and awaits inside it, so a release for a LATER key
   * can land during an earlier iteration's await. Its success handler drops that
   * key — and reaching it afterwards sent a second logoff for a session already
   * closed and put it back on the owed list, where every later teardown retried
   * it.
   */
  it('does not re-close a session released while the list is being walked', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    const seen: Seen[] = [];
    let session = 0;
    let landS2: (() => void) | undefined;
    surviving(conn, seen, async (cfg) => {
      const cookie = String(cfg.headers?.Cookie ?? '');
      if (String(cfg.url).includes('logoff')) {
        if (cookie.includes('S1')) {
          // Fails at once: S1 stays owed and nothing is in flight for it.
          throw new Error('S1 logoff refused');
        }
        // S2 hangs until the test lands it.
        await new Promise<void>((resolve) => {
          landS2 = resolve;
        });
        return { status: 200, data: '', headers: {} };
      }
      session += 1;
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
    await conn.disconnect({ deadlineMs: 50 }); // S1 owed, release failed
    await conn.connect();
    await conn.disconnect({ deadlineMs: 0 }); // S2 dispatched and hanging

    // The third teardown walks [S1, S2]. While S1 is assembling its request,
    // S2's release lands and its handler drops S2 — the window this guards.
    const realHeaders = (conn as any).getAuthHeaders.bind(conn);
    let first = true;
    (conn as any).getAuthHeaders = async () => {
      const headers = await realHeaders();
      if (first) {
        first = false;
        landS2?.();
        await new Promise((r) => setTimeout(r, 5));
      }
      return headers;
    };

    await conn.disconnect({ deadlineMs: 50 });

    const s2Logoffs = seen.filter(
      (r) =>
        r.url.includes('/logoff') && String(r.headers.Cookie).includes('S2'),
    );
    expect(s2Logoffs).toHaveLength(1);
    // And it is not owed again: it was released.
    expect([...(conn as any).owedReleaseCookies.keys()].join()).not.toContain(
      'S2',
    );
  });

  /**
   * "A repeat call performs whatever is still owed" — including the waiting. A
   * caller that comes back with a budget to find out whether the session closed
   * got no wait at all, because its own cookies were cleared by the first call
   * and it therefore had no session to look up.
   */
  it('a repeat call waits for the release it is still owed', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    const seen: Seen[] = [];
    let landLogoff: (() => void) | undefined;
    let landed = false;
    surviving(conn, seen, async (cfg) => {
      if (String(cfg.url).includes('logoff')) {
        await new Promise<void>((resolve) => {
          landLogoff = () => {
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
    await conn.disconnect({ deadlineMs: 0 }); // dispatched, not waited for
    expect(landed).toBe(false);

    let repeatDone = false;
    const repeat = conn.disconnect({ deadlineMs: 30_000 }).then(() => {
      repeatDone = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(repeatDone).toBe(false); // it asked to wait, and it is waiting

    landLogoff?.();
    await repeat;
    expect(landed).toBe(true);
  });

  it('keeps one session owed while another is released', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    const seen: Seen[] = [];
    let session = 0;
    surviving(conn, seen, async (cfg) => {
      if (String(cfg.url).includes('logoff')) {
        // The first session's release fails; the second's succeeds.
        if (String(cfg.headers?.Cookie ?? '').includes('S1')) {
          throw new Error('network is down');
        }
        return { status: 200, data: '', headers: {} };
      }
      session += 1;
      return {
        status: 200,
        data: '<service/>',
        headers: {
          'x-csrf-token': 'TOKEN',
          'set-cookie': [`SAP_SESSIONID_STUB_100=S${session}%3d; path=/`],
        },
      };
    });

    // A deadline so each release has settled before the next step, which is
    // what makes the sequence deterministic rather than timing-dependent.
    await conn.connect();
    await conn.disconnect({ deadlineMs: 1000 });
    await conn.connect();
    await conn.disconnect({ deadlineMs: 1000 });

    const before = seen.filter((r) => r.url.includes('/logoff')).length;
    await conn.disconnect({ deadlineMs: 1000 });
    const retried = seen.filter((r) => r.url.includes('/logoff')).slice(before);

    // S2 was released, so nothing is owed for it. S1 was not, so it is retried
    // — a success for one session must not discard what is owed for another.
    expect(retried).toHaveLength(1);
    expect(retried[0].headers.Cookie).toContain('S1');
  });

  it('retries every session still owed, not just the last', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    const seen: Seen[] = [];
    let session = 0;
    let logoffWorks = false;
    surviving(conn, seen, async (cfg) => {
      if (String(cfg.url).includes('logoff')) {
        if (!logoffWorks) throw new Error('network is down');
        return { status: 200, data: '', headers: {} };
      }
      session += 1;
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
    await conn.disconnect({ deadlineMs: 1000 });
    await conn.connect();
    await conn.disconnect({ deadlineMs: 1000 });

    // Two sessions owed, neither released. The server comes back.
    logoffWorks = true;
    const before = seen.filter((r) => r.url.includes('/logoff')).length;
    await conn.disconnect({ deadlineMs: 1000 });
    const retried = seen.filter((r) => r.url.includes('/logoff')).slice(before);

    expect(retried).toHaveLength(2);
    expect(retried.map((r) => r.headers.Cookie).join(' ')).toContain('S1');
    expect(retried.map((r) => r.headers.Cookie).join(' ')).toContain('S2');
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
      if (gateArmed && !String(cfg.url).includes('logoff')) {
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

  /**
   * "A repeat call performs whatever is still owed — a transport release that
   * did not complete" — ISessionLifecycleAware.disconnect. clearSessionState()
   * drops the live cookies as it must, so the ones a failed release still needs
   * are kept aside; otherwise the documented way to finish the job sends
   * nothing and the session lives out its 1800 s.
   */
  it('re-sends the logoff when the first one failed', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    const seen: Seen[] = [];
    let failLogoff = true;
    attachMockAxios(conn, seen, async (cfg) => {
      if (String(cfg.url).includes('logoff') && failLogoff) {
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
    await conn.disconnect({ deadlineMs: 1000 });
    expect(seen.filter((r) => r.url.includes('/logoff'))).toHaveLength(1);

    failLogoff = false;
    // clearSessionState() drops the axios instance, so the double has to be put
    // back — otherwise the retry goes out over a real one and this asserts
    // nothing. The cookies it needs are the connection's own to remember.
    attachMockAxios(conn, seen, async () => ({
      status: 200,
      data: '',
      headers: {},
    }));
    await conn.disconnect({ deadlineMs: 1000 });

    const logoffs = seen.filter((r) => r.url.includes('/logoff'));
    expect(logoffs).toHaveLength(2);
    // Still the session's own cookie: the permission to close it is holding it.
    expect(logoffs[1].headers.Cookie).toContain('SAP_SESSIONID_STUB_100');
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
   * The logoff ends the session a lock chain is running on, so sending it mid
   * chain leaves the object locked and inactive — the damage this whole change
   * exists to prevent, caused by the change itself. `beginCriticalSection()` is
   * how a caller says that chain must not be cut, and it is honoured here as it
   * already is for timeouts.
   */
  it('defers the logoff while a critical section is open', async () => {
    const logger = makeLogger();
    const conn = new BaseAbapConnection(baseConfig, logger);
    const seen: Seen[] = [];
    attachMockAxios(conn, seen);

    await conn.connect();
    conn.beginCriticalSection();
    await conn.disconnect({ deadlineMs: 1000 });

    expect(seen.filter((r) => r.url.includes('/logoff'))).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('critical section'),
    );
    // The caller asked to disconnect, and is disconnected.
    expect(conn.isConnected()).toBe(false);
  });

  it('releases the deferred session once the chain has finished', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    const seen: Seen[] = [];
    attachMockAxios(conn, seen);

    await conn.connect();
    conn.beginCriticalSection();
    await conn.disconnect({ deadlineMs: 1000 });
    expect(seen.filter((r) => r.url.includes('/logoff'))).toHaveLength(0);

    conn.endCriticalSection();
    // clearSessionState() dropped the axios instance with the first teardown.
    attachMockAxios(conn, seen, async () => ({
      status: 200,
      data: '',
      headers: {},
    }));
    await conn.disconnect({ deadlineMs: 1000 });

    const logoffs = seen.filter((r) => r.url.includes('/logoff'));
    expect(logoffs).toHaveLength(1);
    expect(logoffs[0].headers.Cookie).toContain('SAP_SESSIONID_STUB_100');
  });

  it('sends nothing when there is no session to end', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    const seen: Seen[] = [];
    attachMockAxios(conn, seen);

    await conn.disconnect();

    expect(seen).toHaveLength(0);
  });
});
