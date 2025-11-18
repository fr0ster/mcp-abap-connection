import { SapConfig } from "../config/sapConfig.js";
import { AbstractAbapConnection } from "./AbstractAbapConnection.js";
import { AbapRequestOptions } from "./AbapConnection.js";
import { ILogger, ISessionStorage } from "../logger.js";
import { refreshJwtToken } from "../utils/tokenRefresh.js";
import { AxiosError, AxiosResponse } from "axios";

/**
 * JWT Authentication connection for SAP BTP Cloud systems
 * Supports automatic token refresh using OAuth2 refresh tokens
 */
export class JwtAbapConnection extends AbstractAbapConnection {
  private tokenRefreshInProgress: boolean = false;

  constructor(
    config: SapConfig,
    logger: ILogger,
    sessionStorage?: ISessionStorage,
    sessionId?: string
  ) {
    JwtAbapConnection.validateConfig(config);
    super(config, logger, sessionStorage, sessionId);
  }

  protected buildAuthorizationHeader(): string {
    const { jwtToken } = this.getConfig();
    return `Bearer ${jwtToken}`;
  }

  /**
   * Refresh JWT token using refresh token
   * @returns Promise that resolves when token is refreshed
   */
  async refreshToken(): Promise<void> {
    const config = this.getConfig();

    if (!config.refreshToken) {
      throw new Error("Refresh token is not available. Please re-authenticate.");
    }

    if (!config.uaaUrl || !config.uaaClientId || !config.uaaClientSecret) {
      throw new Error(
        "UAA credentials are not available for token refresh. " +
        "Please provide UAA_URL, UAA_CLIENT_ID, and UAA_CLIENT_SECRET in configuration or re-authenticate."
      );
    }

    // Prevent concurrent refresh attempts
    if (this.tokenRefreshInProgress) {
      this.logger.debug("Token refresh already in progress, waiting...");
      // Wait for ongoing refresh to complete
      while (this.tokenRefreshInProgress) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return;
    }

    this.tokenRefreshInProgress = true;

    try {
      this.logger.debug("Refreshing JWT token...");
      const tokens = await refreshJwtToken(
        config.refreshToken,
        config.uaaUrl,
        config.uaaClientId,
        config.uaaClientSecret
      );

      // Update config with new tokens
      config.jwtToken = tokens.accessToken;
      if (tokens.refreshToken) {
        config.refreshToken = tokens.refreshToken;
      }

      // Clear CSRF token and cookies to force new session with new token
      this.reset();

      this.logger.debug("JWT token refreshed successfully");
    } catch (error: any) {
      this.logger.error(`Failed to refresh JWT token: ${error.message}`);
      throw error;
    } finally {
      this.tokenRefreshInProgress = false;
    }
  }

  /**
   * Check if token refresh is possible
   */
  canRefreshToken(): boolean {
    const config = this.getConfig();
    return !!(
      config.refreshToken &&
      config.uaaUrl &&
      config.uaaClientId &&
      config.uaaClientSecret
    );
  }

  /**
   * Override makeAdtRequest to handle JWT token refresh on 401/403
   */
  async makeAdtRequest(options: AbapRequestOptions): Promise<AxiosResponse> {
    try {
      return await super.makeAdtRequest(options);
    } catch (error) {
      // Handle JWT auth errors (401/403)
      if (error instanceof AxiosError &&
          (error.response?.status === 401 || error.response?.status === 403)) {

        // Check if this is really an auth error, not a permissions error
        const responseData = error.response?.data;
        const responseText = typeof responseData === "string" ? responseData : JSON.stringify(responseData || "");

        // Don't retry on "No Access" errors - these are permission issues, not auth issues
        if (responseText.includes("ExceptionResourceNoAccess") ||
            responseText.includes("No authorization") ||
            responseText.includes("Missing authorization")) {
          throw error;
        }

        // Try token refresh if possible
        if (this.canRefreshToken()) {
          try {
            this.logger.debug(`Received ${error.response.status}, attempting JWT token refresh...`);
            await this.refreshToken();
            this.logger.debug(`✓ Token refreshed successfully, retrying ADT request...`);

            // Retry the request with new token
            return await super.makeAdtRequest(options);
          } catch (refreshError: any) {
            this.logger.error(`❌ Token refresh failed: ${refreshError.message}`);
            throw new Error("JWT token has expired and refresh failed. Please re-authenticate.");
          }
        } else {
          throw new Error("JWT token has expired. Please refresh your authentication token.");
        }
      }

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

