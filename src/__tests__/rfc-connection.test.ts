/**
 * The RFC wire against a real system.
 *
 * Written against `AdtOnPremConnector` carrying a `RfcTransport`, which is what
 * taking the RFC wire is now: the per-transport connection class these tests
 * used to drive is gone, and with it the second translation of
 * `SADT_REST_RFC_ENDPOINT` that would have drifted from this one.
 *
 * These are the only live RFC coverage there is. Everything else about the wire
 * is unit-tested against a stand-in client, which cannot tell you that the FM
 * accepts what is being built for it.
 *
 * Requires:
 *   - SAP NW RFC SDK installed (SAPNWRFC_HOME set)
 *   - @mcp-abap-adt/sap-rfc-lite installed
 *   - An env file with SAP_URL, SAP_USERNAME, SAP_PASSWORD, SAP_CLIENT
 *   - for SNC: Windows or macOS with the Secure Login Client, and
 *     SAP_SNC_PARTNERNAME in the env file (optional SAP_SNC_QOP, SAP_SNC_LIB,
 *     SAP_SNC_MYNAME)
 *
 * Each block states where it can run; elsewhere it is skipped with the reason
 * in its title — not being runnable on this machine is not a failure.
 *
 * Run:
 *   SAP_ENV_FILE=e19.env npx jest --testPathPatterns=rfc-connection
 */

import {
  BasicAuthProvider,
  SncLogonProvider,
} from '@mcp-abap-adt/auth-providers';
import type { IAuthProvider } from '@mcp-abap-adt/interfaces-auth';
import * as dotenv from 'dotenv';
import type { SapConfig } from '../config/sapConfig.js';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import { RfcTransport } from '../connection/RfcTransport.js';
import {
  rfcConversationFrom,
  rfcParamsFrom,
} from '../connection/rfcConversation.js';
import type { ILogger } from '../logger.js';
import { legacyProvider } from './helpers/legacyProvider.js';
import { onPremHttpTransport } from './helpers/onPrem.js';

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
    url: process.env.SAP_URL as string,
    client: process.env.SAP_CLIENT as string,
    username: process.env.SAP_USERNAME as string,
    password: process.env.SAP_PASSWORD as string,
    authType: (process.env.SAP_AUTH_TYPE as SapConfig['authType']) || 'basic',
  };
}

function overRfc(config: SapConfig) {
  return new AdtOnPremConnector(
    config,
    legacyProvider(
      new BasicAuthProvider(config.username ?? '', config.password ?? ''),
    ),
    new RfcTransport(rfcConversationFrom(config), logger),
    logger,
  );
}

/**
 * The env file AND the SDK: either one missing means this machine is not the
 * one these tests are for.
 *
 * Installing `@mcp-abap-adt/sap-rfc-lite` is a deliberate act — it needs the SAP
 * NW RFC SDK on the machine — so a checkout without it is not a broken checkout,
 * it is one that does not take the RFC wire. Asking only about the env file made
 * that eleven red tests: the dependency is `optional`, so `npm ci` leaves it out
 * WITHOUT failing, and the suite then went looking for it anyway. A gate that
 * goes red for a wire the machine has chosen not to build reports nothing about
 * the change under test.
 */
/**
 * Why the RFC wire cannot be taken here, or null when it can: the addon must
 * load, which needs the SAP NW RFC SDK and a build for this Node. A copy that
 * resolves but was never built is a machine that cannot take the wire.
 */
function rfcUnavailable(): string | null {
  try {
    require('@mcp-abap-adt/sap-rfc-lite');
    return null;
  } catch (error) {
    const first = (
      error instanceof Error ? error.message : String(error)
    ).split('\n')[0];
    return `@mcp-abap-adt/sap-rfc-lite does not load here (${first})`;
  }
}

/** Why the basic-over-RFC block cannot run here, or null when it can. */
function basicUnavailable(): string | null {
  const missing = [
    'SAP_URL',
    'SAP_USERNAME',
    'SAP_PASSWORD',
    'SAP_CLIENT',
  ].filter((name) => !process.env[name]);
  if (missing.length) return `${envFile} lacks ${missing.join(', ')}`;
  return rfcUnavailable();
}

/**
 * Why the SNC block cannot run here, or null when it can. The Secure Login
 * Client exists for Windows and macOS only, so anywhere else SNC is not
 * testable — which is a fact about the machine, not a failure.
 */
