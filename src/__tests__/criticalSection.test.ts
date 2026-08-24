/**
 * Critical section (uninterruptible lock → modify → unlock).
 *
 * A short per-request timeout must NOT abort a request while the connection is
 * inside a critical section. Not because the abort ends anything on the server:
 * it does not. A session is the server's, addressed by `SAP_SESSIONID`, and only
 * the server ends it — on an idle timeout this side cannot influence, or when
 * told. It outlives the socket, which is why SM04 shows sessions left behind by
 * connections that never said they were finished, and why a lock goes when its
 * session goes rather than when a connection drops.
 *
 * What the abort ends is what THIS side knows: whether the modification was
 * applied becomes unknowable, and the handle `unlock` needs is gone — while the
 * lock and the session holding it sit there until that server timeout. So the
 * lock is stranded by the session SURVIVING, not by anything dying. While in a
 * critical section, makeAdtRequest raises the effective timeout to the large
 * SAP_TIMEOUT_CRITICAL ceiling.
 */

import type { SapConfig } from '../config/sapConfig.js';
import type { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import type { ILogger } from '../logger.js';
import { onPrem } from './helpers/onPrem.js';
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
  conn: AdtOnPremConnector,
  fn: (cfg: any) => Promise<any>,
): void {
  (conn as any).transport.send = fn;
}

describe('critical section (uninterruptible lock → unlock)', () => {
  const prevCritical = process.env.SAP_TIMEOUT_CRITICAL;
  beforeAll(() => {
    process.env.SAP_TIMEOUT_CRITICAL = '600000';
  });
  afterAll(() => {
    if (prevCritical === undefined) delete process.env.SAP_TIMEOUT_CRITICAL;
    else process.env.SAP_TIMEOUT_CRITICAL = prevCritical;
  });

  it('begin/end is reference-counted and clamped at zero', () => {
    const conn = onPrem(baseConfig, mockLogger);
    markConnectedForTest(conn);
    expect(conn.isInCriticalSection()).toBe(false);

    conn.beginCriticalSection();
    conn.beginCriticalSection();
    expect(conn.isInCriticalSection()).toBe(true);

    conn.endCriticalSection();
    expect(conn.isInCriticalSection()).toBe(true); // still nested

    conn.endCriticalSection();
    expect(conn.isInCriticalSection()).toBe(false);

    conn.endCriticalSection(); // extra end is harmless
    expect(conn.isInCriticalSection()).toBe(false);
  });

  it('uses the short per-request timeout when NOT in a critical section', async () => {
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

    expect(captured.timeout).toBe(30000);
  });

  it('raises the timeout to the large ceiling while in a critical section, then restores it', async () => {
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
    // short 30s timeout was raised to the 600s critical-section ceiling
    expect(captured.timeout).toBe(600000);

    // after the section ends, the normal per-request timeout applies again
    await conn.makeAdtRequest({
      url: '/sap/bc/adt/x',
      method: 'GET',
      timeout: 30000,
    });
    expect(captured.timeout).toBe(30000);
  });
});
