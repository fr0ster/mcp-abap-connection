/**
 * No unhandled rejection, whatever an aborted request's waits answer late.
 *
 * Observed in a process of its own: Jest gives a test a copy of `process`,
 * and the real one's `unhandledRejection` never reaches it. The control run
 * leaves one unhandled on purpose, so a scenario that reports none is a
 * process that would have seen one.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const here = join(__dirname, 'helpers', 'plainNode');

function run(env: Record<string, string> = {}) {
  const out = execFileSync(
    process.execPath,
    ['-r', join(here, 'register.cjs'), join(here, 'abortScenario.ts')],
    { env: { ...process.env, ...env }, encoding: 'utf8' },
  );
  return JSON.parse(out.trim().split('\n').pop() ?? '{}') as {
    results?: Record<string, string>;
    unhandled?: string[];
    failed?: string;
  };
}

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
