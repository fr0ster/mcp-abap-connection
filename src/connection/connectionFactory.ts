import { SapConfig } from "../config/sapConfig.js";
import { AbapConnection } from "./AbapConnection.js";
import { JwtAbapConnection } from "./JwtAbapConnection.js";
import { BaseAbapConnection } from "./BaseAbapConnection.js";
import { ILogger, ISessionStorage } from "../logger.js";

export function createAbapConnection(
  config: SapConfig,
  logger: ILogger,
  sessionStorage?: ISessionStorage,
  sessionId?: string
): AbapConnection {
  switch (config.authType) {
    case "basic":
      return new BaseAbapConnection(config, logger, sessionStorage, sessionId);
    case "jwt":
      return new JwtAbapConnection(config, logger, sessionStorage, sessionId);
    default:
      throw new Error(`Unsupported SAP authentication type: ${config.authType}`);
  }
}

