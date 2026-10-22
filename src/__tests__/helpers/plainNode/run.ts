/**
 * Runs a scenario in a node process of its own and reads the one JSON line it
 * prints.
 *
 * A test cannot watch its own process for unhandled rejections: node:test
 * reports one there as a failure of whatever test was running, the control
 * that leaves one unhandled on purpose included. A scenario run here has a
 * process of its own. `INJECT_UNHANDLED=1` asks a scenario to leave one
 * rejection unhandled on purpose — the control that shows the run would see
 * one. The scenario runs compiled, beside this file.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export function runScenario<T>(
  scenario: string,
  env: Record<string, string> = {},
): T & { unhandled?: string[]; failed?: string } {
  const out = execFileSync(process.execPath, [join(__dirname, scenario)], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
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
