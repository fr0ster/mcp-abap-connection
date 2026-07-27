/**
 * The CSRF token fetch must stay inside the ADT conversation.
 *
 * `makeAdtRequest` sends `sap-adt-connection-id` on every request, for all
 * session types. The token fetch used to assemble its own headers and omit it,
 * so a fetch triggered while a lock was held reached the server as a caller
 * that merely presented the same cookies. That is invisible from the outside:
 * the client-side id stays stable while the server sees an unrelated request.
 */
import type { SapConfig } from '../config/sapConfig.js';
import { BaseAbapConnection } from '../connection/BaseAbapConnection.js';
import type { ILogger } from '../logger.js';
import { markConnectedForTest } from './helpers/session.js';

const mockLogger: ILogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

const baseConfig: SapConfig = {
  url: 'https://sap.example.com',
  authType: 'basic',
  username: 'u',
  password: 'p',
  client: '100',
};

function attachMockAxios(
  conn: BaseAbapConnection,
  fn: (cfg: any) => Promise<any>,
): void {
  (conn as any).axiosInstance = fn;
}

describe('CSRF fetch stays in the ADT conversation', () => {
  it('sends sap-adt-connection-id on the token fetch', async () => {
    const conn = new BaseAbapConnection(baseConfig, mockLogger);
    markConnectedForTest(conn);
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    attachMockAxios(conn, async (cfg) => {
      seen.push({ url: cfg.url, headers: cfg.headers ?? {} });
      return {
        status: 200,
        data: '<service/>',
        headers: { 'x-csrf-token': 'TOKEN' },
      };
    });

    // A mutation with no cached token forces the fetch first.
    await conn.makeAdtRequest({
      url: '/sap/bc/adt/ddic/domains/zx?_action=LOCK&accessMode=MODIFY',
      method: 'POST',
      timeout: 5000,
      data: null,
    });

    const fetches = seen.filter((r) => r.headers['x-csrf-token'] === 'fetch');
    expect(fetches.length).toBeGreaterThan(0);
    for (const fetch of fetches) {
      expect(fetch.headers['sap-adt-connection-id']).toBe(conn.getSessionId());
    }
  });

  it('uses the same connection id on the fetch and on the request that follows', async () => {
    const conn = new BaseAbapConnection(baseConfig, mockLogger);
    markConnectedForTest(conn);
    conn.setSessionType('stateful');
    const seen: Array<Record<string, string>> = [];
    attachMockAxios(conn, async (cfg) => {
      seen.push(cfg.headers ?? {});
      return {
        status: 200,
        data: '<service/>',
        headers: { 'x-csrf-token': 'TOKEN' },
      };
    });

    await conn.makeAdtRequest({
      url: '/sap/bc/adt/ddic/domains/zx?_action=LOCK&accessMode=MODIFY',
      method: 'POST',
      timeout: 5000,
      data: null,
    });

    const ids = seen
      .map((h) => h['sap-adt-connection-id'])
      .filter((v): v is string => Boolean(v));
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(1);
  });
});
