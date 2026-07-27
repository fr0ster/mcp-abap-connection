/**
 * SessionLifecycle — the concurrency rules of the session design, executed.
 *
 * Numbers refer to the test list in the design spec
 * (docs/superpowers/specs/2026-07-27-session-lifecycle-design.md in
 * @mcp-abap-adt/adt-clients). Each one names the implementation it is meant to
 * fail, because most of them pass on a plausible wrong version.
 *
 * No SAP, no HTTP, no RFC: this unit knows about none of them.
 */
import {
  ADT_SESSION_ERROR,
  SessionLifecycle,
} from '../session/SessionLifecycle.js';

/** Manual clock, so a "ceiling" costs no wall time. */
function clock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets queued microtasks and expired timers run. */
const settle = () => new Promise((r) => setTimeout(r, 5));

const fp = (entries: Record<string, string>) =>
  new Map(Object.entries(entries));

function connected(
  options?: ConstructorParameters<typeof SessionLifecycle>[0],
) {
  const lifecycle = new SessionLifecycle(options);
  lifecycle.markConnected(fp({ SAP_SESSIONID: 'S1' }));
  return lifecycle;
}

describe('SessionLifecycle — admission', () => {
  it('refuses requests before connect', () => {
    const lifecycle = new SessionLifecycle();
    expect(() => lifecycle.admitRequest()).toThrow(
      expect.objectContaining({ code: ADT_SESSION_ERROR.NOT_CONNECTED }),
    );
  });

  // 7 — with NO window open, a pending teardown refuses at once.
  it('refuses a request during a teardown when no window is open', () => {
    const lifecycle = connected();
    lifecycle.beginTeardown({ origin: 'caller', sessionLost: false });

    expect(lifecycle.connected).toBe(false);
    expect(() => lifecycle.admitRequest()).toThrow(
      expect.objectContaining({ code: ADT_SESSION_ERROR.NOT_CONNECTED }),
    );
  });

  // 16 (lifecycle half) — with a window open, the chain may still finish.
  it('admits requests during a teardown while a window is open, and reports not-connected', () => {
    const lifecycle = connected();
    const token = lifecycle.beginWindow('Class/ZCL_A');
    lifecycle.beginTeardown({ origin: 'caller', sessionLost: false });

    // finishing work is allowed…
    const lease = lifecycle.admitRequest();
    lease.release();
    // …but starting work is not: a caller asking "may I begin" hears no.
    expect(lifecycle.connected).toBe(false);

    lifecycle.endWindow(token);
    expect(() => lifecycle.admitRequest()).toThrow(
      expect.objectContaining({ code: ADT_SESSION_ERROR.NOT_CONNECTED }),
    );
  });

  // 18 — grandfathering covers finishing, never starting something new.
  it('refuses a new window once a teardown is pending', () => {
    const lifecycle = connected();
    lifecycle.beginWindow('Class/ZCL_A');
    lifecycle.beginTeardown({ origin: 'caller', sessionLost: false });

    expect(() => lifecycle.beginWindow('Class/ZCL_B')).toThrow(
      expect.objectContaining({ code: ADT_SESSION_ERROR.NOT_CONNECTED }),
    );
  });

  // 31/32/33 (lifecycle half) — a lost session cannot let anything finish.
  it('shuts admission at once on a session-lost teardown, even with a window open', () => {
    const lifecycle = connected();
    lifecycle.beginWindow('Class/ZCL_A');

    lifecycle.beginTeardown({ origin: 'internal', sessionLost: true });

    expect(() => lifecycle.admitRequest()).toThrow(
      expect.objectContaining({ code: ADT_SESSION_ERROR.NOT_CONNECTED }),
    );
    // and the identity is dropped immediately, so a later comparison sees it
    expect(lifecycle.identity).toBeNull();
  });
});

describe('SessionLifecycle — windows', () => {
  // 19 — two windows may share a label; closing one must not retire the other.
  it('closes windows by token, so a shared label does not retire both', async () => {
    const lifecycle = connected();
    const first = lifecycle.beginWindow('Class/ZCL_A');
    lifecycle.beginWindow('Class/ZCL_A');
    // Two distinct windows, not one entry seen twice: an implementation keyed
    // on the label collapses them here, before any close happens.
    expect(lifecycle.openWindows).toStrictEqual(['Class/ZCL_A', 'Class/ZCL_A']);
    lifecycle.beginTeardown({ origin: 'caller', sessionLost: false });

    lifecycle.endWindow(first);

    let drained = false;
    void lifecycle.drain().then(() => {
      drained = true;
    });
    await settle();
    expect(drained).toBe(false);
    expect(lifecycle.openWindows).toStrictEqual(['Class/ZCL_A']);
  });

  // 20 — a bare counter would let a second close retire someone else's window.
  it('ignores an unknown or already-used token', async () => {
    const lifecycle = connected();
    const token = lifecycle.beginWindow('Class/ZCL_A');
    const other = lifecycle.beginWindow('Class/ZCL_B');

    lifecycle.endWindow(token);
    lifecycle.endWindow(token); // double close
    lifecycle.endWindow(Symbol('Class/ZCL_FOREIGN')); // foreign token

    expect(lifecycle.openWindows).toStrictEqual(['Class/ZCL_B']);
    lifecycle.endWindow(other);
    expect(lifecycle.openWindows).toStrictEqual([]);
  });
});

