/**
 * An on-prem connection, for tests whose subject is the shared machinery.
 *
 * Most of the suites that say `BaseAbapConnection` are not about basic
 * authentication at all — they are about CSRF conversations, critical sections,
 * session identity, stale-request fencing, teardown. That class was simply the
 * shortest concrete subclass to reach `AbstractAbapConnection` through, and it
 * is going away.
 *
 * This keeps those tests aimed at what they are actually testing. The signature
 * deliberately mirrors the one they used, so the change at each call site is
 * the name and nothing else — a re-point that also rewrote arguments would hide
 * a behaviour change inside a mechanical diff.
 */
import { BasicAuthProvider } from '../../auth/providers.js';
import type { SapConfig } from '../../config/sapConfig.js';
import { AdtOnPremConnector } from '../../connection/AdtOnPremConnector.js';
import type { HttpTransport } from '../../connection/HttpTransport.js';
import type { IAdtTransport } from '../../connection/IAdtTransport.js';
import type { ILogger } from '../../logger.js';

export function onPrem<T extends IAdtTransport = HttpTransport>(
  config: SapConfig,
  logger: ILogger | null = null,
  sessionId?: string,
  options?: { skipSessionType?: boolean; transport?: T },
): AdtOnPremConnector<BasicAuthProvider, T> {
  return new AdtOnPremConnector(
    config,
    new BasicAuthProvider(config.username ?? '', config.password ?? ''),
    logger,
    sessionId,
    options,
  );
}
