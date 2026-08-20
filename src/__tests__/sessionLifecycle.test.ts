/**
 * SessionLifecycle — the concurrency rules of the session design, executed.
 *
 * The rules are stated on `SessionLifecycle` itself; the design note this used
 * to cite lived in another package and was deleted with the work it described.
 * Each test names the implementation it is meant to fail, because most of them
 * pass on a plausible wrong version.
 *
 * No SAP, no HTTP, no RFC: this unit knows about none of them.
 */
import { ADT_SESSION_ERROR } from '@mcp-abap-adt/interfaces';
import { SessionLifecycle } from '../session/SessionLifecycle.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets queued microtasks run. */
const settle = () => new Promise((r) => setTimeout(r, 5));

const fp = (entries: Record<string, string>) =>
  new Map(Object.entries(entries));

function connected() {
  const lifecycle = new SessionLifecycle();
  lifecycle.markConnected(fp({ SAP_SESSIONID: 'S1' }));
  return lifecycle;
}

describe('SessionLifecycle — admission', () => {
  it('refuses requests before connect', () => {
    const lifecycle = new SessionLifecycle();
    expect(() => lifecycle.admitRequest()).toThrow(
      ADT_SESSION_ERROR.NOT_CONNECTED,
    );
  });

  it('refuses a request the moment a teardown is requested', () => {
    const lifecycle = connected();
    lifecycle.beginTeardown({ origin: 'caller', sessionLost: false });
    expect(() => lifecycle.admitRequest()).toThrow(
      ADT_SESSION_ERROR.NOT_CONNECTED,
    );
    expect(lifecycle.connected).toBe(false);
  });

  // The teardown intent applies synchronously, before any transition is queued:
  // a caller who has asked to disconnect cannot have requests still going
  // through while the transition waits its turn on the tail.
  it('shuts admission before the transition even starts', async () => {
    const lifecycle = connected();
    const blocked = deferred();
    void lifecycle.transition('connect', () => blocked.promise);

    lifecycle.beginTeardown({ origin: 'caller', sessionLost: false });
    void lifecycle.transition('disconnect', async () => {
      lifecycle.markDisconnected();
    });

    // The disconnect body has not run — it is queued behind the connect.
    expect(() => lifecycle.admitRequest()).toThrow(
      ADT_SESSION_ERROR.NOT_CONNECTED,
    );
    blocked.resolve();
    await settle();
  });

  it('counts an admitted request in flight until it is released', () => {
    const lifecycle = connected();
    const lease = lifecycle.admitRequest();
    expect(lifecycle.requestsInFlight).toBe(1);
    lease.release();
    lease.release(); // idempotent
    expect(lifecycle.requestsInFlight).toBe(0);
  });
});

describe('SessionLifecycle — reconnect', () => {
  it('is usable again after a graceful teardown and a fresh connect', () => {
    const lifecycle = connected();
    lifecycle.beginTeardown({ origin: 'caller', sessionLost: false });
    lifecycle.markDisconnected();
    expect(lifecycle.connected).toBe(false);

    lifecycle.markConnected(fp({ SAP_SESSIONID: 'S2' }));
    expect(lifecycle.connected).toBe(true);
    expect(() => lifecycle.admitRequest()).not.toThrow();
  });

  it('is usable again after a session-lost teardown', () => {
    const lifecycle = connected();
    lifecycle.beginTeardown({ origin: 'internal', sessionLost: true });
    lifecycle.markDisconnected();
    expect(lifecycle.identity).toBeNull();

    lifecycle.markConnected(fp({ SAP_SESSIONID: 'S2' }));
    expect(lifecycle.connected).toBe(true);
    expect(lifecycle.identity).toBe('SAP_SESSIONID=S2');
  });
});

describe('SessionLifecycle — session generation', () => {
  // The fence that makes a non-waiting teardown safe. Without it a response
  // arriving after a later connect() writes into the new session's state.
  it('goes stale for a lease taken before a teardown', () => {
    const lifecycle = connected();
    const lease = lifecycle.admitRequest();
    expect(lifecycle.isCurrent(lease)).toBe(true);

    lifecycle.beginTeardown({ origin: 'caller', sessionLost: false });
    expect(lifecycle.isCurrent(lease)).toBe(false);
  });

  // The gap an earlier design left: counting only at markConnected() leaves a
  // lease valid between a teardown and the next connect, so a late response
  // writes into state just cleared.
  it('goes stale before any replacement exists', () => {
    const lifecycle = connected();
    const lease = lifecycle.admitRequest();
    lifecycle.beginTeardown({ origin: 'caller', sessionLost: false });
    lifecycle.markDisconnected();

    expect(lifecycle.isCurrent(lease)).toBe(false);
  });

  it('goes stale across a session-lost teardown and its recovery', () => {
    const lifecycle = connected();
    const lease = lifecycle.admitRequest();

    // Internal origin: the epoch deliberately does NOT move here.
    const epochBefore = lifecycle.teardownEpoch;
    lifecycle.beginTeardown({ origin: 'internal', sessionLost: true });
    lifecycle.markConnected(fp({ SAP_SESSIONID: 'S2' }));
    expect(lifecycle.teardownEpoch).toBe(epochBefore);

    // ...which is exactly why the fence cannot be built on it.
    expect(lifecycle.isCurrent(lease)).toBe(false);
  });

  it('stays current for a lease of the session in hand', () => {
    const lifecycle = connected();
    const lease = lifecycle.admitRequest();
    expect(lifecycle.isCurrent(lease)).toBe(true);
    lease.release();
    expect(lifecycle.isCurrent(lease)).toBe(true);
  });
});

