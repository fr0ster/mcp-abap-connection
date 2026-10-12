/**
 * A goodbye the connection dispatches without awaiting must not become an
 * unhandled rejection when the wire's `close()` rejects.
 *
 * A failed establishment and the refusal of a connection the server gave no
 * session both say goodbye without waiting for it. A custom wire's `close()`
 * can reject — its `context.authorize` throws `AuthRefusedError` by design —
 * and a rejection nobody handles ends a Node process.
 *
 * Observed under plain node (`helpers/plainNode/goodbyeScenario.ts`): Jest
 * gives a test a copy of `process`, and a listener on the copy never hears
 * the real one's `unhandledRejection`, so an assertion made here could not
 * fail. The control run leaves one unhandled on purpose.
 */
import { runScenario } from '../helpers/plainNode/run.js';

interface GoodbyeReport {
  failedEstablishment?: { connect: string; closes: number };
  noSession?: { connect: string; closes: number };
}

describe('a dispatched goodbye whose close() rejects', () => {
  it('the run sees an unhandled rejection when there is one (the control)', () => {
    const report = runScenario<GoodbyeReport>('goodbyeScenario.ts', {
      INJECT_UNHANDLED: '1',
    });
    expect(report.unhandled).toEqual(['injected']);
  }, 60000);

  it('after a failed establishment, and when the server opened no session, is absorbed', () => {
    const report = runScenario<GoodbyeReport>('goodbyeScenario.ts');
    expect(report.failed).toBeUndefined();
    expect(report.failedEstablishment).toEqual({
      connect: 'the wire would not open',
      closes: 1,
    });
    expect(report.noSession?.closes).toBe(1);
    expect(report.noSession?.connect).toContain('opened no ABAP session');
    expect(report.unhandled).toEqual([]);
  }, 60000);
});
