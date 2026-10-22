/**
 * Critical section (uninterruptible lock → modify → unlock).
 *
 * No deadline may cut a request while the connection is inside a critical
 * section — not even the caller's own. A client deadline closes the socket, and
 * SAP then ends the synchronous request that was running on it: a write in it
 * is lost. The session itself survives — it is the server's, addressed by
 * `SAP_SESSIONID` — so the lock stays held in it, while what THIS side knew is
 * gone: whether the modification was applied, and the handle `unlock` needs.
 * While in a critical section, a request carries no timeout at all.
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import type { SapConfig } from '../config/sapConfig.js';
import type { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import type { ILogger } from '../logger.js';
import { onPrem } from './helpers/onPrem.js';
import { markConnectedForTest } from './helpers/session.js';

const mockLogger: ILogger = {
  info: mock.fn(),
  warn: mock.fn(),
  error: mock.fn(),
  debug: mock.fn(),
};

const baseConfig: SapConfig = {
  url: 'https://sap.example.com',
  authType: 'basic',
  username: 'u',
  password: 'p',
  client: '100',
};

function attachMockAxios(
  conn: AdtOnPremConnector,
  fn: (cfg: any) => Promise<any>,
): void {
  (conn as any).transport.send = fn;
}

describe('critical section (uninterruptible lock → unlock)', () => {
  it('begin/end is reference-counted and clamped at zero', () => {
    const conn = onPrem(baseConfig, mockLogger);
    markConnectedForTest(conn);
    assert.strictEqual(conn.isInCriticalSection(), false);

    conn.beginCriticalSection();
    conn.beginCriticalSection();
    assert.strictEqual(conn.isInCriticalSection(), true);

    conn.endCriticalSection();
    assert.strictEqual(conn.isInCriticalSection(), true); // still nested

    conn.endCriticalSection();
    assert.strictEqual(conn.isInCriticalSection(), false);

    conn.endCriticalSection(); // extra end is harmless
    assert.strictEqual(conn.isInCriticalSection(), false);
  });

  it('passes the caller’s own timeout through when NOT in a critical section', async () => {
    const conn = onPrem(baseConfig, mockLogger);
    markConnectedForTest(conn);
    let captured: any;
    attachMockAxios(conn, async (cfg) => {
      captured = cfg;
      return { status: 200, data: 'ok', headers: {} };
    });

    await conn.makeAdtRequest({
      url: '/sap/bc/adt/x',
      method: 'GET',
      timeout: 30000,
    });

    assert.strictEqual(captured.timeout, 30000);
  });

  it('sends no timeout at all while in a critical section, then the caller’s again', async () => {
    const conn = onPrem(baseConfig, mockLogger);
    markConnectedForTest(conn);
    let captured: any;
    attachMockAxios(conn, async (cfg) => {
      captured = cfg;
      return { status: 200, data: 'ok', headers: {} };
    });

    conn.beginCriticalSection();
    try {
      await conn.makeAdtRequest({
        url: '/sap/bc/adt/x',
        method: 'GET',
        timeout: 30000,
      });
    } finally {
      conn.endCriticalSection();
    }
    // The caller's 30 s is not applied: inside the section nothing may cut
    // the request, and no ceiling of the library's own replaces it.
    assert.strictEqual('timeout' in captured, false);

    // after the section ends, the normal per-request timeout applies again
    await conn.makeAdtRequest({
      url: '/sap/bc/adt/x',
      method: 'GET',
      timeout: 30000,
    });
    assert.strictEqual(captured.timeout, 30000);
  });
});
