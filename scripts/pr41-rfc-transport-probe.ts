/**
 * Which part of the RFC path is broken: the translation, or what it is handed?
 *
 * `connect()` over `RfcTransport` dies in an ABAP dump —
 * `RFC_ABAP_RUNTIME_FAILURE / STRING_OFFSET_TOO_LARGE` — while fetching the
 * CSRF token. That call is built above the seam as
 * `${baseUrl}${CSRF_CONFIG.ENDPOINT}`, an **absolute URL**, which axios accepts
 * and `SADT_REST_RFC_ENDPOINT` has no reason to.
 *
 * So this drives the transport directly, with no connection above it, and
 * varies one thing at a time:
 *
 *   1. a plain path                        — does the translation work at all
 *   2. the same path with the CSRF headers — do those headers upset it
 *   3. an absolute URL                     — the suspect
 *   4. a path with unserialised params     — the M5 fix, on its own
 *
 * Usage:
 *   node scripts/pr41-rfc-transport-probe.js [env-file]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import { RfcTransport } from '../dist/connection/RfcTransport';
import type { ILogger } from '../dist/logger';

const envPath = path.resolve(__dirname, '..', process.argv[2] ?? 'e19.env');
if (!fs.existsSync(envPath)) {
  console.error(`no env file at ${envPath}`);
  process.exit(1);
}
dotenv.config({ path: envPath, quiet: true });

const url = process.env.SAP_URL ?? '';
const parsed = new URL(url);
const port = Number.parseInt(parsed.port || '8000', 10);
const sysnr =
  process.env.SAP_SYSNR?.trim() || String(port - 8000).padStart(2, '0');

const logger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function conversation() {
  // biome-ignore lint/correctness/noNodejsModules: the SDK is optional by design
  const noderfc = require('@mcp-abap-adt/sap-rfc-lite');
  return new noderfc.Client({
    ashost: parsed.hostname,
    sysnr,
    client: process.env.SAP_CLIENT ?? '100',
    user: process.env.SAP_USERNAME ?? '',
    passwd: process.env.SAP_PASSWORD ?? '',
    lang: 'EN',
  });
}

const CSRF_HEADERS = {
  'x-csrf-token': 'fetch',
  Accept: 'application/atomsvc+xml',
};

interface Probe {
  what: string;
  request: Record<string, unknown>;
}

const probes: Probe[] = [
  {
    what: '1. plain path, Accept: */*',
    request: {
      method: 'GET',
      url: '/sap/bc/adt/core/discovery',
      headers: { Accept: '*/*' },
    },
  },
  {
    what: '2. same path, the CSRF headers',
    request: {
      method: 'GET',
      url: '/sap/bc/adt/core/discovery',
      headers: { ...CSRF_HEADERS },
    },
  },
  {
    what: '3. ABSOLUTE URL, the CSRF headers  <-- the suspect',
    request: {
      method: 'GET',
      url: `${url}/sap/bc/adt/core/discovery`,
      headers: { ...CSRF_HEADERS },
    },
  },
  {
    what: '4. path + unserialised params (M5)',
    request: {
      method: 'GET',
      url: '/sap/bc/adt/repository/informationsystem/search',
      headers: { Accept: '*/*' },
      params: { operation: 'quickSearch', query: 'ZZ_MCP*', maxResults: 5 },
    },
  },
  {
    what: '5. path, NO Accept at all (issue #39)',
    request: { method: 'GET', url: '/sap/bc/adt/core/discovery' },
  },
];

async function main(): Promise<void> {
  console.log(`system: ${url}  ashost=${parsed.hostname} sysnr=${sysnr}\n`);

  for (const probe of probes) {
    const transport = new RfcTransport(conversation, logger);
    await transport.open();
    try {
      const response = await (
        transport as unknown as {
          send: (r: unknown) => Promise<{ status: number; data?: unknown }>;
        }
      ).send({ timeout: 60000, ...probe.request });
      const body = String(response.data ?? '');
      console.log(
        `${probe.what}\n    → HTTP ${response.status}, ${body.length} bytes`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const key = /"key":"([^"]+)"/.exec(msg)?.[1];
      const status = (e as { response?: { status?: number } }).response?.status;
      console.log(
        `${probe.what}\n    → ${status ? `HTTP ${status}` : 'THREW'}${key ? ` — ${key}` : ''}\n      ${msg.slice(0, 180)}`,
      );
    } finally {
      await transport.close();
    }
  }
}

main().catch((error) => {
  console.error('probe failed:', error);
  process.exit(1);
});
