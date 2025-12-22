import type { ITokenRefresher } from '@mcp-abap-adt/interfaces';
import { AxiosError, type AxiosResponse } from 'axios';
import type { SapConfig } from '../config/sapConfig.js';
import type { ILogger } from '../logger.js';
import type { AbapRequestOptions } from './AbapConnection.js';
import { AbstractAbapConnection } from './AbstractAbapConnection.js';

/**
 * JWT Authentication connection for SAP BTP Cloud systems
 *
 * Supports automatic token refresh via ITokenRefresher injection:
 * - If tokenRefresher is provided, 401/403 errors trigger automatic token refresh
 * - If tokenRefresher is not provided, 401/403 errors throw an error (legacy behavior)
 */
export class JwtAbapConnection extends AbstractAbapConnection {
  private tokenRefresher?: ITokenRefresher;
  private currentToken: string;

  constructor(
    config: SapConfig,
    logger?: ILogger | null,
    sessionId?: string,
    tokenRefresher?: ITokenRefresher,
  ) {
    JwtAbapConnection.validateConfig(config);
    super(config, logger || null, sessionId);
    this.tokenRefresher = tokenRefresher;
    if (!config.jwtToken) {
      throw new Error('jwtToken is required for JwtAbapConnection');
    }
    this.currentToken = config.jwtToken;
  }

  protected buildAuthorizationHeader(): string {
    // Use currentToken which may have been refreshed
    const tokenPreview = this.currentToken
      ? `${this.currentToken.substring(0, 10)}...${this.currentToken.substring(Math.max(0, this.currentToken.length - 4))}`
      : 'null';
    this.logger?.debug(
      `[DEBUG] JwtAbapConnection.buildAuthorizationHeader - Using token: ${tokenPreview}`,
    );
    return `Bearer ${this.currentToken}`;
  }

