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
 * How long `disconnect()` may spend ending the session on the server.
 *
 * Its own knob rather than `getTimeout('default')` (45 s): this bounds a
 * best-effort GET issued while a teardown is on the serializing tail, where
 * every later connect or disconnect queues behind it. A logoff that has not
 * answered in a few seconds is not going to, and a caller who wants a different
 * bound passes `deadlineMs` — see `ISessionLifecycleAware.disconnect`.
 */
export function getReleaseDeadline(): number {
  return parseInt(process.env.SAP_RELEASE_DEADLINE_MS || '5000', 10);
}
