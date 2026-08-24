/**
 * Does the refactored RFC path still hold a lock across calls?
 *
 * The continuity proof was taken on the OLD `RfcAbapConnection`, which worked
 * precisely because it went round the shared machinery — no CSRF, no cookies,
 * no session policy. The whole point of this arc is that RFC now goes THROUGH
 * that machinery: `AdtOnPremConnector` with `RfcTransport`, the same lifecycle
 * every other connection uses.
 *
 * So the proof has to be retaken on the new path, and a lock handle is the only
 * honest witness: issued into a session, meaningless outside it.
 *
 *   1. create a report in $TMP    — one call
 *   2. LOCK it, keep the handle   — a second
 *   3. read the source back       — a third, so the handle is not used by the
 *                                   very next call and the gap is real
 *   4. PUT new source with it     — a fourth: a handle from call 2 accepted
 *                                   here can only mean one session
 *   5. UNLOCK, then activate      — a fifth and sixth
 *
 * Usage:
 *   node scripts/pr41-rfc-lock.js [env-file]
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

const PROGRAM = 'ZZ_MCP_RFC_LOCK_TEST';
const PROGRAM_URI = `/sap/bc/adt/programs/programs/${PROGRAM.toLowerCase()}`;

const stamp = () => new Date().toTimeString().slice(0, 8);
const say = (message: string) => console.log(`${stamp()} ${message}`);

const logger: ILogger = {
  debug: (message: string) => {
    if (/conversation|strategy|session/i.test(message))
      console.log(`  ${message}`);
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

function rfcConversation() {
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

async function main(): Promise<void> {
  const connection = new AdtOnPremConnector(
    config as never,
    new BasicAuthProvider(config.username, config.password),
    new RfcTransport(rfcConversation(), logger),
    logger,
  );

  console.log(`class: ${connection.constructor.name}`);
  console.log(
    `transport: ${(connection as never as { transport: { kind: string } }).transport.kind}`,
  );

  await connection.connect();
  say(`connect(): session ${connection.getSessionIdentity()}`);

  connection.setSessionType('stateful');

  // ---- 1. create -------------------------------------------------------
  const createBody =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<program:abapProgram xmlns:program="http://www.sap.com/adt/programs/programs" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `adtcore:description="RFC session continuity probe" ` +
    `adtcore:name="${PROGRAM}" adtcore:type="PROG/P">` +
    `<adtcore:packageRef adtcore:name="$TMP"/>` +
    `</program:abapProgram>`;
  try {
    const created = await connection.makeAdtRequest({
      url: '/sap/bc/adt/programs/programs',
      method: 'POST',
      timeout: 60000,
      headers: {
        'Content-Type':
          'application/vnd.sap.adt.programs.programs.v2+xml; charset=utf-8',
      },
      data: createBody,
    });
    say(`create ${PROGRAM}: HTTP ${created.status}`);
  } catch (e) {
    // ADT says this with a 500 and a message, not a 409.
    const already = /already exists/i.test(describe(e));
    if (already) say(`create ${PROGRAM}: already there — reusing it`);
    else throw e;
  }

  // ---- 2. lock ---------------------------------------------------------
  const locked = await connection.makeAdtRequest({
    url: `${PROGRAM_URI}?_action=LOCK&accessMode=MODIFY`,
    method: 'POST',
    timeout: 60000,
    headers: {
      Accept:
        'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.Result',
    },
    data: '',
  });
  const handle = String(locked.data).match(
    /<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/,
  )?.[1];
  say(`LOCK: HTTP ${locked.status}, handle ${handle ?? 'NOT FOUND'}`);
  if (!handle) throw new Error('no lock handle — nothing to prove');

  // ---- 3. an unrelated call in between ---------------------------------
  const read = await connection.makeAdtRequest({
    url: `${PROGRAM_URI}/source/main`,
    method: 'GET',
    timeout: 60000,
  });
  say(`read source in between: HTTP ${read.status}`);

  // ---- 4. write with the handle from call 2 ----------------------------
  const source = [
    `REPORT ${PROGRAM.toLowerCase()}.`,
    '',
    `* written over AdtOnPremConnector + RfcTransport, ${new Date().toISOString()}`,
    `WRITE: / 'the refactored RFC path held the lock'.`,
    '',
  ].join('\n');
  const written = await connection.makeAdtRequest({
    url: `${PROGRAM_URI}/source/main?lockHandle=${encodeURIComponent(handle)}`,
    method: 'PUT',
    timeout: 60000,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    data: source,
  });
  say(`PUT with the handle from call 2: HTTP ${written.status}`);
  say('^ two calls later, and it was still valid');

  // ---- 5. unlock and activate ------------------------------------------
  const unlocked = await connection.makeAdtRequest({
    url: `${PROGRAM_URI}?_action=UNLOCK&lockHandle=${encodeURIComponent(handle)}`,
    method: 'POST',
    timeout: 60000,
    data: '',
  });
  say(`UNLOCK: HTTP ${unlocked.status}`);

  const activated = await connection.makeAdtRequest({
    url: '/sap/bc/adt/activation?method=activate&preauditRequests=false',
    method: 'POST',
    timeout: 60000,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    data:
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">` +
      `<adtcore:objectReference adtcore:uri="${PROGRAM_URI}" adtcore:name="${PROGRAM}"/>` +
      `</adtcore:objectReferences>`,
  });
  say(`activate: HTTP ${activated.status}`);

  connection.setSessionType('stateless');
  await connection.disconnect();
  say('disconnect(): returned');
}

main().catch((error) => {
  console.error('lock proof failed:', describe(error));
  process.exit(1);
});
