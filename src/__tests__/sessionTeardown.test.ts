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
      'set-cookie': ['SAP_SESSIONID_E19_100=abc%3d; path=/'],
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
  it('warns when the server issued no SAP_SESSIONID', async () => {
    const logger = makeLogger();
    const conn = new BaseAbapConnection(baseConfig, logger);
    // What an on-prem server answers when it will not open a session: the CSRF
    // cookie, and nothing to hold a lock against.
    attachMockAxios(conn, [], async () => ({
      status: 200,
      data: '<service/>',
      headers: {
        'x-csrf-token': 'TOKEN',
        'set-cookie': ['sap-XSRF_E19_100=xyz; path=/'],
      },
    }));

    await conn.connect();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no SAP_SESSIONID'),
    );
    expect(conn.getSessionIdentity()).toBeNull();
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
    expect(logoff?.headers.Cookie).toContain('SAP_SESSIONID_E19_100');
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
          'set-cookie': ['SAP_SESSIONID_E19_100=abc%3d; path=/'],
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
          'set-cookie': ['SAP_SESSIONID_E19_100=abc%3d; path=/'],
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
          'set-cookie': ['SAP_SESSIONID_E19_100=abc%3d; path=/'],
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

  it('a deadline bounds how long the logoff may take', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    const seen: Seen[] = [];
    attachMockAxios(conn, seen);

    await conn.connect();
    await conn.disconnect({ deadlineMs: 250 });

    const logoff = seen.find((r) => r.url.includes('/logoff'));
    expect(logoff).toBeDefined();
    // The budget reaches axios rather than this method's own idea of patience.
    expect(logoff?.timeout).toBeGreaterThan(0);
    expect(logoff?.timeout).toBeLessThanOrEqual(250);
  });

  it.each([[-1], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'refuses a deadlineMs of %p before tearing anything down',
    async (deadlineMs) => {
      const conn = new BaseAbapConnection(baseConfig, makeLogger());
      attachMockAxios(conn, []);
      await conn.connect();

      await expect(conn.disconnect({ deadlineMs })).rejects.toThrow(TypeError);
      // Still the caller's connection: nothing was torn down on a bad argument.
      expect(conn.isConnected()).toBe(true);
    },
  );

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
          'set-cookie': ['SAP_SESSIONID_E19_100=abc%3d; path=/'],
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

  it('sends nothing when there is no session to end', async () => {
    const conn = new BaseAbapConnection(baseConfig, makeLogger());
    const seen: Seen[] = [];
    attachMockAxios(conn, seen);

    await conn.disconnect();

    expect(seen).toHaveLength(0);
  });
});
