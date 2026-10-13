/**
 * No deadline but the caller's own.
 *
 * A client deadline closes the socket, and SAP then ends the synchronous
 * request that was running on it — a write in it is lost. So nothing this
 * package sends carries a deadline of its own choosing: not the CSRF fetch,
 * not the cloud preflight, not an ADT request inside a critical section. A
 * request carries the caller's `timeout` when the caller passed one, outside a
 * critical section, and nothing otherwise.
 *
 * Read at the axios call itself — the wire's client is replaced by a recorder —
 * so what is asserted is what would have gone out, whatever the layers above
 * did on the way.
 */
import { BasicAuthProvider } from '@mcp-abap-adt/auth-providers';
import type { SapConfig } from '../config/sapConfig.js';
import type { AbapRequestOptions } from '../connection/AbapConnection.js';
import { AdtCloudConnector } from '../connection/AdtCloudConnector.js';
import { GenericWebSocketTransport } from '../connection/GenericWebSocketTransport.js';
import type { HttpTransport } from '../connection/HttpTransport.js';
import * as api from '../index.js';
import { cloudHttpTransport, onPrem } from './helpers/onPrem.js';

const config: SapConfig = {
  url: 'https://sap.example.com',
  authType: 'basic',
  username: 'u',
  password: 'p',
  client: '100',
};

/**
 * A request as a JavaScript caller may write it: without `timeout`, which the
 * contract's type (interfaces-adt-connection 3) still requires.
 */
const untimed = (options: Omit<AbapRequestOptions, 'timeout'>) =>
  options as AbapRequestOptions;

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  timeout?: number;
  hasTimeout: boolean;
}

/**
 * Replaces the wire's axios instance with one that records each call's config
 * and answers like SAP: discovery with a token and a session, the cloud
 * session resource with its document, everything else 200 — or, for the
 * first mutation when `refuseFirstMutation` is set, 403 CSRF.
 */
function recordAxios(
  transport: HttpTransport,
  options: { refuseFirstMutation?: boolean } = {},
): Sent[] {
  const sent: Sent[] = [];
  let refused = false;
  (transport as unknown as { instance: unknown }).instance = async (
    cfg: Record<string, unknown>,
  ) => {
    const method = String(cfg.method).toUpperCase();
    sent.push({
      url: String(cfg.url),
      method,
      headers: cfg.headers as Record<string, string>,
      timeout: cfg.timeout as number | undefined,
      hasTimeout: 'timeout' in cfg,
    });
    const url = String(cfg.url);
    if (url.includes('/core/http/sessions')) {
      return {
        status: 200,
        statusText: 'OK',
        headers: { 'set-cookie': ['SAP_SESSIONID_TRL_100=c1; path=/'] },
        data: '<session/>',
      };
    }
    if (url.includes('/discovery')) {
      return {
        status: 200,
        statusText: 'OK',
        headers: {
          'x-csrf-token': `T${sent.length}`,
          'set-cookie': ['SAP_SESSIONID_ABC_100=s1; path=/'],
        },
        data: '',
      };
    }
    if (
      options.refuseFirstMutation &&
      !refused &&
      ['POST', 'PUT', 'DELETE'].includes(method)
    ) {
      refused = true;
      const error = new Error(
        'Request failed with status code 403',
      ) as Error & {
        response: unknown;
      };
      error.response = {
        status: 403,
        statusText: 'Forbidden',
        headers: {},
        data: 'CSRF token validation failed',
      };
      throw error;
    }
    return { status: 200, statusText: 'OK', headers: {}, data: 'ok' };
  };
  return sent;
}

