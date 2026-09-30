/**
 * Passwordless SNC logon over RFC, through the SAP Secure Login Client. Run on
 * the machine that has the Client, its library and the SAP NW RFC SDK. Skipped
 * only when the `snc` section is absent.
 *
 * Not automated: the logged-out case (`A2200019`, closing the Client's window
 * so the ticket is gone) is a manual step, recorded in the PR.
 *
 * Run:  npm run test:live:snc
 */

import { describeLive, snc, sncSection } from '../helpers/liveConfig.js';
import {
  discovery,
  type LiveConnection,
  readClassSource,
} from '../helpers/liveSteps.js';

describeLive('snc', (section) => {
  const setup = sncSection(section);
  let conn: LiveConnection;

  beforeAll(async () => {
    conn = snc(setup) as unknown as LiveConnection;
    await conn.connect();
  }, 60_000);
  afterAll(async () => {
    await conn?.disconnect();
  });

  it('connects over RFC, and discovery answers 200', async () => {
    const response = await discovery(conn);
    expect(response.status).toBe(200);
  }, 60_000);

  it(`reads the source of ${setup.readClass}`, async () => {
    const response = await readClassSource(conn, setup.readClass);
    expect(response.status).toBe(200);
    expect(String(response.data).length).toBeGreaterThan(0);
  }, 60_000);
});
