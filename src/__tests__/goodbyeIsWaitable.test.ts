/**
 * A caller that ends a session and opens another can wait for the goodbye.
 *
 * `disconnect()` resolves once the logoff is written, not answered, which is
 * right for a teardown — a server that never answers must not hold one open —
 * and wrong for a caller who reconnects immediately: the next session is asked for while
 * the previous one's goodbye is still being assembled, so the server keeps
 * both. Measured against E19 from `@mcp-abap-adt/adt-clients`, whose test
 * harness recycles per test: one abandoned session every 1-2 seconds for the
 * length of a run, each surviving to its 30-minute idle timeout.
 *
 * Before `flushGoodbye()` the promise was created and dropped — there was
 * nothing a caller could hold.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';
import type { SapConfig } from '../config/sapConfig.js';
import { onPrem } from './helpers/onPrem.js';
import { markConnectedForTest } from './helpers/session.js';
import { seedCookies } from './helpers/transportStub.js';

const config: SapConfig = {
  url: 'https://sap.example.com',
  authType: 'basic',
  username: 'u',
  password: 'p',
  client: '100',
};

/**
 * A close whose logoff has left — it reports the write at once — and whose
 * answer arrives only when the test says so.
 */
function suspendedClose(connection: { transport: unknown }) {
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  const transport = connection.transport as { close: unknown };
  transport.close = mock.fn(async (_context: unknown, written?: () => void) => {
    started = true;
    written?.();
    await arrived;
  });
  return { release, started: () => started };
}

describe('flushGoodbye', () => {
  // The budget's timer is unref'd — the library must not hold a process open —
  // and the goodbye here never answers. node:test on Node.js 22 ends a file
  // whose event loop has emptied, a test still pending, so the suite holds the
  // loop open itself while it runs, as Jest's runner did.
  let held: NodeJS.Timeout | undefined;
  before(() => {
    held = setInterval(() => {}, 60_000);
  });
  after(() => {
    clearInterval(held);
  });

  it('waits for the goodbye that disconnect only dispatched', async () => {
    const connection = onPrem(config);
    seedCookies(connection, 'SAP_SESSIONID_E19_100=first');
    markConnectedForTest(connection);

    const goodbye = suspendedClose(
      connection as unknown as { transport: unknown },
    );

    await connection.disconnect();
    // disconnect() has returned once the logoff was written, its answer still
    // to come — that is the behaviour, not the defect.
    assert.strictEqual(goodbye.started(), true);

    let flushed = false;
    const waiting = connection.flushGoodbye(1000).then(() => {
      flushed = true;
    });

    // Still waiting: nothing has answered yet.
    await Promise.resolve();
    assert.strictEqual(flushed, false);

    goodbye.release();
    await waiting;
    assert.strictEqual(flushed, true);
  });

  it('without a budget waits for the answer as long as it takes, and creates no timer', async () => {
    const connection = onPrem(config);
    seedCookies(connection, 'SAP_SESSIONID_ABC_001=nobudget');
    markConnectedForTest(connection);
    const goodbye = suspendedClose(
      connection as unknown as { transport: unknown },
    );
    await connection.disconnect();

    const timers = mock.method(global, 'setTimeout');
    let flushed = false;
    const waiting = connection.flushGoodbye().then(() => {
      flushed = true;
    });
    // No bound of the library's own choosing: nothing was scheduled.
    assert.strictEqual(timers.mock.callCount(), 0);
    timers.mock.restore();

    for (let turn = 0; turn < 10; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.strictEqual(flushed, false);

    goodbye.release();
    await waiting;
    assert.strictEqual(flushed, true);
  });

  it("with the caller's budget, schedules exactly that bound", async () => {
    const connection = onPrem(config);
    seedCookies(connection, 'SAP_SESSIONID_ABC_001=budget');
    markConnectedForTest(connection);
    suspendedClose(connection as unknown as { transport: unknown });
    await connection.disconnect();

    const timers = mock.method(global, 'setTimeout');
    const waiting = connection.flushGoodbye(50);
    assert.ok(
      timers.mock.calls.some(
        ({ arguments: args }) =>
          args.length === 2 && typeof args[0] === 'function' && args[1] === 50,
      ),
    );
    timers.mock.restore();
    assert.strictEqual(await waiting, undefined);
  });

  it('gives up on its own budget rather than hanging', async () => {
    const connection = onPrem(config);
    seedCookies(connection, 'SAP_SESSIONID_E19_100=second');
    markConnectedForTest(connection);
    suspendedClose(connection as unknown as { transport: unknown });

    await connection.disconnect();

    // The goodbye never answers. The wait must end anyway: it exists to order
    // one session's end before the next one's start, not to make a teardown
    // hostage to a server that has stopped replying.
    const started = Date.now();
    await connection.flushGoodbye(50);
    assert.ok(Date.now() - started < 2000);
  });

  it('returns immediately when nothing was ever dispatched', async () => {
    const connection = onPrem(config);
    assert.strictEqual(await connection.flushGoodbye(50), undefined);
  });

  it('does not surface a failed goodbye as a rejection', async () => {
    const connection = onPrem(config);
    seedCookies(connection, 'SAP_SESSIONID_E19_100=third');
    markConnectedForTest(connection);
    const transport = (
      connection as unknown as { transport: { close: unknown } }
    ).transport;
    transport.close = mock.fn(async () => {
      throw new Error('the server hung up');
    });

    await connection.disconnect();
    // Holding the promise must not turn a failed goodbye into an unhandled
    // rejection, and must not make the caller's next step fail either.
    assert.strictEqual(await connection.flushGoodbye(50), undefined);
  });
});
