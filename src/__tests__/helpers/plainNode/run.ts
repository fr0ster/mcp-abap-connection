/**
 * Runs a scenario under plain node and reads the one JSON line it prints.
 *
 * Jest gives a test a copy of `process`, and the real process's
 * `unhandledRejection` never reaches a listener registered on the copy. A
 * scenario run here has the real one. `INJECT_UNHANDLED=1` asks a scenario to
 * leave one rejection unhandled on purpose — the control that shows the run
 * would see one.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export function runScenario<T>(
  scenario: string,
  env: Record<string, string> = {},
): T & { unhandled?: string[]; failed?: string } {
  const out = execFileSync(
    process.execPath,
    ['-r', join(__dirname, 'register.cjs'), join(__dirname, scenario)],
    { env: { ...process.env, ...env }, encoding: 'utf8' },
  );
  return JSON.parse(out.trim().split('\n').pop() ?? '{}');
}

/** For a scenario: every rejection nobody handled, from the real process. */
export function recordUnhandled(): string[] {
  const unhandled: string[] = [];
  process.on('unhandledRejection', (reason) => {
    unhandled.push(
      reason instanceof Error ? reason.message : String(reason ?? 'unknown'),
    );
  });
  if (process.env.INJECT_UNHANDLED === '1') {
    void Promise.reject(new Error('injected'));
  }
  return unhandled;
}
