/**
 * A goodbye the connection dispatches without awaiting must not become an
 * unhandled rejection when the wire's `close()` rejects.
 *
 * A failed establishment and the refusal of a connection the server gave no
 * session both say goodbye without waiting for it. A custom wire's `close()`
 * can reject — its `context.authorize` throws `AuthRefusedError` by design —
 * and a rejection nobody handles ends a Node process.
 */
import type { SapConfig } from '../../config/sapConfig.js';
import { AdtOnPremConnector } from '../../connection/AdtOnPremConnector.js';
import type { OnPremHttpTransport } from '../../connection/OnPremHttpTransport.js';
import { stubProvider } from '../helpers/stubProvider.js';
import { holdsNoSession } from '../helpers/transportStub.js';

const config = {
  url: 'https://sap.example.com',
  client: '100',
  authType: 'basic',
} as SapConfig;

function connectionOver(overrides: Partial<typeof holdsNoSession>) {
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
  return { conn, closes: () => closes };
}

/** Every rejection nobody handled while `run` and the turns after it ran. */
async function unhandledDuring(run: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => seen.push(reason);
  process.on('unhandledRejection', listener);
  try {
    await run();
    // Unhandled rejections are reported after the microtask queue drains.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', listener);
  }
  return seen;
}

describe('a dispatched goodbye whose close() rejects', () => {
  it('after a failed establishment, is absorbed', async () => {
    const { conn, closes } = connectionOver({
      open: async () => {
        throw new Error('the wire would not open');
      },
    });

    const unhandled = await unhandledDuring(async () => {
      await expect(conn.connect()).rejects.toThrow('the wire would not open');
    });

    expect(closes()).toBe(1);
    expect(unhandled).toStrictEqual([]);
  });

  it('when the server opened no session, is absorbed', async () => {
    const { conn, closes } = connectionOver({});

    const unhandled = await unhandledDuring(async () => {
      await expect(conn.connect()).rejects.toThrow(/opened no ABAP session/);
    });

    expect(closes()).toBe(1);
    expect(unhandled).toStrictEqual([]);
  });
});
