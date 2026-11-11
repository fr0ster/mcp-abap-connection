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
import { after, before, describe, it, mock, type TestContext } from 'node:test';
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
import type { AbapConnection } from '../connection/AbapConnection.js';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import { createConnection } from '../connection/createConnection.js';
import {
  type RfcConversationFactory,
  RfcTransport,
} from '../connection/RfcTransport.js';
import { rfcConversationFrom } from '../connection/rfcConversation.js';
import type { ILogger } from '../logger.js';
import { messageOf } from './helpers/assertions.js';
import {
  armBreakpoint,
  attach,
  checkListener,
  classUri,
  clearBreakpoints,
  debuggeePassportHex,
  type ListenerAnswer,
  lineOf,
  listen,
  randomIds,
  request,
  runClass,
  stopListener,
  type Terminal,
  terminateDebugger,
} from './helpers/liveDebugger.js';

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
/** A test body, as node:test runs it. */
type Body = () => Promise<void> | void;
/** A test body, which may read its context (to skip at run time). */
type TestBody = (context: TestContext) => Promise<void> | void;
type Live = {
  it(name: string, fn: TestBody): void;
  it(name: string, options: { timeout?: number }, fn: TestBody): void;
  before(fn: Body, options?: { timeout?: number }): void;
  after(fn: Body): void;
};

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
      it: (name: string) => {
        it(name, { skip });
      },
      before: () => {},
      after: () => {},
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
      assert.notStrictEqual(resp.headers['content-type'], undefined);
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
        (e: unknown) => /4(0[0-9]|1[0-9]|2[0-9]|[0-9]{2})/.test(messageOf(e)),
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
        (e: unknown) => /ADT_NOT_CONNECTED/.test(messageOf(e)),
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

/**
 * The passport and the session end, over RFC, against the shared debugger
 * probe class: `ZAC_SHR_DBG_PROBE`, created and activated by the ADT clients'
 * shared test setup (`shared_dependencies`), never changed or deleted here.
 * Nothing is created, changed or deleted in the system; the breakpoints and
 * the listener set here are removed, and every connection is disconnected, in
 * a `finally`. No id, passport, lock handle or value of the env file is
 * printed.
 */
