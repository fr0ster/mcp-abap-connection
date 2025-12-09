import { SapConfig } from "../config/sapConfig.js";
import { AbstractAbapConnection } from "./AbstractAbapConnection.js";
import { AbapRequestOptions } from "./AbapConnection.js";
import { ILogger } from "../logger.js";
import { AxiosError, AxiosResponse } from "axios";

/**
 * JWT Authentication connection for SAP BTP Cloud systems
 * Note: Token refresh functionality is not supported in this package.
 * Use @mcp-abap-adt/auth-broker for token refresh functionality.
 */
export class JwtAbapConnection extends AbstractAbapConnection {

  constructor(
    config: SapConfig,
    logger?: ILogger | null,
    sessionId?: string
  ) {
    JwtAbapConnection.validateConfig(config);
    super(config, logger || null, sessionId);
  }

  protected buildAuthorizationHeader(): string {
    const config = this.getConfig();
    const { jwtToken } = config;
    // Log token preview for debugging (first 10 and last 4 chars)
    const tokenPreview = jwtToken ? `${jwtToken.substring(0, 10)}...${jwtToken.substring(Math.max(0, jwtToken.length - 4))}` : 'null';
    this.logger?.debug(`[DEBUG] JwtAbapConnection.buildAuthorizationHeader - Using token: ${tokenPreview}`);
    return `Bearer ${jwtToken}`;
  }



  /**
   * Override connect to handle JWT token refresh on errors
   */
  async connect(): Promise<void> {
    const baseUrl = await this.getBaseUrl();
    const discoveryUrl = `${baseUrl}/sap/bc/adt/discovery`;

    this.logger?.debug(`[DEBUG] JwtAbapConnection - Connecting to SAP system: ${discoveryUrl}`);

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
      // Handle JWT auth errors (401/403) during connect
      if (error instanceof AxiosError &&
          (error.response?.status === 401 || error.response?.status === 403)) {

        // Check if this is really an auth error, not a permissions error
        const responseData = error.response?.data;
        const responseText = typeof responseData === "string" ? responseData : JSON.stringify(responseData || "");

        // Don't retry on "No Access" errors
        if (responseText.includes("ExceptionResourceNoAccess") ||
            responseText.includes("No authorization") ||
            responseText.includes("Missing authorization")) {
          throw error;
        }

        // Token refresh is not supported in connection package
        // Use auth-broker for token refresh functionality
        throw new Error("JWT token has expired. Please re-authenticate.");
      }

      // Re-throw other errors
      throw error;
    }
  }


  /**
   * Override makeAdtRequest to handle JWT auth errors
   * Note: Token refresh is not supported in connection package - use auth-broker instead
   */
  async makeAdtRequest(options: AbapRequestOptions): Promise<AxiosResponse> {
    this.logger?.debug(`[DEBUG] JwtAbapConnection.makeAdtRequest - Starting request: ${options.method} ${options.url}`);
    try {
      const response = await super.makeAdtRequest(options);
      this.logger?.debug(`[DEBUG] JwtAbapConnection.makeAdtRequest - Request succeeded: ${response.status}`);
      return response;
    } catch (error) {
      this.logger?.debug(`[DEBUG] JwtAbapConnection.makeAdtRequest - Request failed: ${error instanceof Error ? error.message : String(error)}`);

      // Handle JWT auth errors (401/403)
      if (error instanceof AxiosError &&
          (error.response?.status === 401 || error.response?.status === 403)) {
        this.logger?.debug(`[DEBUG] JwtAbapConnection.makeAdtRequest - Got ${error.response.status}, checking if refresh is possible...`);

        // Check if this is really an auth error, not a permissions error
        const responseData = error.response?.data;
        const responseText = typeof responseData === "string" ? responseData : JSON.stringify(responseData || "");

        // Don't retry on "No Access" errors - these are permission issues, not auth issues
        if (responseText.includes("ExceptionResourceNoAccess") ||
            responseText.includes("No authorization") ||
            responseText.includes("Missing authorization")) {
          throw error;
        }

        // Token refresh is not supported in connection package
        // Use auth-broker for token refresh functionality
        throw new Error("JWT token has expired. Please re-authenticate.");
      }

      throw error;
    }
  }

  /**
   * Override fetchCsrfToken to handle JWT auth errors
   * Note: Token refresh is not supported in connection package - use auth-broker instead
   */
  protected async fetchCsrfToken(url: string, retryCount = 3, retryDelay = 1000): Promise<string> {
    try {
      // Try to fetch CSRF token using parent implementation
      return await super.fetchCsrfToken(url, retryCount, retryDelay);
    } catch (error) {
      // Handle JWT auth errors (401/403) during CSRF token fetch
      if (error instanceof AxiosError &&
          (error.response?.status === 401 || error.response?.status === 403)) {

        // Check if this is really an auth error, not a permissions error
        const responseData = error.response?.data;
        const responseText = typeof responseData === "string" ? responseData : JSON.stringify(responseData || "");

        // Don't retry on "No Access" errors
        if (responseText.includes("ExceptionResourceNoAccess") ||
            responseText.includes("No authorization") ||
            responseText.includes("Missing authorization")) {
          throw error;
        }

        // Token refresh is not supported in connection package
        // Use auth-broker for token refresh functionality
        throw new Error("JWT token has expired. Please re-authenticate.");
      }

      // Re-throw other errors
      throw error;
    }
  }

  private static validateConfig(config: SapConfig): void {
    if (config.authType !== "jwt") {
      throw new Error(`JWT connection expects authType "jwt", got "${config.authType}"`);
    }

    if (!config.jwtToken) {
      throw new Error("JWT authentication requires SAP_JWT_TOKEN to be provided");
    }
  }
}

