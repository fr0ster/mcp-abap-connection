import type {
  ICertificateMaterialLoader,
  ITokenRefresher,
} from '@mcp-abap-adt/interfaces';
import type { IAuthProvider } from '../auth/IAuthProvider.js';
import {
  BasicAuthProvider,
  CertificateAuthProvider,
  SamlAuthProvider,
  TokenAuthProvider,
} from '../auth/providers.js';
import type { SapConfig } from '../config/sapConfig.js';
import type { ILogger } from '../logger.js';
import type { AbapConnection } from './AbapConnection.js';
import { AdtCloudConnector } from './AdtCloudConnector.js';
import { AdtOnPremConnector } from './AdtOnPremConnector.js';
import { BaseAbapConnection } from './BaseAbapConnection.js';
import { CertificateAbapConnection } from './CertificateAbapConnection.js';
import { JwtAbapConnection } from './JwtAbapConnection.js';
import { KerberosAbapConnection } from './KerberosAbapConnection.js';
import { RfcAbapConnection } from './RfcAbapConnection.js';
import { SamlAbapConnection } from './SamlAbapConnection.js';

/**
 * The provider for the credential this config carries.
 *
 * Reading `authType` here is not the thing the split removed: it says HOW to
 * authenticate, which is what it always meant. What it no longer does is decide
 * which system this is — the caller said that.
 */
function authProviderFor(
  config: SapConfig,
  options: { certLoader?: ICertificateMaterialLoader },
  tokenRefresher?: ITokenRefresher,
): IAuthProvider {
  switch (config.authType) {
    case 'jwt':
      // No longer refused. It was, while renewal lived only in
      // JwtAbapConnection and this path would have handed back a connection
      // that died on the first expiry. The connector now tells the provider
      // when a token was rejected and rebuilds the session behind it, so a
      // refresher passed here is used for what it is for.
      return new TokenAuthProvider(tokenRefresher ?? config.jwtToken ?? '');
    case 'saml':
      return new SamlAuthProvider(config.sessionCookies ?? '');
    case 'certificate':
      if (!options.certLoader) {
        throw new Error(
          'authType "certificate" needs options.certLoader to load the material.',
        );
      }
      return new CertificateAuthProvider(options.certLoader, config);
    case 'basic':
      return new BasicAuthProvider(
        config.username ?? '',
        config.password ?? '',
      );
    default:
      throw new Error(
        `authType "${config.authType}" has no auth provider yet; use the deprecated class for it.`,
      );
  }
}

/**
 * Builds the connection the caller asked for.
 *
 * **Say which system it is** with `options.system`, and that is what you get —
 * `'onprem'` or `'cloud'` — with the credential built from the config and
 * handed in as an auth provider. Nothing about the system is worked out here:
 * not from the credential, not from the host name, not by asking the server.
 *
 * Without it, the old behaviour: a connection chosen from `authType`, which is
 * the arrangement where the credential drags the session mechanism along with
 * it and gets one of them wrong. **Deprecated**, kept so existing callers keep
 * working, and warned about once per call so it is visible rather than
 * inherited by accident.
 */
export function createAbapConnection(
  config: SapConfig,
  logger?: ILogger | null,
  sessionId?: string,
  tokenRefresher?: ITokenRefresher,
  options?: {
    skipSessionType?: boolean;
    certLoader?: ICertificateMaterialLoader;
    /** Which system this is. Said by the caller; never inferred. */
    system?: 'onprem' | 'cloud';
  },
): AbapConnection {
  // RFC connection type takes priority over auth type
  if (config.connectionType === 'rfc') {
    if (config.authType === 'certificate' || config.authType === 'kerberos') {
      throw new Error(
        `authType "${config.authType}" is not supported with connectionType "rfc".`,
      );
    }
    return new RfcAbapConnection(config, logger);
  }

  if (options?.system) {
    const provider = authProviderFor(config, options, tokenRefresher);
    const Connector =
      options.system === 'cloud' ? AdtCloudConnector : AdtOnPremConnector;
    return new Connector(config, provider, logger ?? null, sessionId, options);
  }

  logger?.warn(
    "createAbapConnection(): no options.system given, so the connection is chosen from authType — which lets the credential decide the session mechanism. Pass system: 'onprem' | 'cloud'.",
  );

  switch (config.authType) {
    case 'basic':
      return new BaseAbapConnection(config, logger, sessionId, options);
    case 'jwt':
      return new JwtAbapConnection(config, logger, sessionId, tokenRefresher);
    case 'saml':
      return new SamlAbapConnection(config, logger, sessionId, options);
    case 'certificate':
      return new CertificateAbapConnection(
        config,
        logger,
        sessionId,
        options?.certLoader,
      );
    case 'kerberos':
      return new KerberosAbapConnection(config, logger, sessionId);
    default:
      throw new Error(
        `Unsupported SAP authentication type: ${config.authType}`,
      );
  }
}
