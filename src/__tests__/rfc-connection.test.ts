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
 *   - An env file with the application server's address SAP_ASHOST and
 *     SAP_SYSNR, and SAP_CLIENT, SAP_LANGUAGE, SAP_USERNAME, SAP_PASSWORD
 *     (optional SAP_SAPROUTER); no URL is read
 *   - for SNC: Windows or macOS with the Secure Login Client, and
 *     SAP_SNC_PARTNERNAME in the env file (optional SAP_SNC_QOP, SAP_SNC_LIB,
 *     SAP_SNC_MYNAME)
 *   - for SNC through a message server: the SNC settings, plus SAP_MSHOST,
 *     SAP_MSSERV or SAP_SYSID (or both), SAP_GROUP, SAP_CLIENT, SAP_LANGUAGE
 *     (optional SAP_SAPROUTER)
 *
 * Each block states where it can run; elsewhere it is skipped with the reason
 * in its title — not being runnable on this machine is not a failure.
 *
 * Run:
 *   SAP_ENV_FILE=e19.env npm run test:ci -- --testPathPatterns=rfc-connection
 */

import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';
import {
  BasicAuthProvider,
  SncLogonProvider,
} from '@mcp-abap-adt/auth-providers';
import type { IAuthProvider } from '@mcp-abap-adt/interfaces-auth';
import type {
  ISapRfcApplicationServer,
  ISapRfcConfig,
  ISapRfcMessageServer,
} from '@mcp-abap-adt/interfaces-auth-sap';
import * as dotenv from 'dotenv';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import { RfcTransport } from '../connection/RfcTransport.js';
import { rfcConversationFrom } from '../connection/rfcConversation.js';
import type { ILogger } from '../logger.js';

// Load env file — default to e19.env, override via SAP_ENV_FILE
const envFile = process.env.SAP_ENV_FILE || 'e19.env';
dotenv.config({ path: envFile });

const logger: ILogger = {
  info: mock.fn(),
  warn: mock.fn(),
  error: mock.fn(),
  debug: mock.fn(),
};

/** A variable of the env file, or `undefined` when it is absent or empty. */
function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

/** The names among `names` the env file does not state. */
function lacking(names: readonly string[]): string | null {
  const missing = names.filter((name) => env(name) === undefined);
  return missing.length ? `${envFile} lacks ${missing.join(', ')}` : null;
}

/** `saprouter` exactly when the env file states one. */
function router(): { saprouter?: string } {
  const saprouter = env('SAP_SAPROUTER');
  return saprouter === undefined ? {} : { saprouter };
}

/**
 * The application server the env file states, or why it states none. Read as
 * given: nothing of it comes from a URL.
 */
function applicationServer(): ISapRfcApplicationServer | string {
  const ashost = env('SAP_ASHOST');
  const sysnr = env('SAP_SYSNR');
  const client = env('SAP_CLIENT');
  const language = env('SAP_LANGUAGE');
  if (
    ashost === undefined ||
    sysnr === undefined ||
    client === undefined ||
    language === undefined
  ) {
    return (
      lacking(['SAP_ASHOST', 'SAP_SYSNR', 'SAP_CLIENT', 'SAP_LANGUAGE']) ?? ''
    );
  }
  return {
    connectionType: 'rfc',
    authType: 'basic',
    ashost,
    sysnr,
    client,
    language,
    ...router(),
  };
}

/** The message server the env file states, or why it states none. */
function messageServer(): ISapRfcMessageServer | string {
  const mshost = env('SAP_MSHOST');
  const group = env('SAP_GROUP');
  const client = env('SAP_CLIENT');
  const language = env('SAP_LANGUAGE');
  const msserv = env('SAP_MSSERV');
  const sysid = env('SAP_SYSID');
  if (
    mshost === undefined ||
    group === undefined ||
    client === undefined ||
    language === undefined
  ) {
    return (
      lacking(['SAP_MSHOST', 'SAP_GROUP', 'SAP_CLIENT', 'SAP_LANGUAGE']) ?? ''
    );
  }
  const service =
    msserv !== undefined
      ? { msserv, ...(sysid === undefined ? {} : { sysid }) }
      : sysid !== undefined
        ? { sysid }
        : undefined;
  if (service === undefined) return `${envFile} lacks SAP_MSSERV or SAP_SYSID`;
  return {
    connectionType: 'rfc',
    authType: 'basic',
    mshost,
    group,
    client,
    language,
    ...router(),
    ...service,
  };
}

