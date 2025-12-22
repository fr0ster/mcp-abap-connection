import type { ITokenRefresher } from '@mcp-abap-adt/interfaces';
import type { SapConfig } from '../config/sapConfig.js';
import type { ILogger } from '../logger.js';
import type { AbapConnection } from './AbapConnection.js';
import { BaseAbapConnection } from './BaseAbapConnection.js';
import { JwtAbapConnection } from './JwtAbapConnection.js';

export function createAbapConnection(
  config: SapConfig,
  logger?: ILogger | null,
  sessionId?: string,
  tokenRefresher?: ITokenRefresher,
): AbapConnection {
  switch (config.authType) {
    case 'basic':
      return new BaseAbapConnection(config, logger, sessionId);
    case 'jwt':
      return new JwtAbapConnection(config, logger, sessionId, tokenRefresher);
    default:
      throw new Error(
        `Unsupported SAP authentication type: ${config.authType}`,
      );
  }
}
