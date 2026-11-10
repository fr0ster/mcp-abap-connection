/**
 * Counts the timers this package's own code arms.
 *
 * Every timer API the package could reach is watched: the globals
 * (`setTimeout`, `setInterval`, `setImmediate`), the same three on
 * `node:timers` — a separate binding, which a mock of the global does not
 * see — and `node:timers/promises` with its `scheduler`. The modules are
 * taken with `require`, so what is mocked is the exports object the code
 * under test reads its functions from at the call.
 *
 * A dependency may arm a timer of its own — the HTTP client arms one per
 * request — so a call counts only when its caller is a compiled source file
 * outside the tests and outside `node_modules`: the first frame of its stack
 * that is a file, past Node's own frames (the mock's among them).
 *
 * The counter is itself tested, with a deliberate package-side delay through
 * each API (`packageTimers.test.ts`).
 *
 * What it cannot see — each counts as 0:
 *
 * - a timer the package arms THROUGH a dependency: the caller is the
 *   dependency's file under `node_modules`, so the call is the dependency's;
 * - a timer function captured before `watchTimers()` runs — a module-level
 *   `const { setTimeout } = require('node:timers')`, or a reference kept
 *   anywhere else: the mock replaces the property, not the captured function;
 * - a call whose stack does not show the package's frame: a stack truncated
 *   (`Error.stackTraceLimit`) before it, or a package file compiled to a path
 *   outside a `src/` directory, such as `dist/`.
 *
 * So it is a guard against the obvious delay put back, not a proof. The main
 * proof that the CSRF fetch happens once is in the tests that use it: the
 * count of requests the wire sent (one, or two with the 404/501 fallback) and
 * the error arriving at once, on a real local socket.
 */
import { mock } from 'node:test';

const timers: typeof import('node:timers') = require('node:timers');
const promises: typeof import('node:timers/promises') = require('node:timers/promises');

/** What is read of a watched function: the stack of each call. */
interface Watched {
  mock: { calls: ReadonlyArray<{ stack: Error }> };
}

/**
 * Where a stack frame points: the text in its last parentheses, or after
 * `at ` when the frame names no function. The function's name is not read —
 * it may be anything, `node:` included.
 */
function locationOf(frame: string): string {
  const trimmed = frame.trim();
  if (trimmed.endsWith(')')) {
    const open = trimmed.lastIndexOf('(');
    if (open !== -1) return trimmed.slice(open + 1, -1);
  }
  return trimmed.startsWith('at ') ? trimmed.slice(3) : trimmed;
}

/** Whether a location is Node's own (`node:…`, native) rather than a file. */
function nodeLocation(location: string): boolean {
  return location.startsWith('node:') || !location.includes('/');
}

/** Whether the call this stack records came from the package's own code. */
export function armedByPackage(stack: string): boolean {
  const caller = stack
    .split('\n')
    .slice(1)
    .map((frame) => locationOf(frame).split('\\').join('/'))
    .find((location) => !nodeLocation(location));
  if (caller === undefined) return false;
  return (
    caller.includes('/src/') &&
    !caller.includes('/src/__tests__/') &&
    !caller.includes('/node_modules/')
  );
}

/** Starts watching. `mock.restoreAll()` stops it. */
export function watchTimers(): { ours: () => number } {
  const watched: Watched[] = [
    mock.method(globalThis, 'setTimeout'),
    mock.method(globalThis, 'setInterval'),
    mock.method(globalThis, 'setImmediate'),
    mock.method(timers, 'setTimeout'),
    mock.method(timers, 'setInterval'),
    mock.method(timers, 'setImmediate'),
    mock.method(promises, 'setTimeout'),
    mock.method(promises, 'setInterval'),
    mock.method(promises, 'setImmediate'),
    mock.method(promises.scheduler, 'wait'),
    mock.method(promises.scheduler, 'yield'),
  ];
  return {
    /** The timer calls made from this package's own code. */
    ours: () =>
      watched
        .flatMap((fn) => fn.mock.calls)
        .filter((call) => armedByPackage(call.stack.stack ?? '')).length,
  };
}
