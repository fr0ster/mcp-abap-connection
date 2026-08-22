/**
 * Hold one on-prem session open, over either wire, until told to let it go.
 *
 * There were two of these, one per connection class, and they were the same
 * script twice. There is one connector now and the wire is an argument, so this
 * is one script with an argument — which is also the point it demonstrates.
 *
 * What it is for: watching the session from the SAP side while it exists.
 * The two wires show up in different places, and that is the finding, not a
 * detail —
 *
 *   HTTP  an ICF session. Visible in SM05. The process holds no socket while
 *         it lives: keep-alive is long gone and the session is server-side.
 *   RFC   a conversation on the gateway. Visible in SMGW -> Logged on Clients
 *         as NWRFC, and NOT in SM05, because there is no ICM in the path.
 *
 * Usage:
 *   node scripts/onprem-session-hold.js <stop-file> [http|rfc] [env-file]
 *
 * Create the stop file to release. Bounded at 30 minutes, so a forgotten
 * holder cannot sit on a session all day.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import { BasicAuthProvider } from '../dist/auth/providers';
import { AdtOnPremConnector } from '../dist/connection/AdtOnPremConnector';
import { RfcTransport } from '../dist/connection/RfcTransport';
import { rfcConversationFrom } from '../dist/connection/rfcConversation';
import type { ILogger } from '../dist/logger';

const stopFile = process.argv[2];
const wire = (process.argv[3] ?? 'http').toLowerCase();
if (!stopFile || (wire !== 'http' && wire !== 'rfc')) {
  console.error(
    'usage: onprem-session-hold.js <stop-file> [http|rfc] [env-file]',
  );
  process.exit(1);
}

const envPath = path.resolve(__dirname, '..', process.argv[4] ?? 'e19.env');
if (!fs.existsSync(envPath)) {
  console.error(`no env file at ${envPath}`);
  process.exit(1);
}
dotenv.config({ path: envPath, quiet: true });

const MAX_HOLD_MS = 30 * 60 * 1000;
const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toTimeString().slice(0, 8);
const say = (message: string) => console.log(`${stamp()} ${message}`);

const logger: ILogger = {
  debug: (message: string) => {
    if (/strategy|conversation|application server/i.test(message)) {
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

async function main(): Promise<void> {
  const credential = new BasicAuthProvider(config.username, config.password);
  const connection =
    wire === 'rfc'
      ? new AdtOnPremConnector(config as never, credential, logger, undefined, {
          transport: new RfcTransport(
            rfcConversationFrom(config as never),
            logger,
          ),
        })
      : new AdtOnPremConnector(config as never, credential, logger);

  console.log(
    `${config.url}, client ${config.client}, user ${config.username}`,
  );
  console.log(`wire: ${connection.transport.kind}`);

  await connection.connect();
  say(`session: ${connection.getSessionIdentity() ?? 'NONE'}`);

  // A STATEFUL request, because that is the path that dies when there is no
  // session. A plain read proves less: it works over a connection nothing
  // could ever be locked on.
  connection.setSessionType('stateful');
  const stateful = await connection.makeAdtRequest({
    url: '/sap/bc/adt/repository/nodestructure?parent_name=%24TMP&parent_type=DEVC%2FK',
    method: 'POST',
    timeout: 30000,
    data: '',
  });
  say(`stateful request: HTTP ${stateful.status}`);
  connection.setSessionType('stateless');

  say(
    wire === 'rfc'
      ? `HOLDING — look in SMGW (Logged on Clients), not SM05; create ${stopFile} to release`
      : `HOLDING — look in SM05; create ${stopFile} to release`,
  );
  const startedAt = Date.now();
  while (!fs.existsSync(stopFile) && Date.now() - startedAt < MAX_HOLD_MS) {
    await wait(2000);
  }

  say('releasing');
  await connection.disconnect({ deadlineMs: 15000 });
  say('RELEASED — look again');
}

main().catch((error) => {
  console.error('holder failed:', error);
  process.exit(1);
});
