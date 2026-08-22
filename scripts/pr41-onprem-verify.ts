/**
 * PR #41 on-prem verification: the same connector over both transports.
 *
 * The PR's own checklist says the on-prem half is unit-tested only. This runs
 * it against a real system, and reports rather than asserts — a difference
 * between the transports is the finding, not a failure to hide.
 *
 * Per transport:
 *   1. connect()                — does a session arrive, and is it named
 *   2. a STATEFUL request       — the lock-bound path, which dies without one
 *   3. a request WITH params    — the M5 fix; RFC must write the query into the
 *                                 URI itself, and the bug returned unfiltered
 *                                 results rather than failing
 *   4. disconnect()             — and whether a call after it is refused
 *
 * Plus, over RFC only, the question issue #39 raised about the old class:
 * does anything supply a default `Accept`, or does ADT answer 400.
 *
 * Usage:
 *   node scripts/pr41-onprem-verify.js [env-file]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import { BasicAuthProvider } from '../dist/auth/providers';
import { AdtOnPremConnector } from '../dist/connection/AdtOnPremConnector';
import { RfcTransport } from '../dist/connection/RfcTransport';
import type { ILogger } from '../dist/logger';

const envPath = path.resolve(__dirname, '..', process.argv[2] ?? 'e19.env');
if (!fs.existsSync(envPath)) {
  console.error(`no env file at ${envPath}`);
  process.exit(1);
}
dotenv.config({ path: envPath, quiet: true });

const stamp = () => new Date().toTimeString().slice(0, 8);
const say = (message: string) => console.log(`${stamp()} ${message}`);
const head = (title: string) =>
  console.log(`\n${'='.repeat(60)}\n${title}\n${'='.repeat(60)}`);

const logger: ILogger = {
  debug: (message: string) => {
    if (/session|strategy|logoff|conversation|STATUS_LINE/i.test(message)) {
      console.log(`  ${message}`);
    }
  },
  info: () => {},
  warn: (message: string) => console.log(`  WARN ${message}`),
  error: (message: string) => console.log(`  ERROR ${message}`),
};

const config = {
  url: process.env.SAP_URL ?? '',
  authType: 'basic' as const,
  username: process.env.SAP_USERNAME ?? '',
  password: process.env.SAP_PASSWORD ?? '',
  client: process.env.SAP_CLIENT ?? '100',
};

const credential = () =>
  new BasicAuthProvider(config.username, config.password);

/** The findings, printed as one table at the end. */
const results: Array<{ transport: string; step: string; outcome: string }> = [];
const record = (transport: string, step: string, outcome: string) => {
  results.push({ transport, step, outcome });
  say(`[${transport}] ${step}: ${outcome}`);
};

