/**
 * A goodbye the connection dispatches without awaiting must not become an
 * unhandled rejection when the wire's `close()` rejects.
 *
 * A failed establishment and the refusal of a connection the server gave no
 * session both say goodbye without waiting for it. A custom wire's `close()`
 * can reject — its `context.authorize` throws `AuthRefusedError` by design —
 * and a rejection nobody handles ends a Node process.
 *
 * Observed in a process of its own (`helpers/plainNode/goodbyeScenario.ts`):
 * in the test's own process node:test reports an unhandled rejection as a
 * failure of whichever test is running, so it could not be counted here. The
 * control run leaves one unhandled on purpose.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runScenario } from '../helpers/plainNode/run.js';

interface GoodbyeReport {
  failedEstablishment?: { connect: string; closes: number };
  noSession?: { connect: string; closes: number };
}

describe('a dispatched goodbye whose close() rejects', () => {
  it('the run sees an unhandled rejection when there is one (the control)', {
    timeout: 60000,
  }, () => {
    const report = runScenario<GoodbyeReport>('goodbyeScenario.js', {
      INJECT_UNHANDLED: '1',
    });
    assert.deepStrictEqual(report.unhandled, ['injected']);
  });

  it('after a failed establishment, and when the server opened no session, is absorbed', {
    timeout: 60000,
  }, () => {
    const report = runScenario<GoodbyeReport>('goodbyeScenario.js');
    assert.strictEqual(report.failed, undefined);
    assert.deepStrictEqual(report.failedEstablishment, {
      connect: 'the wire would not open',
      closes: 1,
    });
    assert.strictEqual(report.noSession?.closes, 1);
    assert.ok(report.noSession?.connect.includes('opened no ABAP session'));
    assert.deepStrictEqual(report.unhandled, []);
  });
});
