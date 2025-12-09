import { SapConfig } from "../config/sapConfig.js";
import { AbstractAbapConnection } from "./AbstractAbapConnection.js";
import { ILogger } from "../logger.js";
import { AxiosError } from "axios";

/**
 * Basic Authentication connection for on-premise SAP systems
 */
export class BaseAbapConnection extends AbstractAbapConnection {
  constructor(
    config: SapConfig,
    logger?: ILogger | null,
    sessionId?: string
  ) {
    BaseAbapConnection.validateConfig(config);
    super(config, logger || null, sessionId);
  }

  /**
   * Connect to SAP system with Basic Auth
   * Fetches CSRF token which also establishes session cookies
   */
  async connect(): Promise<void> {
    const baseUrl = await this.getBaseUrl();
    const discoveryUrl = `${baseUrl}/sap/bc/adt/discovery`;

    this.logger?.debug(`[DEBUG] BaseAbapConnection - Connecting to SAP system: ${discoveryUrl}`);

    try {
      // Try to get CSRF token (this will also get cookies)
      const token = await this.fetchCsrfToken(discoveryUrl, 3, 1000);
      this.setCsrfToken(token);


      this.logger?.debug("Successfully connected to SAP system", {
        hasCsrfToken: !!this.getCsrfToken(),
        hasCookies: !!this.getCookies(),
        cookieLength: this.getCookies()?.length || 0
      });
    } catch (error) {
      // For Basic auth, log warning but don't fail
      // The retry logic in makeAdtRequest will handle transient errors automatically
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger?.warn(`[WARN] BaseAbapConnection - Could not connect to SAP system upfront: ${errorMsg}. Will retry on first request.`);

      // Still try to extract cookies from error response if available
      if (error instanceof AxiosError && error.response?.headers) {
        // updateCookiesFromResponse is private, but cookies are extracted in fetchCsrfToken
        if (this.getCookies()) {
          this.logger?.debug(`[DEBUG] BaseAbapConnection - Cookies extracted from error response during connect (first 100 chars): ${this.getCookies()!.substring(0, 100)}...`);
        }
      }
    }
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