function describe(e: unknown): string {
  const response = (e as { response?: { status?: number; data?: unknown } })
    .response;
  if (response?.status) {
    const body = String(response.data ?? '');
    const adt = /<message[^>]*>([^<]+)<\/message>/.exec(body)?.[1];
    return `HTTP ${response.status}${adt ? ` — ${adt}` : ''}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * The RFC conversation the transport is handed. Nothing in the library builds
 * one from a config — the consumer supplies it, and `IRfcConversation` is not
 * exported, so this matches the shape structurally.
 */
function rfcConversationFactory() {
  // biome-ignore lint/correctness/noNodejsModules: the SDK is optional by design
  const noderfc = require('@mcp-abap-adt/sap-rfc-lite');
  const parsed = new URL(config.url);
  const port = Number.parseInt(parsed.port || '8000', 10);
  const sysnr =
    process.env.SAP_SYSNR?.trim() || String(port - 8000).padStart(2, '0');
  return () =>
    new noderfc.Client({
      ashost: parsed.hostname,
      sysnr,
      client: config.client,
      user: config.username,
      passwd: config.password,
      lang: 'EN',
    });
}

async function exercise(
  label: string,
  connection: AdtOnPremConnector<BasicAuthProvider, any>,
  opts: { sendAccept: boolean },
): Promise<void> {
  const accept = opts.sendAccept ? { Accept: '*/*' } : undefined;

  // ---- connect ----------------------------------------------------------
  await connection.connect();
  const identity = connection.getSessionIdentity?.();
  record(label, 'connect()', identity ? `session ${identity}` : 'no identity');

  // ---- stateful request -------------------------------------------------
  connection.setSessionType('stateful');
  try {
    const stateful = await connection.makeAdtRequest({
      url: '/sap/bc/adt/repository/nodestructure?parent_name=%24TMP&parent_type=DEVC%2FK',
      method: 'POST',
      timeout: 60000,
      ...(accept ? { headers: accept } : {}),
      data: '',
    });
    record(label, 'stateful request', `HTTP ${stateful.status}`);
  } catch (e) {
    record(label, 'stateful request', `FAILED — ${describe(e)}`);
  }
  connection.setSessionType('stateless');

  // ---- params, unserialised: the M5 fix ---------------------------------
  try {
    const searched = await connection.makeAdtRequest({
      url: '/sap/bc/adt/repository/informationsystem/search',
      method: 'GET',
      timeout: 60000,
      params: { operation: 'quickSearch', query: 'ZZ_MCP*', maxResults: 5 },
      ...(accept ? { headers: accept } : {}),
    });
    const body = String(searched.data ?? '');
    const hits = (body.match(/adtcore:name="/g) ?? []).length;
    const onlyOurs =
      hits === 0 ||
      !/adtcore:name="(?!ZZ_MCP)/i.test(body.replace(/\s+/g, ' '));
    record(
      label,
      'query params reached the server',
      `HTTP ${searched.status}, ${hits} hit(s), filtered: ${onlyOurs ? 'yes' : 'NO — query was dropped'}`,
    );
  } catch (e) {
    record(label, 'query params reached the server', `FAILED — ${describe(e)}`);
  }

  // ---- disconnect, and what a call after it does ------------------------
  await connection.disconnect({ deadlineMs: 15000 });
  record(label, 'disconnect()', 'returned');

  try {
    await connection.makeAdtRequest({
      url: '/sap/bc/adt/discovery',
      method: 'GET',
      timeout: 30000,
      ...(accept ? { headers: accept } : {}),
    });
    record(label, 'call after disconnect()', 'ACCEPTED — expected a refusal');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    record(
      label,
      'call after disconnect()',
      msg.includes('ADT_NOT_CONNECTED')
        ? 'refused: ADT_NOT_CONNECTED'
        : `refused: ${msg}`,
    );
  }
}

async function main(): Promise<void> {
  console.log(
    `system: ${config.url}, client ${config.client}, user ${config.username}`,
  );

  // ---- HTTP -------------------------------------------------------------
  head('AdtOnPremConnector over HTTP (default transport)');
  const http = new AdtOnPremConnector(config as any, credential(), logger);
  console.log(
    `transport: ${(http as any).transport?.kind ?? 'default/unnamed'}`,
  );
  await exercise('HTTP', http, { sendAccept: false });

  // ---- RFC, first without an Accept header (issue #39) ------------------
  head('AdtOnPremConnector over RfcTransport');
  const connectRfc = rfcConversationFactory();
  const rfc = new AdtOnPremConnector(
    config as any,
    credential(),
    logger,
    undefined,
    { transport: new RfcTransport(connectRfc, logger) },
  );
  console.log(
    `transport: ${(rfc as any).transport?.kind ?? 'default/unnamed'}`,
  );
  await exercise('RFC (no Accept)', rfc, { sendAccept: false });

  // ---- RFC again, this time naming Accept -------------------------------
  head('AdtOnPremConnector over RfcTransport, with an explicit Accept');
  const rfc2 = new AdtOnPremConnector(
    config as any,
    credential(),
    logger,
    undefined,
    { transport: new RfcTransport(rfcConversationFactory(), logger) },
  );
  await exercise('RFC (Accept: */*)', rfc2, { sendAccept: true });

  // ---- a failed connect must throw, not resolve -------------------------
  head('A failed connect() throws rather than resolving');
  const bad = new AdtOnPremConnector(
    { ...config, password: 'definitely-not-the-password' } as any,
    new BasicAuthProvider(config.username, 'definitely-not-the-password'),
    logger,
  );
  try {
    await bad.connect();
    const identity = bad.getSessionIdentity?.();
    record(
      'HTTP',
      'connect() with a bad password',
      `RESOLVED — identity: ${identity ?? 'none'}`,
    );
  } catch (e) {
    record('HTTP', 'connect() with a bad password', `threw — ${describe(e)}`);
  }

  // ---- the table --------------------------------------------------------
  head('Summary');
  for (const r of results) {
    console.log(`${r.transport.padEnd(18)} ${r.step.padEnd(34)} ${r.outcome}`);
  }
}

main().catch((error) => {
  console.error('verification failed:', error);
  const response = (error as { response?: { data?: unknown } }).response;
  if (response?.data)
    console.error('body:', String(response.data).slice(0, 800));
  process.exit(1);
});
