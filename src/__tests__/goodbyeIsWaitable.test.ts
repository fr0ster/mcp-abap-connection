/**
 * A caller that ends a session and opens another can wait for the goodbye.
 *
 * `disconnect()` dispatches the logoff without awaiting it, which is right for
 * a teardown — a server that never answers must not hold one open — and wrong
 * for a caller who reconnects immediately: the next session is asked for while
 * the previous one's goodbye is still being assembled, so the server keeps
 * both. Measured against E19 from `@mcp-abap-adt/adt-clients`, whose test
 * harness recycles per test: one abandoned session every 1-2 seconds for the
 * length of a run, each surviving to its 30-minute idle timeout.
 *
 * Before `flushGoodbye()` the promise was created and dropped — there was
 * nothing a caller could hold.
 */

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

/** A close that settles only when the test says so. */
function suspendedClose(connection: { transport: unknown }) {
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  const transport = connection.transport as { close: unknown };
  transport.close = jest.fn(async () => {
    started = true;
    await arrived;
  });
  return { release, started: () => started };
}

describe('flushGoodbye', () => {
  it('waits for the goodbye that disconnect only dispatched', async () => {
    const connection = onPrem(config);
    seedCookies(connection, 'SAP_SESSIONID_E19_100=first');
    markConnectedForTest(connection);

    const goodbye = suspendedClose(
      connection as unknown as { transport: unknown },
    );

    await connection.disconnect();
    // disconnect() has returned while the logoff is still in flight — that is
    // the behaviour, not the defect.
    expect(goodbye.started()).toBe(true);

    let flushed = false;
    const waiting = connection.flushGoodbye(1000).then(() => {
      flushed = true;
    });

    // Still waiting: nothing has answered yet.
    await Promise.resolve();
    expect(flushed).toBe(false);

    goodbye.release();
    await waiting;
    expect(flushed).toBe(true);
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
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('returns immediately when nothing was ever dispatched', async () => {
    const connection = onPrem(config);
    await expect(connection.flushGoodbye(50)).resolves.toBeUndefined();
  });

  it('does not surface a failed goodbye as a rejection', async () => {
    const connection = onPrem(config);
    seedCookies(connection, 'SAP_SESSIONID_E19_100=third');
    markConnectedForTest(connection);
    const transport = (
      connection as unknown as { transport: { close: unknown } }
    ).transport;
    transport.close = jest.fn(async () => {
      throw new Error('the server hung up');
    });

    await connection.disconnect();
    // Holding the promise must not turn a failed goodbye into an unhandled
    // rejection, and must not make the caller's next step fail either.
    await expect(connection.flushGoodbye(50)).resolves.toBeUndefined();
  });
});