describe('SessionLifecycle — transitions', () => {
  // 6 — two concurrent connects must produce ONE establishment.
  it('joins concurrent transitions of the same kind at the tail', async () => {
    const lifecycle = connected();
    let runs = 0;
    const gate = deferred();
    const run = async () => {
      runs += 1;
      await gate.promise;
    };

    const a = lifecycle.transition('connect', run);
    const b = lifecycle.transition('connect', run);
    gate.resolve();
    await Promise.all([a, b]);

    expect(runs).toBe(1);
  });

  // 8 — a join must never overtake a transition queued behind the tail.
  it('does not join past a queued transition of another kind', async () => {
    const lifecycle = connected();
    const order: string[] = [];
    const first = deferred();

    const c1 = lifecycle.transition('connect', async () => {
      order.push('connect#1');
      await first.promise;
    });
    const d = lifecycle.transition('disconnect', async () => {
      order.push('disconnect');
    });
    const c2 = lifecycle.transition('connect', async () => {
      order.push('connect#2');
    });

    first.resolve();
    await Promise.all([c1, d, c2]);

    expect(order).toStrictEqual(['connect#1', 'disconnect', 'connect#2']);
  });

  // 28 (join half) — a caller's disconnect must not be swallowed by an
  // internal cleanup, or its report is never produced.
  it('never joins a cleanup, so a caller teardown still runs', async () => {
    const lifecycle = connected();
    const order: string[] = [];

    const cleanup = lifecycle.transition('cleanup', async () => {
      order.push('cleanup');
    });
    const caller = lifecycle.transition('disconnect', async () => {
      order.push('caller disconnect');
    });
    await Promise.all([cleanup, caller]);

    expect(order).toStrictEqual(['cleanup', 'caller disconnect']);
  });

  // 15 — two recoveries with different baselines must decide independently.
  it('never joins recoveries', async () => {
    const lifecycle = connected();
    let runs = 0;
    const run = async () => {
      runs += 1;
    };

    await Promise.all([
      lifecycle.transition('recover', run),
      lifecycle.transition('recover', run),
    ]);

    expect(runs).toBe(2);
  });

  it('runs the next transition even when one rejects', async () => {
    const lifecycle = connected();
    const order: string[] = [];

    const failing = lifecycle
      .transition('connect', async () => {
        order.push('failed');
        throw new Error('boom');
      })
      .catch(() => undefined);
    const next = lifecycle.transition('disconnect', async () => {
      order.push('next');
    });

    await Promise.all([failing, next]);
    expect(order).toStrictEqual(['failed', 'next']);
  });
});

describe('SessionLifecycle — epoch', () => {
  // 12/14 — a caller teardown cancels a recovery whose request was admitted
  // earlier, whether the recovery is queued yet or not.
  it("bumps the epoch on a caller's teardown, from the admission baseline", () => {
    const lifecycle = connected();
    const lease = lifecycle.admitRequest();

    expect(lease.epoch).toBe(lifecycle.teardownEpoch);
    lifecycle.beginTeardown({ origin: 'caller', sessionLost: false });
    expect(lease.epoch).not.toBe(lifecycle.teardownEpoch);
  });

  // 13 — an internal cleanup must not cancel the recovery it just set up.
  it('leaves the epoch alone on an internal teardown', () => {
    const lifecycle = connected();
    const lease = lifecycle.admitRequest();

    lifecycle.beginTeardown({ origin: 'internal', sessionLost: true });
    expect(lease.epoch).toBe(lifecycle.teardownEpoch);
  });
});

describe('SessionLifecycle — identity', () => {
  it('classifies an unchanged fingerprint', () => {
    const lifecycle = connected();
    expect(lifecycle.observe(fp({ SAP_SESSIONID: 'S1' }))).toBe('unchanged');
  });

  // The LOCK response adds a second identifier for the SAME session: additive,
  // never a replacement, or every lock would blow up right after succeeding.
  it('treats a newly appearing name as established, not replaced', () => {
    const lifecycle = connected();
    expect(
      lifecycle.observe(fp({ SAP_SESSIONID: 'S1', 'sap-contextid': 'C1' })),
    ).toBe('established');
  });

  it('classifies a changed value as replaced', () => {
    const lifecycle = connected();
    expect(lifecycle.observe(fp({ SAP_SESSIONID: 'S2' }))).toBe('replaced');
  });

  it('reports no identity when nothing is tracked', () => {
    const lifecycle = new SessionLifecycle();
    lifecycle.markConnected();
    expect(lifecycle.identity).toBeNull();
    expect(lifecycle.observe(new Map())).toBe('unchanged');
  });
});
