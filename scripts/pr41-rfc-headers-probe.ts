/**
 * What does `SADT_REST_RFC_ENDPOINT` hand back in HEADER_FIELDS?
 *
 * Above the transport seam the connection keeps cookies and a CSRF token,
 * because that is how the HTTP path works. An RFC conversation makes its ABAP
 * session inside the system — no ICM, no ICF — so the question is whether the
 * FM returns any of that machinery at all, or whether the layer above is
 * managing state that never arrives.
 *
 * So: every response header, verbatim, for a stateless GET, the CSRF-shaped
 * GET, and a stateful POST.
 *
 * Usage:
 *   node scripts/pr41-rfc-headers-probe.js [env-file]
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

const quiet: ILogger = {
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

const cases = [
  {
    what: 'stateless GET /sap/bc/adt/core/discovery',
    request: {
      method: 'GET',
      url: '/sap/bc/adt/core/discovery',
      headers: { Accept: '*/*' },
    },
  },
  {
    what: 'CSRF-shaped GET (x-csrf-token: fetch)',
    request: {
      method: 'GET',
      url: '/sap/bc/adt/core/discovery',
      headers: { 'x-csrf-token': 'fetch', Accept: 'application/atomsvc+xml' },
    },
  },
  {
    what: 'stateful POST nodestructure',
    request: {
      method: 'POST',
      url: '/sap/bc/adt/repository/nodestructure?parent_name=%24TMP&parent_type=DEVC%2FK',
      headers: { Accept: '*/*', 'x-sap-adt-sessiontype': 'stateful' },
      data: '',
    },
  },
];

async function main(): Promise<void> {
  console.log(`system: ${url}  sysnr=${sysnr}`);

  // One conversation for all three, so a session cookie issued by the first
  // call would still be there for the third.
  const transport = new RfcTransport(conversation, quiet);
  await transport.open();

  try {
    for (const c of cases) {
      const response = await (
        transport as unknown as {
          send: (r: unknown) => Promise<{
            status: number;
            headers?: unknown;
            data?: unknown;
          }>;
        }
      ).send({ timeout: 60000, ...c.request });

      const headers = (response.headers ?? {}) as Record<string, unknown>;
      const names = Object.keys(headers);
      console.log(`\n--- ${c.what}`);
      console.log(
        `    HTTP ${response.status}, ${String(response.data ?? '').length} bytes`,
      );
      console.log(
        `    headers (${names.length}): ${names.join(', ') || '(none)'}`,
      );
      for (const name of names) {
        console.log(`      ${name}: ${String(headers[name]).slice(0, 120)}`);
      }
      console.log(
        `    set-cookie:    ${headers['set-cookie'] ? 'PRESENT' : 'absent'}`,
      );
      console.log(
        `    x-csrf-token:  ${headers['x-csrf-token'] ? String(headers['x-csrf-token']) : 'absent'}`,
      );
    }
  } finally {
    await transport.close();
  }
}

main().catch((error) => {
  console.error('probe failed:', error);
  process.exit(1);
});
