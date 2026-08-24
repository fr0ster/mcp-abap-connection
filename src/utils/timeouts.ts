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
 * not abort such a request mid-flight — not because aborting ends anything on
 * the server, but because it ends what the CLIENT knows: the modification may
 * or may not have been applied, and the handle `unlock` needs is gone, while
 * the lock and the ABAP session holding it sit there until that server-side
 * idle timeout, which this side can neither read nor influence.
 * Configurable via SAP_TIMEOUT_CRITICAL (ms).
 * Default 600000 (10 minutes) — a generous ceiling that still guards against a
 * permanently dead socket hanging forever.
 */
export function getCriticalSectionTimeout(): number {
  return parseInt(process.env.SAP_TIMEOUT_CRITICAL || '600000', 10);
}
