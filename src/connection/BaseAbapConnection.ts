import { SapConfig } from "../config/sapConfig.js";
import { AbstractAbapConnection } from "./AbstractAbapConnection.js";
import { ILogger, ISessionStorage } from "../logger.js";

/**
 * Basic Authentication connection for on-premise SAP systems
 */
export class BaseAbapConnection extends AbstractAbapConnection {
  constructor(
    config: SapConfig,
    logger: ILogger,
    sessionStorage?: ISessionStorage,
    sessionId?: string
  ) {
    BaseAbapConnection.validateConfig(config);
    super(config, logger, sessionStorage, sessionId);
  }

  protected buildAuthorizationHeader(): string {
    const { username, password } = this.getConfig();
    const safeUsername = username ?? "";
    const safePassword = password ?? "";
    const token = Buffer.from(`${safeUsername}:${safePassword}`).toString("base64");
    return `Basic ${token}`;
  }

  private static validateConfig(config: SapConfig): void {
    if (config.authType !== "basic") {
      throw new Error(`Basic authentication connection expects authType "basic", got "${config.authType}"`);
    }

    if (!config.username || !config.password) {
      throw new Error("Basic authentication requires both username and password");
    }

    if (!config.client) {
      throw new Error("Basic authentication requires SAP_CLIENT to be provided");
    }
  }
}

