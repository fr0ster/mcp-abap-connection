import { SapConfig } from "../config/sapConfig.js";
import { AbapConnection } from "./AbapConnection.js";
import { JwtAbapConnection } from "./JwtAbapConnection.js";
import { BaseAbapConnection } from "./BaseAbapConnection.js";
import { ILogger } from "../logger.js";

export function createAbapConnection(
  config: SapConfig,
  logger?: ILogger | null,
  sessionId?: string
): AbapConnection {
  switch (config.authType) {
    case "basic":
      return new BaseAbapConnection(config, logger, sessionId);
    case "jwt":
      return new JwtAbapConnection(config, logger, sessionId);
    default:
      throw new Error(`Unsupported SAP authentication type: ${config.authType}`);
  }
}