  /**
   * Refresh the JWT token using the injected tokenRefresher
   * @returns true if token was refreshed, false if no refresher available
   */
  private async tryRefreshToken(): Promise<boolean> {
    if (!this.tokenRefresher) {
      this.logger?.debug(
        `[DEBUG] JwtAbapConnection - No tokenRefresher available, cannot refresh token`,
      );
      return false;
    }

    try {
      this.logger?.debug(
        `[DEBUG] JwtAbapConnection - Refreshing token via tokenRefresher...`,
      );
      const newToken = await this.tokenRefresher.refreshToken();
      this.currentToken = newToken;
      this.logger?.debug(
        `[DEBUG] JwtAbapConnection - Token refreshed successfully`,
      );
      return true;
    } catch (error) {
      this.logger?.error(
        `[ERROR] JwtAbapConnection - Failed to refresh token: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * Override connect to handle JWT token refresh on errors
   */
  async connect(): Promise<void> {
    const baseUrl = await this.getBaseUrl();
    const discoveryUrl = `${baseUrl}/sap/bc/adt/discovery`;

    this.logger?.debug(
      `[DEBUG] JwtAbapConnection - Connecting to SAP system: ${discoveryUrl}`,
    );

    try {
      // Try to get CSRF token (this will also get cookies)
      const token = await this.fetchCsrfToken(discoveryUrl, 3, 1000);
      this.setCsrfToken(token);

      this.logger?.debug('Successfully connected to SAP system', {
        hasCsrfToken: !!this.getCsrfToken(),
        hasCookies: !!this.getCookies(),
        cookieLength: this.getCookies()?.length || 0,
      });
    } catch (error) {
      // Handle JWT auth errors (401/403) during connect
      if (
        error instanceof AxiosError &&
        (error.response?.status === 401 || error.response?.status === 403)
      ) {
        // Check if this is really an auth error, not a permissions error
        const responseData = error.response?.data;
        const responseText =
          typeof responseData === 'string'
            ? responseData
            : JSON.stringify(responseData || '');

        // Don't retry on "No Access" errors
        if (
          responseText.includes('ExceptionResourceNoAccess') ||
          responseText.includes('No authorization') ||
          responseText.includes('Missing authorization')
        ) {
          throw error;
        }

        // Try to refresh token if tokenRefresher is available
        if (await this.tryRefreshToken()) {
          // Retry connect with new token
          this.logger?.debug(
            `[DEBUG] JwtAbapConnection - Retrying connect after token refresh...`,
          );
          return this.connect();
        }

        throw new Error('JWT token has expired. Please re-authenticate.');
      }

      // Re-throw other errors
      throw error;
    }
  }

  /**
   * Override makeAdtRequest to handle JWT auth errors with automatic token refresh
   */
  async makeAdtRequest(options: AbapRequestOptions): Promise<AxiosResponse> {
    this.logger?.debug(
      `[DEBUG] JwtAbapConnection.makeAdtRequest - Starting request: ${options.method} ${options.url}`,
    );
    try {
      const response = await super.makeAdtRequest(options);
      this.logger?.debug(
        `[DEBUG] JwtAbapConnection.makeAdtRequest - Request succeeded: ${response.status}`,
      );
      return response;
    } catch (error) {
      this.logger?.debug(
        `[DEBUG] JwtAbapConnection.makeAdtRequest - Request failed: ${error instanceof Error ? error.message : String(error)}`,
      );

      // Handle JWT auth errors (401/403)
      if (
        error instanceof AxiosError &&
        (error.response?.status === 401 || error.response?.status === 403)
      ) {
        this.logger?.debug(
          `[DEBUG] JwtAbapConnection.makeAdtRequest - Got ${error.response.status}, attempting token refresh...`,
        );

        // Check if this is really an auth error, not a permissions error
        const responseData = error.response?.data;
        const responseText =
          typeof responseData === 'string'
            ? responseData
            : JSON.stringify(responseData || '');

        // Don't retry on "No Access" errors - these are permission issues, not auth issues
        if (
          responseText.includes('ExceptionResourceNoAccess') ||
          responseText.includes('No authorization') ||
          responseText.includes('Missing authorization')
        ) {
          throw error;
        }

        // Try to refresh token if tokenRefresher is available
        if (await this.tryRefreshToken()) {
          // Reset connection state and retry request with new token
          this.logger?.debug(
            `[DEBUG] JwtAbapConnection.makeAdtRequest - Retrying request after token refresh...`,
          );
          this.reset();
          return super.makeAdtRequest(options);
        }

        throw new Error('JWT token has expired. Please re-authenticate.');
      }

      throw error;
    }
  }

  /**
   * Override fetchCsrfToken to handle JWT auth errors with automatic token refresh
   */
  protected async fetchCsrfToken(
    url: string,
    retryCount = 3,
    retryDelay = 1000,
  ): Promise<string> {
    try {
      // Try to fetch CSRF token using parent implementation
      return await super.fetchCsrfToken(url, retryCount, retryDelay);
    } catch (error) {
      // Handle JWT auth errors (401/403) during CSRF token fetch
      if (
        error instanceof AxiosError &&
        (error.response?.status === 401 || error.response?.status === 403)
      ) {
        // Check if this is really an auth error, not a permissions error
        const responseData = error.response?.data;
        const responseText =
          typeof responseData === 'string'
            ? responseData
            : JSON.stringify(responseData || '');

        // Don't retry on "No Access" errors
        if (
          responseText.includes('ExceptionResourceNoAccess') ||
          responseText.includes('No authorization') ||
          responseText.includes('Missing authorization')
        ) {
          throw error;
        }

        // Try to refresh token if tokenRefresher is available
        if (await this.tryRefreshToken()) {
          // Retry CSRF token fetch with new token
          this.logger?.debug(
            `[DEBUG] JwtAbapConnection.fetchCsrfToken - Retrying after token refresh...`,
          );
          return super.fetchCsrfToken(url, retryCount, retryDelay);
        }

        throw new Error('JWT token has expired. Please re-authenticate.');
      }

      // Re-throw other errors
      throw error;
    }
  }

  private static validateConfig(config: SapConfig): void {
    if (config.authType !== 'jwt') {
      throw new Error(
        `JWT connection expects authType "jwt", got "${config.authType}"`,
      );
    }

    if (!config.jwtToken) {
      throw new Error(
        'JWT authentication requires SAP_JWT_TOKEN to be provided',
      );
    }
  }
}