/** The user and password the basic block logs on with, or why there are none. */
function basicCredential(): { username: string; password: string } | string {
  const username = env('SAP_USERNAME');
  const password = env('SAP_PASSWORD');
  if (username === undefined || password === undefined) {
    return lacking(['SAP_USERNAME', 'SAP_PASSWORD']) ?? '';
  }
  return { username, password };
}

/** What a block reads, once its availability said it can: never a reason. */
function stated<T>(value: T | string): T {
  if (typeof value === 'string') throw new Error(value);
  return value;
}

function overRfc(config: ISapRfcConfig) {
  const { username, password } = stated(basicCredential());
  return new AdtOnPremConnector(
    config,
    new BasicAuthProvider(username, password),
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
  const address = applicationServer();
  if (typeof address === 'string') return address;
  const credential = basicCredential();
  if (typeof credential === 'string') return credential;
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
  const address = applicationServer();
  if (typeof address === 'string') return address;
  return lacking(['SAP_SNC_PARTNERNAME']) ?? rfcUnavailable();
}

/**
 * The same SNC logon, dialled through a message server and a logon group —
 * SAP_MSHOST with SAP_MSSERV or SAP_SYSID, and SAP_GROUP — instead of one
 * application server.
 */
function messageServerUnavailable(): string | null {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return `SNC needs Windows or macOS with the Secure Login Client; this is ${process.platform}`;
  }
  const address = messageServer();
  if (typeof address === 'string') return address;
  return lacking(['SAP_SNC_PARTNERNAME']) ?? rfcUnavailable();
}

/** What a block registers its tests and hooks with. */
type Live = { it: typeof it; before: typeof before; after: typeof after };

/**
 * Run the block, or skip it with the reason in its title. Skipped, each of its
 * tests is still listed — skipped, with the reason — and none of its hooks is
 * registered, so nothing reaches a system: node:test runs a suite's `before`
 * even when every test in it is skipped.
 */
function describeWhere(
  title: string,
  unavailable: string | null,
  body: (live: Live) => void,
): void {
  if (unavailable === null) {
    describe(title, () => body({ it, before, after }));
    return;
  }
  const skip = `skipped: ${unavailable}`;
  describe(`${title} — ${skip}`, () =>
    body({
      it: ((name: string) => it(name, { skip })) as typeof it,
      before: (() => {}) as typeof before,
      after: (() => {}) as typeof after,
    }));
}

