import type { ITimeoutConfig } from '@mcp-abap-adt/interfaces';

// Re-export for backward compatibility
export type TimeoutConfig = ITimeoutConfig;

export function getTimeoutConfig(): ITimeoutConfig {
  const defaultTimeout = parseInt(
    process.env.SAP_TIMEOUT_DEFAULT || '45000',
    10,
  );
  const csrfTimeout = parseInt(process.env.SAP_TIMEOUT_CSRF || '15000', 10);
  const longTimeout = parseInt(process.env.SAP_TIMEOUT_LONG || '60000', 10);

  return {
    default: defaultTimeout,
    csrf: csrfTimeout,
    long: longTimeout,
  };
}

export function getTimeout(
  type: 'default' | 'csrf' | 'long' | number = 'default',
): number {
  if (typeof type === 'number') {
    return type;
  }

  const config = getTimeoutConfig();
  return config[type];
}

/**
 * Large ceiling timeout applied while a connection is inside an uninterruptible
 * critical section (lock → modify → unlock). A short per-request timeout must
 * not abort such a request mid-flight: aborting tears down the socket, which
 * drops the stateful ADT session and orphans the lock handle (object left
 * locked and inactive). Configurable via SAP_TIMEOUT_CRITICAL (ms).
 * Default 600000 (10 minutes) — a generous ceiling that still guards against a
 * permanently dead socket hanging forever.
 */
export function getCriticalSectionTimeout(): number {
  return parseInt(process.env.SAP_TIMEOUT_CRITICAL || '600000', 10);
}

/**
 * How long `disconnect()` may spend telling the server the session is done.
 *
 * **Zero by default: after a disconnect nothing waits on the answer.** Waiting
 * is for steps whose successor depends on the server having caught up — lock,
 * update, unlock, activate, each needing the one before it to have landed.
 * A teardown has no successor: the session is marked unneeded, the server
 * reclaims it whenever it reclaims it, and a caller blocked on that round trip
 * has bought nothing while holding up the serializing tail, where every later
 * connect and disconnect queues behind it.
 *
 * The knob exists for a caller that wants a bounded wait anyway — a test
 * asserting the logoff landed, a script that would rather see the failure —
 * and is theirs to set per call via `ISessionLifecycleAware.disconnect`.
 */
export function getReleaseDeadline(): number {
  return parseInt(process.env.SAP_RELEASE_DEADLINE_MS || '0', 10);
}
