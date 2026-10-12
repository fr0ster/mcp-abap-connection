/**
 * No unhandled rejection, whatever an aborted request's waits answer late.
 *
 * Observed in a process of its own: Jest gives a test a copy of `process`,
 * and the real one's `unhandledRejection` never reaches it. The control run
 * leaves one unhandled on purpose, so a scenario that reports none is a
 * process that would have seen one.
 */
import { runScenario } from './helpers/plainNode/run.js';

const run = (env: Record<string, string> = {}) =>
  runScenario<{ results?: Record<string, string> }>('abortScenario.ts', env);

describe('an aborted request leaves nothing unhandled', () => {
  it('sees an unhandled rejection when there is one (the control)', () => {
    const report = run({ INJECT_UNHANDLED: '1' });
    expect(report.unhandled).toEqual(['injected']);
  }, 60000);

  it('every wait answered late with a failure: each caller aborted, nothing unhandled', () => {
    const report = run();
    expect(report.failed).toBeUndefined();
    expect(report.results).toEqual({
      httpAuthorize: 'ADT_REQUEST_ABORTED',
      httpExchangeAuthorize: 'ADT_REQUEST_ABORTED',
      httpExchange: 'ADT_REQUEST_ABORTED',
      httpRejected: 'ADT_REQUEST_ABORTED',
      rfcLogon: 'ADT_REQUEST_ABORTED',
      rfcOpenFailed: 'ADT_REQUEST_ABORTED',
      rfcOpenSucceeded: 'ADT_REQUEST_ABORTED',
      rfcOpenSucceededClosed: '1',
      preAborted: 'ADT_REQUEST_ABORTED',
    });
    expect(report.unhandled).toEqual([]);
  }, 60000);
});