describeWhere(
  'the on-prem connector over RFC (integration)',
  basicUnavailable(),
  ({ it, before, after }) => {
    let conn: ReturnType<typeof overRfc>;

    before(
      async () => {
        conn = overRfc(stated(applicationServer()));
        await conn.connect();
      },
      { timeout: 15_000 },
    );

    after(async () => {
      await conn?.disconnect();
    });

    it('travels over the wire it was given', () => {
      assert.strictEqual(conn.transport.kind, 'rfc');
    });

    it('is on a session, and it is the conversation', () => {
      // Not a cookie: this wire is never issued one. The conversation IS the
      // session, so the connection is on one for as long as it is open.
      assert.match(conn.getSessionIdentity() ?? '', /^rfc-conversation=/);
    });

    it('has no HTTP origin: getBaseUrl() answers undefined', async () => {
      assert.strictEqual(await conn.getBaseUrl(), undefined);
    });

    it('should return a session ID', () => {
      const sessionId = conn.getSessionId();
      assert.ok(sessionId);
      assert.strictEqual(typeof sessionId, 'string');
    });

    it('should GET /sap/bc/adt/compatibility/graph', {
      timeout: 15_000,
    }, async () => {
      const resp = await conn.makeAdtRequest({
        method: 'GET',
        url: '/sap/bc/adt/compatibility/graph',
        headers: { Accept: 'application/xml' },
        timeout: 10_000,
      });

      assert.strictEqual(resp.status, 200);
      assert.strictEqual(typeof resp.data, 'string');
    });

    it('asks with no Accept of its own, and is still answered', {
      timeout: 15_000,
    }, async () => {
      // Without a default, ADT refuses this with
      // `400 ExceptionResourceBadRequest: Accept header missing` — axios supplies
      // one over HTTP and nobody noticed until this wire had to.
      const resp = await conn.makeAdtRequest({
        method: 'GET',
        url: '/sap/bc/adt/compatibility/graph',
        timeout: 10_000,
      });

      assert.strictEqual(resp.status, 200);
    });

    it('should return response headers', { timeout: 15_000 }, async () => {
      const resp = await conn.makeAdtRequest({
        method: 'GET',
        url: '/sap/bc/adt/compatibility/graph',
        headers: { Accept: 'application/xml' },
        timeout: 10_000,
      });

      assert.notStrictEqual(resp.headers, undefined);
      assert.notStrictEqual(
        (resp.headers as Record<string, unknown>)['content-type'],
        undefined,
      );
    });

    it('should handle query params', { timeout: 15_000 }, async () => {
      const resp = await conn.makeAdtRequest({
        method: 'GET',
        url: '/sap/bc/adt/compatibility/graph',
        headers: { Accept: 'application/xml' },
        params: { sap_language: 'EN' },
        timeout: 10_000,
      });

      assert.strictEqual(resp.status, 200);
    });

    it('should return 404 for non-existent resource', {
      timeout: 15_000,
    }, async () => {
      await assert.rejects(
        conn.makeAdtRequest({
          method: 'GET',
          url: '/sap/bc/adt/programs/programs/ZZZZ_NONEXISTENT_99999',
          headers: { Accept: 'application/xml' },
          timeout: 10_000,
        }),
        (e: unknown) =>
          /4(0[0-9]|1[0-9]|2[0-9]|[0-9]{2})/.test((e as Error).message),
      );
    });

    it('should support stateful session type', () => {
      conn.setSessionType('stateful');
      // No error — session type accepted
      conn.setSessionType('stateless');
    });

    it('refuses a call once the conversation has been given back', {
      timeout: 20_000,
    }, async () => {
      const other = overRfc(stated(applicationServer()));
      await other.connect();
      await other.disconnect();

      await assert.rejects(
        other.makeAdtRequest({
          method: 'GET',
          url: '/sap/bc/adt/compatibility/graph',
          timeout: 10_000,
        }),
        (e: unknown) => /ADT_NOT_CONNECTED/.test((e as Error).message),
      );
    });
  },
);

describeWhere(
  'SNC over RFC, through the Secure Login Client (integration)',
  sncUnavailable(),
  ({ it, before, after }) => {
    let conn: AdtOnPremConnector<IAuthProvider, RfcTransport>;

    before(
      async () => {
        const config = stated(applicationServer());
        conn = new AdtOnPremConnector(
          config,
          SncLogonProvider.forSecureLoginClient({
            partnerName: env('SAP_SNC_PARTNERNAME') ?? '',
            qop: process.env.SAP_SNC_QOP || undefined,
            sncLib: process.env.SAP_SNC_LIB || undefined,
            myName: process.env.SAP_SNC_MYNAME || undefined,
          }),
          new RfcTransport(rfcConversationFrom(config), logger),
          logger,
        );
        await conn.connect();
      },
      { timeout: 60_000 },
    );

    after(async () => {
      await conn?.disconnect();
    });

    it('logs on without a password and is answered', async () => {
      const response = await conn.makeAdtRequest({
        url: '/sap/bc/adt/compatibility/graph',
        method: 'GET',
        timeout: 15_000,
      });
      assert.strictEqual(response.status, 200);
    });
  },
);

describeWhere(
  'SNC over RFC through a message server and a logon group (integration)',
  messageServerUnavailable(),
  ({ it, before, after }) => {
    let conn: AdtOnPremConnector<IAuthProvider, RfcTransport>;

    before(
      async () => {
        const config = stated(messageServer());
        conn = new AdtOnPremConnector(
          config,
          SncLogonProvider.forSecureLoginClient({
            partnerName: env('SAP_SNC_PARTNERNAME') ?? '',
            qop: process.env.SAP_SNC_QOP || undefined,
            sncLib: process.env.SAP_SNC_LIB || undefined,
            myName: process.env.SAP_SNC_MYNAME || undefined,
          }),
          new RfcTransport(rfcConversationFrom(config), logger),
          logger,
        );
        await conn.connect();
      },
      { timeout: 60_000 },
    );

    after(async () => {
      await conn?.disconnect();
    });

    it('logs on through the message server and is answered', async () => {
      const response = await conn.makeAdtRequest({
        url: '/sap/bc/adt/compatibility/graph',
        method: 'GET',
        timeout: 15_000,
      });
      assert.strictEqual(response.status, 200);
    });
  },
);
