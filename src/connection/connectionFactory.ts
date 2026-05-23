import type {
  ICertificateMaterialLoader,
  ITokenRefresher,
} from '@mcp-abap-adt/interfaces';
import type { SapConfig } from '../config/sapConfig.js';
import type { ILogger } from '../logger.js';
import type { AbapConnection } from './AbapConnection.js';
import { BaseAbapConnection } from './BaseAbapConnection.js';
import { CertificateAbapConnection } from './CertificateAbapConnection.js';
import { JwtAbapConnection } from './JwtAbapConnection.js';
import { KerberosAbapConnection } from './KerberosAbapConnection.js';
import { RfcAbapConnection } from './RfcAbapConnection.js';
import { SamlAbapConnection } from './SamlAbapConnection.js';

export function createAbapConnection(
  config: SapConfig,
  logger?: ILogger | null,
  sessionId?: string,
  tokenRefresher?: ITokenRefresher,
  options?: {
    skipSessionType?: boolean;
    certLoader?: ICertificateMaterialLoader;
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