function sncUnavailable(): string | null {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return `SNC needs Windows or macOS with the Secure Login Client; this is ${process.platform}`;
  }
  const missing = ['SAP_URL', 'SAP_CLIENT', 'SAP_SNC_PARTNERNAME'].filter(
    (name) => !process.env[name],
  );
  if (missing.length) return `${envFile} lacks ${missing.join(', ')}`;
  return rfcUnavailable();
}

/** Run the block, or skip it with the reason in its title. */
function describeWhere(
  title: string,
  unavailable: string | null,
  body: () => void,
): void {
  if (unavailable) describe.skip(`${title} — skipped: ${unavailable}`, body);
  else describe(title, body);
}

describeWhere(
  'the on-prem connector over RFC (integration)',
  basicUnavailable(),
  () => {
    let conn: ReturnType<typeof overRfc>;

    beforeAll(async () => {
      conn = overRfc(buildConfig());
      await conn.connect();
    }, 15_000);

    afterAll(async () => {
      await conn?.disconnect();
    });

    it('travels over the wire it was given', () => {
      expect(conn.transport.kind).toBe('rfc');
    });

    it('is on a session, and it is the conversation', () => {
      // Not a cookie: this wire is never issued one. The conversation IS the
      // session, so the connection is on one for as long as it is open.
      expect(conn.getSessionIdentity()).toMatch(/^rfc-conversation=/);
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

    it('asks with no Accept of its own, and is still answered', async () => {
      // Without a default, ADT refuses this with
      // `400 ExceptionResourceBadRequest: Accept header missing` — axios supplies
      // one over HTTP and nobody noticed until this wire had to.
      const resp = await conn.makeAdtRequest({
        method: 'GET',
        url: '/sap/bc/adt/compatibility/graph',
        timeout: 10_000,
      });

      expect(resp.status).toBe(200);
    }, 15_000);

    it('should return response headers', async () => {
      const resp = await conn.makeAdtRequest({
        method: 'GET',
        url: '/sap/bc/adt/compatibility/graph',
        headers: { Accept: 'application/xml' },
        timeout: 10_000,
      });

      expect(resp.headers).toBeDefined();
      expect(
        (resp.headers as Record<string, unknown>)['content-type'],
      ).toBeDefined();
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

    it('refuses a call once the conversation has been given back', async () => {
      const other = overRfc(buildConfig());
      await other.connect();
      await other.disconnect();

      await expect(
        other.makeAdtRequest({
          method: 'GET',
          url: '/sap/bc/adt/compatibility/graph',
          timeout: 10_000,
        }),
      ).rejects.toThrow(/ADT_NOT_CONNECTED/);
    }, 20_000);
  },
);

describe('the parameters the conversation is dialled with', () => {
  // Pure derivation, so these run wherever the suite does — the validation the
  // per-transport class used to do in its constructor lives here now.
  const config: SapConfig = {
    url: 'http://saphost:8000',
    client: '100',
    username: 'USER',
    password: 'PASS',
    authType: 'basic',
  };

  it('refuses a config with no url to take a host from', () => {
    expect(() => rfcParamsFrom({ ...config, url: '' })).toThrow(/url/i);
  });

  it('takes a config with no credentials: the provider brings those', () => {
    expect(() =>
      rfcParamsFrom({ ...config, username: '', password: '' }),
    ).not.toThrow();
  });
});

describeWhere(
  'SNC over RFC, through the Secure Login Client (integration)',
  sncUnavailable(),
  () => {
    let conn: AdtOnPremConnector<IAuthProvider, RfcTransport>;

    beforeAll(async () => {
      const config: SapConfig = {
        url: process.env.SAP_URL as string,
        client: process.env.SAP_CLIENT as string,
        authType: 'basic',
      };
      conn = new AdtOnPremConnector(
        config,
        legacyProvider(
          SncLogonProvider.forSecureLoginClient({
            partnerName: process.env.SAP_SNC_PARTNERNAME as string,
            qop: process.env.SAP_SNC_QOP || undefined,
            sncLib: process.env.SAP_SNC_LIB || undefined,
            myName: process.env.SAP_SNC_MYNAME || undefined,
          }),
        ),
        new RfcTransport(rfcConversationFrom(config), logger),
        logger,
      );
      await conn.connect();
    }, 60_000);

    afterAll(async () => {
      await conn?.disconnect();
    });

    it('logs on without a password and is answered', async () => {
      const response = await conn.makeAdtRequest({
        url: '/sap/bc/adt/compatibility/graph',
        method: 'GET',
        timeout: 15_000,
      });
      expect(response.status).toBe(200);
    });
  },
);
