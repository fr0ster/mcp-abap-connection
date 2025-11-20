import { SapConfig } from "../config/sapConfig.js";
import { AbstractAbapConnection } from "./AbstractAbapConnection.js";
import { AbapRequestOptions } from "./AbapConnection.js";
import { ILogger, ISessionStorage, SessionState } from "../logger.js";
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
    const config = this.getConfig();
    const { jwtToken } = config;
    // Log token preview for debugging (first 10 and last 4 chars)
    const tokenPreview = jwtToken ? `${jwtToken.substring(0, 10)}...${jwtToken.substring(Math.max(0, jwtToken.length - 4))}` : 'null';
    this.logger.debug(`[DEBUG] JwtAbapConnection.buildAuthorizationHeader - Using token: ${tokenPreview}`);
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
      // NOTE: This updates the config object directly, which is shared with the connection cache
      // The connection cache will be invalidated on next getManagedConnection() call because
      // sapConfigSignature includes token preview, so signature will change
      const oldTokenPreview = config.jwtToken ? `${config.jwtToken.substring(0, 10)}...${config.jwtToken.substring(Math.max(0, config.jwtToken.length - 4))}` : 'null';
      config.jwtToken = tokens.accessToken;
      if (tokens.refreshToken) {
        config.refreshToken = tokens.refreshToken;
      }
      const newTokenPreview = config.jwtToken ? `${config.jwtToken.substring(0, 10)}...${config.jwtToken.substring(Math.max(0, config.jwtToken.length - 4))}` : 'null';

      this.logger.debug(`[DEBUG] JwtAbapConnection.refreshToken - Token updated in config: ${oldTokenPreview} -> ${newTokenPreview}`);
      this.logger.debug(`[DEBUG] JwtAbapConnection.refreshToken - Config object reference check: ${config === this.getConfig() ? 'same object ✓' : 'different object ✗'}`);

      // Clear CSRF token and cookies to force new session with new token
      // IMPORTANT: After token refresh, we must clear saved session state because
      // old cookies/CSRF token are tied to the old JWT token and won't work with new token
      this.reset();

      // Also clear saved session state from storage if using stateful session
      // This prevents reloading old cookies/CSRF token that are tied to old JWT token
      const sessionStorage = this.getSessionStorage();
      const sessionId = this.getSessionId();
      if (sessionStorage && sessionId) {
        try {
          await this.clearSessionState();
          this.logger.debug(`[DEBUG] JwtAbapConnection.refreshToken - Cleared saved session state from storage`);
        } catch (error) {
          this.logger.warn(`[DEBUG] JwtAbapConnection.refreshToken - Failed to clear session state: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      this.logger.debug("JWT token refreshed successfully");
      this.logger.debug("NOTE: Connection cache will be invalidated on next getManagedConnection() call due to changed token signature");
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
   * Override connect to handle JWT token refresh on errors
   */
  async connect(): Promise<void> {
    const baseUrl = await this.getBaseUrl();
    const discoveryUrl = `${baseUrl}/sap/bc/adt/discovery`;

    this.logger.debug(`[DEBUG] JwtAbapConnection - Connecting to SAP system: ${discoveryUrl}`);

    // If we have saved session state, load it first to compare later
    const sessionStorage = this.getSessionStorage();
    const sessionId = this.getSessionId();
    let savedState: SessionState | null = null;
    if (sessionStorage && sessionId) {
      try {
        savedState = await sessionStorage.load(sessionId);
        if (savedState) {
          this.logger.debug(`[DEBUG] JwtAbapConnection.connect - Loaded saved session state for comparison`);
        }
      } catch (error) {
        this.logger.debug(`[DEBUG] JwtAbapConnection.connect - No saved session state found or failed to load`);
      }
    }

    try {
      // Try to get CSRF token (this will also get cookies)
      const token = await this.fetchCsrfToken(discoveryUrl, 3, 1000);
      this.setCsrfToken(token);

      // Compare new session state with saved state
      const newState: SessionState = {
        cookies: this.getCookies(),
        csrfToken: this.getCsrfToken(),
        cookieStore: Object.fromEntries((this as any).cookieStore || new Map())
      };

      // Only save if session state changed
      if (savedState) {
        const cookiesChanged = savedState.cookies !== newState.cookies;
        const csrfTokenChanged = savedState.csrfToken !== newState.csrfToken;
        const cookieStoreChanged = JSON.stringify(savedState.cookieStore) !== JSON.stringify(newState.cookieStore);

        if (cookiesChanged || csrfTokenChanged || cookieStoreChanged) {
          this.logger.debug(`[DEBUG] JwtAbapConnection.connect - Session state changed, saving new state`, {
            cookiesChanged,
            csrfTokenChanged,
            cookieStoreChanged
          });
          await this.saveSessionState();
        } else {
          this.logger.debug(`[DEBUG] JwtAbapConnection.connect - Session state unchanged, not saving`);
        }
      } else {
        // No saved state, save new one
        await this.saveSessionState();
      }

      this.logger.debug("Successfully connected to SAP system", {
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

        // Try token refresh if possible
        if (this.canRefreshToken()) {
          try {
            this.logger.debug(`Received ${error.response.status} during connect, attempting JWT token refresh...`);
            await this.refreshToken();
            this.logger.debug(`✓ Token refreshed successfully, retrying connect...`);

            // Retry CSRF token fetch with new JWT token
            const token = await this.fetchCsrfToken(discoveryUrl, 3, 1000);
            this.setCsrfToken(token);
            await this.saveSessionState();

            this.logger.debug("Successfully connected after JWT refresh", {
              hasCsrfToken: !!this.getCsrfToken(),
              hasCookies: !!this.getCookies()
            });
            return;
          } catch (refreshError: any) {
            this.logger.error(`❌ Token refresh failed during connect: ${refreshError.message}`);
            throw new Error("JWT token has expired and refresh failed. Please re-authenticate.");
          }
        } else {
          throw new Error("JWT token has expired. Please refresh your authentication token.");
        }
      }

      // Re-throw other errors
      throw error;
    }
  }


  /**
   * Override makeAdtRequest to handle JWT token refresh on 401/403
   */
  async makeAdtRequest(options: AbapRequestOptions): Promise<AxiosResponse> {
    this.logger.debug(`[DEBUG] JwtAbapConnection.makeAdtRequest - Starting request: ${options.method} ${options.url}`);
    try {
      const response = await super.makeAdtRequest(options);
      this.logger.debug(`[DEBUG] JwtAbapConnection.makeAdtRequest - Request succeeded: ${response.status}`);
      return response;
    } catch (error) {
      this.logger.debug(`[DEBUG] JwtAbapConnection.makeAdtRequest - Request failed: ${error instanceof Error ? error.message : String(error)}`);

      // Handle JWT auth errors (401/403)
      if (error instanceof AxiosError &&
          (error.response?.status === 401 || error.response?.status === 403)) {
        this.logger.debug(`[DEBUG] JwtAbapConnection.makeAdtRequest - Got ${error.response.status}, checking if refresh is possible...`);

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
        const canRefresh = this.canRefreshToken();
        const config = this.getConfig();
        this.logger.debug(`[DEBUG] JwtAbapConnection.makeAdtRequest - canRefreshToken: ${canRefresh}`, {
          hasRefreshToken: !!config.refreshToken,
          hasUaaUrl: !!config.uaaUrl,
          hasUaaClientId: !!config.uaaClientId,
          hasUaaClientSecret: !!config.uaaClientSecret
        });

        if (canRefresh) {
          // Step 1: Refresh token
          try {
            this.logger.debug(`Received ${error.response.status}, attempting JWT token refresh...`);
            await this.refreshToken();
            this.logger.debug(`✓ Token refreshed successfully, reconnecting to get new CSRF token...`);
          } catch (refreshError: any) {
            // Only catch errors from refreshToken()
            this.logger.error(`❌ Token refresh failed: ${refreshError.message}`);
            throw new Error("JWT token has expired and refresh failed. Please re-authenticate.");
          }

          // Step 2: Reconnect to get new CSRF token and cookies
          try {
            this.logger.debug(`[DEBUG] JwtAbapConnection - Calling connect() after token refresh to get CSRF token...`);
            await this.connect();
            const hasCsrf = !!this.getCsrfToken();
            const hasCookies = !!this.getCookies();
            this.logger.debug(`✓ Reconnected successfully after token refresh`, {
              hasCsrfToken: hasCsrf,
              hasCookies: hasCookies,
              csrfTokenLength: this.getCsrfToken()?.length || 0,
              cookiesLength: this.getCookies()?.length || 0
            });

            if (!hasCsrf) {
              this.logger.error(`❌ CRITICAL: CSRF token not obtained after reconnect! Request may fail.`);
            }
          } catch (connectError: any) {
            this.logger.error(`❌ Failed to reconnect after token refresh: ${connectError.message}`);
            this.logger.error(`❌ This means CSRF token will not be available for POST/PUT/DELETE requests`);
            // Continue anyway - ensureFreshCsrfToken will try to get CSRF token during request retry
            // But this is likely to fail if connect() failed
          }

          // Step 3: Retry the request with new token
          // ensureFreshCsrfToken will be called automatically if CSRF token is missing
          this.logger.debug(`[DEBUG] JwtAbapConnection - Retrying ADT request after token refresh...`);
          try {
            return await super.makeAdtRequest(options);
          } catch (retryError: any) {
            // If retry fails with 401/403, it means token refresh didn't help - re-throw as auth error
            if (retryError instanceof AxiosError &&
                (retryError.response?.status === 401 || retryError.response?.status === 403)) {
              this.logger.error(`❌ Token refresh didn't help - still getting ${retryError.response.status}`);
              throw new Error("JWT token has expired and refresh failed. Please re-authenticate.");
            }
            // For other errors (400, 500, etc.), re-throw the original error
            // These are not auth errors, so they should be handled by the caller
            this.logger.debug(`[DEBUG] JwtAbapConnection - Retry request failed with non-auth error: ${retryError.response?.status || 'unknown'}`);
            throw retryError;
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

