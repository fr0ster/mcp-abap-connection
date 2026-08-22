/**
 * Integration tests for RfcAbapConnection via @mcp-abap-adt/sap-rfc-lite.
 *
 * Requires:
 *   - SAP NW RFC SDK installed (SAPNWRFC_HOME set)
 *   - @mcp-abap-adt/sap-rfc-lite installed
 *   - An env file (e.g. e19.env) with SAP_URL, SAP_USERNAME, SAP_PASSWORD,
 *     SAP_CLIENT, SAP_CONNECTION_TYPE=rfc
 *
 * Run:
 *   SAP_ENV_FILE=e19.env npx jest --testPathPattern=rfc-connection
 */

import * as dotenv from 'dotenv';
import type { SapConfig } from '../config/sapConfig.js';
import { createAbapConnection } from '../connection/connectionFactory.js';
import { RfcAbapConnection } from '../connection/RfcAbapConnection.js';
import type { ILogger } from '../logger.js';

// Load env file — default to e19.env, override via SAP_ENV_FILE
const envFile = process.env.SAP_ENV_FILE || 'e19.env';
dotenv.config({ path: envFile });

const logger: ILogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

function buildConfig(): SapConfig {
  return {
    url: process.env.SAP_URL!,
    client: process.env.SAP_CLIENT!,
    username: process.env.SAP_USERNAME!,
    password: process.env.SAP_PASSWORD!,
    authType: (process.env.SAP_AUTH_TYPE as any) || 'basic',
    connectionType: 'rfc',
  };
}

function canRun(): boolean {
  return !!(
    process.env.SAP_URL &&
    process.env.SAP_USERNAME &&
    process.env.SAP_PASSWORD &&
    process.env.SAP_CLIENT
  );
}

const describeIfRfc = canRun() ? describe : describe.skip;

describeIfRfc('RfcAbapConnection (integration)', () => {
  let conn: RfcAbapConnection;

  beforeAll(async () => {
    const config = buildConfig();
    conn = createAbapConnection(config, logger) as RfcAbapConnection;
    await conn.connect();
  }, 15_000);

  afterAll(async () => {
    await conn?.close();
  });

  it('should create RfcAbapConnection via factory', () => {
    expect(conn).toBeInstanceOf(RfcAbapConnection);
  });

  it('should return base URL matching config', async () => {
    const baseUrl = await conn.getBaseUrl();
    expect(baseUrl).toBe(process.env.SAP_URL);
  });

  it('should return a session ID', () => {
    const sessionId = conn.getSessionId();
    expect(sessionId).toBeTruthy();
    expect(typeof sessionId).toBe('string');
  });

  it('should GET /sap/bc/adt/compatibility/graph', async () => {
    const resp = await conn.makeAdtRequest({
      method: 'GET',
      url: '/sap/bc/adt/compatibility/graph',
      headers: { Accept: 'application/xml' },
      timeout: 10_000,
    });

    expect(resp.status).toBe(200);
    expect(typeof resp.data).toBe('string');
  }, 15_000);

  it('should return response headers', async () => {
    const resp = await conn.makeAdtRequest({
      method: 'GET',
      url: '/sap/bc/adt/compatibility/graph',
      headers: { Accept: 'application/xml' },
      timeout: 10_000,
    });

    expect(resp.headers).toBeDefined();
    expect(resp.headers['content-type']).toBeDefined();
  }, 15_000);

  it('should handle query params', async () => {
    const resp = await conn.makeAdtRequest({
      method: 'GET',
      url: '/sap/bc/adt/compatibility/graph',
      headers: { Accept: 'application/xml' },
      params: { sap_language: 'EN' },
      timeout: 10_000,
    });

    expect(resp.status).toBe(200);
  }, 15_000);

  it('should return 404 for non-existent resource', async () => {
    await expect(
      conn.makeAdtRequest({
        method: 'GET',
        url: '/sap/bc/adt/programs/programs/ZZZZ_NONEXISTENT_99999',
        headers: { Accept: 'application/xml' },
        timeout: 10_000,
      }),
    ).rejects.toThrow(/4(0[0-9]|1[0-9]|2[0-9]|[0-9]{2})/);
  }, 15_000);

  it('should support stateful session type', () => {
    conn.setSessionType('stateful');
    // No error — session type accepted
    conn.setSessionType('stateless');
  });
});

describeIfRfc('RfcAbapConnection validation', () => {
  it('should reject config without connectionType=rfc', () => {
    const config = buildConfig();
    config.connectionType = 'http' as any;
    expect(() => new RfcAbapConnection(config, logger)).toThrow(
      'RFC connection expects connectionType "rfc"',
    );
  });

  it('should reject config without url', () => {
    const config = buildConfig();
    config.url = '';
    expect(() => new RfcAbapConnection(config, logger)).toThrow(
      'RFC connection requires url',
    );
  });

  it('should reject config without credentials', () => {
    const config = buildConfig();
    config.username = '';
    config.password = '';
    expect(() => new RfcAbapConnection(config, logger)).toThrow(
      'RFC connection requires both username and password',
    );
  });

  it('should reject config without client', () => {
    const config = buildConfig();
    config.client = '';
    expect(() => new RfcAbapConnection(config, logger)).toThrow(
      'RFC connection requires SAP client',
    );
  });
});
