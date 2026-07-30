/**
 * Unit tests for RfcAbapConnection parameter derivation and error serialization.
 */

import { RfcAbapConnection } from '../connection/RfcAbapConnection.js';
import type { ILogger } from '../logger.js';

const logger: ILogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

function baseConfig() {
  return {
    url: 'http://saphost:8000',
    client: '100',
    username: 'USER',
    password: 'PASS',
    authType: 'basic' as const,
    connectionType: 'rfc' as const,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SAP_SYSNR;
});

afterEach(() => {
  delete process.env.SAP_SYSNR;
});

describe('buildRfcParams — sysnr derivation', () => {
  it('derives sysnr=00 from standard port 8000', () => {
    new RfcAbapConnection(
      { ...baseConfig(), url: 'http://saphost:8000' },
      logger,
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('saphost:00'),
    );
  });

  it('derives sysnr=42 from standard port 8042', () => {
    new RfcAbapConnection(
      { ...baseConfig(), url: 'http://saphost:8042' },
      logger,
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('saphost:42'),
    );
  });

  it('uses SAP_SYSNR env var override for non-standard ports', () => {
    process.env.SAP_SYSNR = '00';
    new RfcAbapConnection(
      { ...baseConfig(), url: 'http://saphost:50400' },
      logger,
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('saphost:00'),
    );
  });

  it('uses SAP_SYSNR env var override even for standard ports', () => {
    process.env.SAP_SYSNR = '05';
    new RfcAbapConnection(
      { ...baseConfig(), url: 'http://saphost:8000' },
      logger,
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('saphost:05'),
    );
  });
});

describe('RfcAbapConnection.connect — error serialization', () => {
  it('includes RFC error fields in message when SDK throws plain object', async () => {
    // Mock @mcp-abap-adt/sap-rfc-lite to return a client that throws a plain object.
    //
    // `virtual: true` because the real module is an OPTIONAL dependency with a
    // native build (node-gyp-build against the SAP NW RFC SDK). On any machine
    // without that SDK npm skips it silently, and jest.mock() on a module it
    // cannot resolve throws — so this suite went red on every clean install,
    // masked here only by a node_modules left over from an install that had it.
    // The test never wanted the real module: it replaces it entirely.
    jest.mock(
      '@mcp-abap-adt/sap-rfc-lite',
      () => ({
        Client: class {
          open() {
            return Promise.reject({
              code: 'RFC_INVALID_PARAMETER',
              message: 'hostname wrong',
            });
          }
          get alive() {
            return false;
          }
        },
      }),
      { virtual: true },
    );

    const conn = new RfcAbapConnection(baseConfig(), logger);

    await expect(conn.connect()).rejects.toThrow(/hostname wrong/);
  });
});