describeWhere(
  'the passport and the session end over RFC (integration)',
  basicUnavailable(),
  ({ it }) => {
    const PROBE = 'ZAC_SHR_DBG_PROBE';
    /** How long the server holds a listener expected to catch the run. */
    const HOLD_CAUGHT = 30;
    /** How long the server holds a listener expected to catch nothing. */
    const HOLD_EMPTY = 10;

    function roleConnection() {
      const config = stated(applicationServer());
      const { username, password } = stated(basicCredential());
      return createConnection({
        system: 'onprem',
        transport: 'rfc',
        config,
        credential: new BasicAuthProvider(username, password),
        logger,
      });
    }

    /**
     * The debugger's connection, over a factory that counts the conversations
     * it opens: a new session after the end would be one more.
     */
    function countedDebugger() {
      const config = stated(applicationServer());
      const { username, password } = stated(basicCredential());
      const base = rfcConversationFrom(config);
      let opened = 0;
      const counting: RfcConversationFactory = Object.assign(
        (logon: Readonly<Record<string, string>>) => {
          opened += 1;
          return base(logon);
        },
        { language: base.language },
      );
      const conn = new AdtOnPremConnector(
        config,
        new BasicAuthProvider(username, password),
        new RfcTransport(counting, logger),
        logger,
      );
      return { conn, opened: () => opened };
    }

    /**
     * The breakpoint line: the probe's line marked `"BP:loop`, read from its
     * source. `undefined` when the class does not exist here.
     */
    async function probeLine(
      conn: AbapConnection,
    ): Promise<number | undefined> {
      const source = await request(
        conn,
        'GET',
        `${classUri(PROBE)}/source/main`,
        { headers: { Accept: 'text/plain' } },
      );
      if (source.status === 404) return undefined;
      assert.strictEqual(source.status, 200, 'reading the probe class');
      const line = lineOf(source.body, '"BP:loop');
      assert.notStrictEqual(line, undefined, 'the probe marks "BP:loop');
      return line;
    }

    /**
     * Resolve once the listener whose poll is `heard` stands at the system.
     *
     * Owner-approved test-only exception (2026-11-11) to "no polling", as in
     * sap-rfc-lite's live suite: ADT offers no readiness event for a
     * terminal-mode listener. Measured on premise: a run sent before the
     * listener stands is not held and is not caught; a listener is registered
     * only while its poll is held; a second listener of the same user answers
     * 409 only when it arrives after the first. The one thing that says "a
     * listener stands" is the check's 409, so the check is repeated — with no
     * pause beyond its own round trip — until it answers 409. The listener's
     * own hold bounds the loop: if its poll settles before a 409 is seen, this
     * fails saying so.
     */
    async function listening(
      checker: AbapConnection,
      heard: Promise<ListenerAnswer>,
    ): Promise<void> {
      let settled = false;
      heard.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const asker = randomIds();
      for (;;) {
        if (settled) {
          throw new Error(
            "the listener's poll settled before the check answered 409 (a listener stands)",
          );
        }
        if ((await checkListener(checker, asker)) === 'standing') return;
      }
    }

    it('a run carrying the passport is caught; ending the debugger ends the session, and nothing opens a new one', {
      timeout: 180_000,
    }, async (context) => {
      const listener = roleConnection();
      const checker = roleConnection();
      const runner = roleConnection();
      const debuggerSide = countedDebugger();
      const ids = randomIds();
      let armed = false;
      try {
        await listener.connect();
        const line = await probeLine(listener);
        if (line === undefined) {
          context.skip(
            `${PROBE} does not exist here: the ADT clients' shared test setup creates it`,
          );
          return;
        }
        await checker.connect();
        await runner.connect();
        await debuggerSide.conn.connect();
        debuggerSide.conn.setSessionType('stateful');

        assert.strictEqual(
          await armBreakpoint(listener, ids, PROBE, line),
          200,
          'arming the breakpoint',
        );
        armed = true;

        const heard = listen(listener, ids, HOLD_CAUGHT);
        await listening(checker, heard);
        const run = runClass(runner, PROBE, {
          'SAP-PASSPORT': debuggeePassportHex(ids),
        });
        const caught = await heard;
        assert.ok(caught.caught, 'the listener caught the run');

        assert.strictEqual(
          await attach(debuggerSide.conn, caught.debuggeeId),
          200,
          'attached',
        );
        const openedBefore = debuggerSide.opened();

        const ended = await terminateDebugger(debuggerSide.conn).then(
          () =>
            assert.fail('terminateDebugger was expected to end the session'),
          (error: unknown) => error,
        );
        assert.ok(ended instanceof Error);
        assert.strictEqual(
          Object.getOwnPropertyDescriptor(ended, 'code')?.value,
          'ADT_SESSION_REPLACED',
        );
        const rfc: unknown = Object.getOwnPropertyDescriptor(
          ended,
          'rfc',
        )?.value;
        assert.deepStrictEqual(rfc, {
          key: 'RFC_CLOSED',
          group: 4,
          code: 6,
          codeString: 'RFC_CLOSED',
        });

        const after = await request(
          debuggerSide.conn,
          'GET',
          `${classUri(PROBE)}/source/main`,
        ).then(
          () =>
            assert.fail('a request after the end was expected to be refused'),
          (error: unknown) => error,
        );
        assert.strictEqual(
          Object.getOwnPropertyDescriptor(after, 'code')?.value,
          'ADT_NOT_CONNECTED',
        );
        assert.strictEqual(
          debuggerSide.opened(),
          openedBefore,
          'no conversation opened after the end',
        );

        const output = await run;
        assert.strictEqual(output.status, 200, 'the run answered');
        assert.ok(output.body.length > 0, 'the run answered its output');
      } finally {
        await cleanUp(listener, ids, armed);
        await checker.disconnect();
        await runner.disconnect();
        await debuggerSide.conn.disconnect();
      }
    });

    it('a run without the passport is not caught', {
      timeout: 120_000,
    }, async (context) => {
      const listener = roleConnection();
      const checker = roleConnection();
      const runner = roleConnection();
      const ids = randomIds();
      let armed = false;
      try {
        await listener.connect();
        const line = await probeLine(listener);
        if (line === undefined) {
          context.skip(
            `${PROBE} does not exist here: the ADT clients' shared test setup creates it`,
          );
          return;
        }
        await checker.connect();
        await runner.connect();
        assert.strictEqual(
          await armBreakpoint(listener, ids, PROBE, line),
          200,
          'arming the breakpoint',
        );
        armed = true;

        const heard = listen(listener, ids, HOLD_EMPTY);
        await listening(checker, heard);
        const run = runClass(runner, PROBE);

        assert.deepStrictEqual(await heard, { caught: false });
        const output = await run;
        assert.strictEqual(output.status, 200, 'the run answered');
        assert.ok(output.body.length > 0, 'the run answered its output');
      } finally {
        await cleanUp(listener, ids, armed);
        await checker.disconnect();
        await runner.disconnect();
      }
    });

    /** The listener deleted and the breakpoints cleared, then disconnected. */
    async function cleanUp(
      listener: AbapConnection & { disconnect(): Promise<void> },
      ids: Terminal,
      armed: boolean,
    ): Promise<void> {
      try {
        if (armed) {
          const stopped = await stopListener(listener, ids);
          const cleared = await clearBreakpoints(listener, ids);
          if (stopped !== 200 || cleared !== 200) {
            logger.warn(
              `cleanup: deleting the listener answered ${stopped}, clearing the breakpoints ${cleared}`,
            );
          }
        }
      } finally {
        await listener.disconnect();
      }
    }
  },
);