describe('SessionLifecycle — drain', () => {
  // 9 — a request admitted first must settle before the teardown may release.
  it('waits for an in-flight request', async () => {
    const lifecycle = connected();
    const lease = lifecycle.admitRequest();
    lifecycle.beginTeardown({ origin: 'caller', sessionLost: false });

    const order: string[] = [];
    const drained = lifecycle.drain().then(() => order.push('drained'));
    await settle();
    expect(order).toStrictEqual([]);

    order.push('request settled');
    lease.release();
    await drained;

    expect(order).toStrictEqual(['request settled', 'drained']);
  });

  // 16 (drain half) — the gap between PUT and UNLOCK has zero requests in
  // flight, so a request-counting drain finishes there and orphans the lock.
  it('waits for an open window even with nothing in flight', async () => {
    const lifecycle = connected();
    const token = lifecycle.beginWindow('Class/ZCL_A');
    lifecycle.beginTeardown({ origin: 'caller', sessionLost: false });

    const order: string[] = [];
    const drained = lifecycle.drain().then((r) => {
      order.push('drained');
      return r;
    });
    await settle();
    expect(order).toStrictEqual([]);

    order.push('window closed');
    lifecycle.endWindow(token);
    const result = await drained;

    expect(order).toStrictEqual(['window closed', 'drained']);
    expect(result.abandonedWindows).toStrictEqual([]);
  });

  // 17 — a window that never closes is abandoned, and named.
  it('gives up at the ceiling and names the window', async () => {
    const c = clock();
    const lifecycle = connected({ ceilingMs: 1000, now: c.now });
    lifecycle.beginWindow('Domain/ZOK_D_CS_553');
    lifecycle.beginTeardown({ origin: 'caller', sessionLost: false });

    const drained = lifecycle.drain();
    await settle();
    c.advance(1001);
    const result = await drained;

    expect(result.abandonedWindows).toStrictEqual(['Domain/ZOK_D_CS_553']);
  });

  // 26 — a sliding deadline never fires under a steady stream of requests.
  it('does not let request activity postpone the ceiling', async () => {
    const c = clock();
    const lifecycle = connected({ ceilingMs: 1000, now: c.now });
    lifecycle.beginWindow('Class/ZCL_A');
    lifecycle.beginTeardown({ origin: 'caller', sessionLost: false });

    const drained = lifecycle.drain();

    // A busy consumer: short requests arriving throughout the wait. Each one
    // settles, so a deadline measured from the last settled request would be
    // pushed past every check and this would hang instead of failing.
    let admitted = 0;
    for (let i = 0; i < 5; i++) {
      try {
        const lease = lifecycle.admitRequest();
        admitted += 1;
        c.advance(300);
        lease.release();
      } catch {
        // Expected once the ceiling has expired and the gate has shut.
        c.advance(300);
      }
      await settle();
    }

    const result = await drained;
    expect(admitted).toBeGreaterThan(0);
    expect(result.abandonedWindows).toStrictEqual(['Class/ZCL_A']);
  });

  // 25 — the gate must shut inside drain(), before it resolves.
  it('admits nothing once the ceiling has expired', async () => {
    const c = clock();
    const lifecycle = connected({ ceilingMs: 1000, now: c.now });
    lifecycle.beginWindow('Class/ZCL_A');
    lifecycle.beginTeardown({ origin: 'caller', sessionLost: false });

    const drained = lifecycle.drain();
    await settle();
    c.advance(1001);
    await drained;

    expect(() => lifecycle.admitRequest()).toThrow(
      expect.objectContaining({ code: ADT_SESSION_ERROR.NOT_CONNECTED }),
    );
  });

  // 25 (second half) — a request admitted BEFORE expiry still settles first.
  it('waits for a request admitted before expiry, after giving up on the window', async () => {
    const c = clock();
    const lifecycle = connected({ ceilingMs: 1000, now: c.now });
    lifecycle.beginWindow('Class/ZCL_A');
    lifecycle.beginTeardown({ origin: 'caller', sessionLost: false });
    const lease = lifecycle.admitRequest();

    const order: string[] = [];
    const drained = lifecycle.drain().then(() => order.push('drained'));
    await settle();
    c.advance(1001);
    await settle();
    expect(order).toStrictEqual([]);

    order.push('request settled');
    lease.release();
    await drained;

    expect(order).toStrictEqual(['request settled', 'drained']);
  });

  // 28 (drain half) — an abandoned window is not waited on a second time.
  it('does not re-wait a window it has already abandoned', async () => {
    const c = clock();
    const lifecycle = connected({ ceilingMs: 1000, now: c.now });
    lifecycle.beginWindow('Class/ZCL_A');
    lifecycle.beginTeardown({ origin: 'caller', sessionLost: false });

    const first = lifecycle.drain();
    await settle();
    c.advance(1001);
    expect((await first).abandonedWindows).toStrictEqual(['Class/ZCL_A']);

    // no further time passes: a second teardown must not sit out the ceiling
    const second = await lifecycle.drain();
    expect(second.abandonedWindows).toStrictEqual(['Class/ZCL_A']);
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
