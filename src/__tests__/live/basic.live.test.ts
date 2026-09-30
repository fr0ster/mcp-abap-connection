/**
 * Basic authentication against a real on-prem system, over each wire named in
 * `basic.wires`. Skipped only when the `basic` section is absent; a present
 * section that fails is red.
 *
 * Run:  npm run test:live:basic
 * Set up: docs/USAGE.md, "Live suites" — and src/__tests__/helpers/test-config.yaml.template
 */

import { AuthRefusedError } from '../../connection/authErrors.js';
import {
  basicSection,
  describeLive,
  type LiveWire,
  onPremOver,
} from '../helpers/liveConfig.js';
import {
  discovery,
  type LiveConnection,
  lockAndUnlock,
  readClassSource,
} from '../helpers/liveSteps.js';

describeLive('basic', (section) => {
  const setup = basicSection(section);

  describe.each(setup.wires)('over %s', (wire: LiveWire) => {
    const build = (wrong = false): LiveConnection =>
      onPremOver(
        wire,
        setup.config,
        wrong ? setup.wrongProvider() : setup.provider(),
        setup.rfc,
        setup.rejectUnauthorized,
      ) as unknown as LiveConnection;

    let conn: LiveConnection;
    beforeAll(async () => {
      conn = build();
      await conn.connect();
    }, 60_000);
    afterAll(async () => {
      await conn?.disconnect();
    });

    it('connects, and discovery answers 200', async () => {
      const response = await discovery(conn);
      expect(response.status).toBe(200);
    }, 60_000);

    it(`reads the source of ${setup.readClass}`, async () => {
      const response = await readClassSource(conn, setup.readClass);
      expect(response.status).toBe(200);
      expect(String(response.data).length).toBeGreaterThan(0);
    }, 60_000);

    const lockIt = setup.lockClass ? it : it.skip;
    lockIt(
      `locks and unlocks ${setup.lockClass ?? '(no lock_class)'} in a critical section`,
      async () => {
        const { lockStatus, unlockStatus } = await lockAndUnlock(
          conn,
          setup.lockClass as string,
        );
        expect(lockStatus).toBe(200);
        expect(unlockStatus).toBeLessThan(300);
      },
      120_000,
    );
    if (!setup.lockClass) {
      process.stderr.write(
        `[live:basic:${wire}] LOCK/UNLOCK skipped — no "lock_class" in the basic section (name a class you may lock)\n`,
      );
    }

    // ONE failed logon on the user's account per wire — deliberate, and no
    // retry: a second attempt would count against the account's lockout.
    it('a wrong password is AuthRefusedError at logon: "the user or password was refused"', async () => {
      const wrong = build(true);
      const error = await wrong.connect().then(
        () => undefined,
        (e: unknown) => e,
      );
      await wrong.disconnect().catch(() => undefined);
      expect(error).toBeInstanceOf(AuthRefusedError);
      expect((error as AuthRefusedError).at).toBe('logon');
      expect((error as AuthRefusedError).refusal.reason).toBe(
        'the user or password was refused',
      );
    }, 60_000);
  });
});
