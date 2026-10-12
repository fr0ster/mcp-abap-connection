/**
 * The goodbyes a failed `connect()` dispatches without awaiting, through a
 * wire whose `close()` rejects, under plain node: what each connect rejected
 * with, how often the goodbye was sent, and every rejection left unhandled.
 */
import type { SapConfig } from '../../../config/sapConfig.js';
import { AdtOnPremConnector } from '../../../connection/AdtOnPremConnector.js';
import type { OnPremHttpTransport } from '../../../connection/OnPremHttpTransport.js';
import { drained } from '../requestSignal.js';
import { stubProvider } from '../stubProvider.js';
import { holdsNoSession } from '../transportStub.js';
import { recordUnhandled } from './run.js';

const unhandled = recordUnhandled();

const config = {
  url: 'https://sap.example.com',
  client: '100',
  authType: 'basic',
} as SapConfig;

async function connectOver(overrides: Partial<typeof holdsNoSession>) {
  let closes = 0;
  const transport = {
    ...holdsNoSession,
    kind: 'stub',
    send: async () => {
      throw new Error('nothing is sent');
    },
    close: async () => {
      closes += 1;
      throw new Error('the goodbye failed');
    },
    ...overrides,
  };
  const conn = new AdtOnPremConnector(
    config,
    stubProvider(),
    transport as unknown as OnPremHttpTransport,
    null,
  );
  const connect = await conn.connect().then(
    () => 'resolved',
    (error: unknown) => (error instanceof Error ? error.message : 'unknown'),
  );
  await drained();
  return { connect, closes };
}

async function main() {
  const failedEstablishment = await connectOver({
    open: async () => {
      throw new Error('the wire would not open');
    },
  });
  const noSession = await connectOver({});
  await drained();
  await drained();
  process.stdout.write(
    `${JSON.stringify({ failedEstablishment, noSession, unhandled })}\n`,
  );
}

main().catch((error: unknown) => {
  process.stdout.write(
    `${JSON.stringify({ failed: error instanceof Error ? error.message : String(error) })}\n`,
  );
});
