/**
 * RFC connection smoke test for E19.
 *
 * Verifies that RfcAbapConnection can open, make one ADT request, and close.
 *
 * Run:
 *   npx jest --testPathPattern=rfc-e19-smoke
 */

import * as dotenv from 'dotenv';
import type { SapConfig } from '../config/sapConfig.js';
import { createAbapConnection } from '../connection/connectionFactory.js';
import { RfcAbapConnection } from '../connection/RfcAbapConnection.js';
import type { ILogger } from '../logger.js';

dotenv.config({ path: 'e19.env' });

const logger: ILogger = {
  info: console.log,
  warn: console.warn,
  error: console.error,
  debug: console.log,
};

function canRun(): boolean {
  return !!(
    process.env.SAP_URL &&
    process.env.SAP_USERNAME &&
    process.env.SAP_PASSWORD &&
    process.env.SAP_CLIENT
  );
}

const describeIfEnv = canRun() ? describe : describe.skip;

describeIfEnv('RFC smoke test — E19', () => {
  let conn: RfcAbapConnection;

  const config: SapConfig = {
    url: process.env.SAP_URL!,
    client: process.env.SAP_CLIENT!,
    username: process.env.SAP_USERNAME!,
    password: process.env.SAP_PASSWORD!,
    authType: 'basic',
    connectionType: 'rfc',
  };

  beforeAll(async () => {
    conn = createAbapConnection(config, logger) as RfcAbapConnection;
    await conn.connect();
  }, 20_000);

  afterAll(async () => {
    await conn?.close();
  });

  it('opens RFC connection to E19', () => {
    expect(conn).toBeInstanceOf(RfcAbapConnection);
    expect(conn.getSessionId()).toBeTruthy();
  });

  it('GET /sap/bc/adt/compatibility/graph returns 200', async () => {
    const resp = await conn.makeAdtRequest({
      method: 'GET',
      url: '/sap/bc/adt/compatibility/graph',
      headers: { Accept: 'application/xml' },
      timeout: 15_000,
    });

    expect(resp.status).toBe(200);
    expect(typeof resp.data).toBe('string');
    expect(resp.data).toContain('<');
  }, 20_000);
});
