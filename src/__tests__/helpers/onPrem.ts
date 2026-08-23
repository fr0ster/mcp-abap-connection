/**
 * An on-prem connection over HTTP, for tests whose subject is the shared
 * machinery.
 *
 * The wire is required now and the caller builds it — including the two things
 * only the caller can wire, the credential's TLS material and the client. That
 * is the point of the change, and also why a test that is about critical
 * sections should not have to say it eight times.
 */
import type { IAuthProvider } from '@mcp-abap-adt/interfaces';
import { BasicAuthProvider } from '../../auth/providers.js';
import type { SapConfig } from '../../config/sapConfig.js';
import { AdtOnPremConnector } from '../../connection/AdtOnPremConnector.js';
import { CloudHttpTransport } from '../../connection/CloudHttpTransport.js';
import { OnPremHttpTransport } from '../../connection/OnPremHttpTransport.js';
import type { ILogger } from '../../logger.js';

export function onPremHttpTransport(
  config: SapConfig,
  logger: ILogger | null = null,
): OnPremHttpTransport {
  const credential: IAuthProvider = new BasicAuthProvider(
    config.username ?? '',
    config.password ?? '',
  );
  return new OnPremHttpTransport(
    // What the caller must wire now: the credential's TLS material configures
    // the wire, and nothing does it for them.
    () => credential.transportMaterial?.() ?? {},
    logger,
    { client: config.client, baseUrl: config.url },
  );
}

export function onPrem(
  config: SapConfig,
  logger: ILogger | null = null,
  sessionId?: string,
): AdtOnPremConnector<BasicAuthProvider, OnPremHttpTransport> {
  return new AdtOnPremConnector(
    config,
    new BasicAuthProvider(config.username ?? '', config.password ?? ''),
    onPremHttpTransport(config, logger),
    logger,
    sessionId,
  );
}

/** The cloud wire, built the way a consumer must build it. */
export function cloudHttpTransport(
  config: SapConfig,
  logger: ILogger | null = null,
): CloudHttpTransport {
  return new CloudHttpTransport(() => ({}), logger, {
    client: config.client,
    baseUrl: config.url,
  });
}