describe('no built-in deadline', () => {
  it('exports nothing that hands out a deadline', () => {
    const exported = api as Record<string, unknown>;
    expect(exported.getTimeout).toBeUndefined();
    expect(exported.getTimeoutConfig).toBeUndefined();
    expect(exported.getCriticalSectionTimeout).toBeUndefined();
  });

  it('reads no SAP_TIMEOUT_* variable: a configured one changes nothing', async () => {
    const saved = { ...process.env };
    process.env.SAP_TIMEOUT_CSRF = '1234';
    process.env.SAP_TIMEOUT_CRITICAL = '5678';
    process.env.SAP_TIMEOUT_DEFAULT = '91011';
    try {
      const conn = onPrem(config);
      const sent = recordAxios(conn.transport);
      await conn.connect();
      conn.beginCriticalSection();
      await conn.makeAdtRequest(
        untimed({ url: '/sap/bc/adt/x', method: 'GET' }),
      );
      conn.endCriticalSection();
      await conn.makeAdtRequest(
        untimed({ url: '/sap/bc/adt/x', method: 'GET' }),
      );
      expect(sent.every((request) => !request.hasTimeout)).toBe(true);
    } finally {
      process.env = saved;
    }
  });

  it('the CSRF fetch of connect() carries no deadline', async () => {
    const conn = onPrem(config);
    const sent = recordAxios(conn.transport);

    await conn.connect();

    const fetches = sent.filter((request) => request.url.includes('discovery'));
    expect(fetches).toHaveLength(1);
    expect(fetches[0].hasTimeout).toBe(false);
  });

  it('the CSRF fetch a refused token triggers carries no deadline, though the request has the caller’s', async () => {
    const conn = onPrem(config);
    const sent = recordAxios(conn.transport, { refuseFirstMutation: true });
    await conn.connect();

    await conn.makeAdtRequest({
      url: '/sap/bc/adt/x',
      method: 'POST',
      data: 'x',
      timeout: 7000,
    });

    const fetches = sent.filter((request) => request.url.includes('discovery'));
    // connect()'s, and the one the 403 asked for.
    expect(fetches).toHaveLength(2);
    expect(fetches.every((request) => !request.hasTimeout)).toBe(true);
    const posts = sent.filter((request) => request.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts.every((request) => request.timeout === 7000)).toBe(true);
  });

  it('the cloud preflight carries no deadline', async () => {
    const transport = cloudHttpTransport(config);
    const conn = new AdtCloudConnector(
      config,
      new BasicAuthProvider('u', 'p'),
      transport,
    );
    const sent = recordAxios(transport);

    await conn.connect();

    const preflight = sent.filter((request) =>
      request.url.includes('/core/http/sessions'),
    );
    expect(preflight).toHaveLength(1);
    expect(preflight[0].hasTimeout).toBe(false);
  });

  it('a request outside a critical section carries the caller’s timeout, and none when the caller passed none', async () => {
    const conn = onPrem(config);
    const sent = recordAxios(conn.transport);
    await conn.connect();

    await conn.makeAdtRequest({
      url: '/sap/bc/adt/x',
      method: 'GET',
      timeout: 30000,
    });
    await conn.makeAdtRequest(untimed({ url: '/sap/bc/adt/y', method: 'GET' }));
    await conn.makeAdtRequest({
      url: '/sap/bc/adt/z',
      method: 'GET',
      timeout: 0,
    });

    const at = (path: string) =>
      sent.find((request) => request.url.endsWith(path));
    expect(at('/sap/bc/adt/x')?.timeout).toBe(30000);
    expect(at('/sap/bc/adt/y')?.hasTimeout).toBe(false);
    // `0` is the caller's own value, passed as it is: axios reads it as none.
    expect(at('/sap/bc/adt/z')?.timeout).toBe(0);
  });

  it('a request inside a critical section carries no deadline, not even the caller’s', async () => {
    const conn = onPrem(config);
    const sent = recordAxios(conn.transport);
    await conn.connect();

    conn.beginCriticalSection();
    try {
      await conn.makeAdtRequest({
        url: '/sap/bc/adt/locked',
        method: 'GET',
        timeout: 30000,
      });
      await conn.makeAdtRequest({
        url: '/sap/bc/adt/written',
        method: 'POST',
        data: 'x',
        timeout: 30000,
      });
    } finally {
      conn.endCriticalSection();
    }
    await conn.makeAdtRequest({
      url: '/sap/bc/adt/after',
      method: 'GET',
      timeout: 30000,
    });

    const at = (path: string) =>
      sent.find((request) => request.url.endsWith(path));
    expect(at('/sap/bc/adt/locked')?.hasTimeout).toBe(false);
    expect(at('/sap/bc/adt/written')?.hasTimeout).toBe(false);
    // The section over, the caller's own applies again.
    expect(at('/sap/bc/adt/after')?.timeout).toBe(30000);
  });

  it('the CSRF recovery inside a critical section carries no deadline either', async () => {
    const conn = onPrem(config);
    const sent = recordAxios(conn.transport, { refuseFirstMutation: true });
    await conn.connect();

    conn.beginCriticalSection();
    try {
      await conn.makeAdtRequest({
        url: '/sap/bc/adt/x',
        method: 'PUT',
        data: 'x',
        timeout: 30000,
      });
    } finally {
      conn.endCriticalSection();
    }

    const puts = sent.filter((request) => request.method === 'PUT');
    // The refused one and its resend, both without a deadline.
    expect(puts).toHaveLength(2);
    expect(puts.every((request) => !request.hasTimeout)).toBe(true);
  });
});

describe('the WebSocket connect', () => {
  function fakeSocket() {
    const socket: Record<string, unknown> & {
      readyState: number;
      open(): void;
    } = {
      readyState: 0,
      send: () => {},
      close: () => {},
      open() {
        this.readyState = 1;
        (this.onopen as () => void)();
      },
    };
    return socket;
  }

  it('sets no timer of its own when the caller passes no connectTimeoutMs', async () => {
    const socket = fakeSocket();
    const transport = new GenericWebSocketTransport({
      create: () => socket as never,
    });
    const timers = jest.spyOn(global, 'setTimeout');
    try {
      const connecting = transport.connect('wss://sap.example.com/ws');
      expect(timers).not.toHaveBeenCalled();
      socket.open();
      await connecting;
    } finally {
      timers.mockRestore();
    }
  });

  it('keeps the caller’s connectTimeoutMs', async () => {
    jest.useFakeTimers();
    try {
      const transport = new GenericWebSocketTransport({
        create: () => fakeSocket() as never,
      });
      const connecting = transport.connect('wss://sap.example.com/ws', {
        connectTimeoutMs: 50,
      });
      const failed = expect(connecting).rejects.toThrow(
        'WebSocket connect timeout after 50ms',
      );
      jest.advanceTimersByTime(50);
      await failed;
    } finally {
      jest.useRealTimers();
    }
  });
});
