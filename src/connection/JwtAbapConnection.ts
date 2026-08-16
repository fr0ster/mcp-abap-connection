import type { IAdtResponse, ITokenRefresher } from '@mcp-abap-adt/interfaces';
import { AxiosError } from 'axios';
import type { SapConfig } from '../config/sapConfig.js';
import type { ILogger } from '../logger.js';
import type { AbapRequestOptions } from './AbapConnection.js';
import { AbstractAbapConnection } from './AbstractAbapConnection.js';
import { CSRF_CONFIG } from './csrfConfig.js';

/**
 * Is this worth refreshing a token for?
 *
 * 401 only. A 403 means the server authenticated the caller and refused the
 * action anyway — a new token is the same caller, so refreshing answers a
 * question nobody asked and, worse, used to end with the original error
 * replaced by "JWT token has expired". See issue #30.
 */
function isTokenExpiryCandidate(error: unknown): error is AxiosError {
  return error instanceof AxiosError && error.response?.status === 401;
}

/**
 * JWT Authentication connection for SAP BTP Cloud systems
 *
 * Supports automatic token refresh via ITokenRefresher injection:
 * - a **401** triggers a token refresh when a tokenRefresher is available;
 * - without one, or when the refresh does not help, the server's own error is
 *   thrown unchanged — status and body intact;
 * - a **403** is never a token problem. It propagates as it arrived, because a
 *   new token is the same caller and cannot change a permissions answer.
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
   * Establishes the session for this auth type. Called by
   * AbstractAbapConnection.connect(), which owns the lifecycle around it.
   */
  protected async establishSession(): Promise<void> {
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
      if (isTokenExpiryCandidate(error)) {
        this.logger?.error(
          '[ERROR] JwtAbapConnection.establishSession - 401 while establishing; fetchCsrfToken has already refreshed and retried for this',
        );
      }
      throw error;
    }
  }

  /**
   * Override makeAdtRequest to handle JWT auth errors with automatic token refresh
   */
  async makeAdtRequest<T = any, D = any>(
    options: AbapRequestOptions,
  ): Promise<IAdtResponse<T, D>> {
    // Captured before the attempt: a recovery asks "has the caller asked to
    // stop since this request began", not since some later bookkeeping step.
    const baselineEpoch = this.teardownEpoch;
    this.logger?.debug(
      `[DEBUG] JwtAbapConnection.makeAdtRequest - Starting request: ${options.method} ${options.url}`,
    );
    try {
      const response = await super.makeAdtRequest<T, D>(options);
      this.logger?.debug(
        `[DEBUG] JwtAbapConnection.makeAdtRequest - Request succeeded: ${response.status}`,
      );
      return response;
    } catch (error) {
      this.logger?.debug(
        `[DEBUG] JwtAbapConnection.makeAdtRequest - Request failed: ${error instanceof Error ? error.message : String(error)}`,
      );

      if (isTokenExpiryCandidate(error)) {
        this.logger?.debug(
          `[DEBUG] JwtAbapConnection.makeAdtRequest - Got 401, attempting token refresh...`,
        );

        // Try to refresh token if tokenRefresher is available
        if (await this.tryRefreshToken()) {
          this.logger?.debug(
            `[DEBUG] JwtAbapConnection.makeAdtRequest - Recovering session after token refresh...`,
          );
          // The renewed credential cannot keep the old ABAP session, so this is
          // a session-lost teardown — internal, or it would cancel the very
          // recovery it is setting up. reset() would be the caller-origin one.
          this.discardSession();
          // Re-establish before retrying: the retry goes through admission, and
          // a discarded session admits nothing.
          await this.recoverSession(baselineEpoch);
          return super.makeAdtRequest<T, D>(options);
        }

        this.logger?.error(
          '[ERROR] JwtAbapConnection.makeAdtRequest - 401 persists and the token could not be refreshed; the credential may need re-authentication',
        );
      }

      throw error;
    }
  }

  /**
   * Override fetchCsrfToken to handle JWT auth errors with automatic token refresh
   */
  protected async fetchCsrfToken(
    url: string,
    retryCount: number = CSRF_CONFIG.RETRY_COUNT,
    retryDelay: number = CSRF_CONFIG.RETRY_DELAY,
    /** Fences the response effects; omitted during connect(), which has no lease. */
    generation?: number,
  ): Promise<string> {
    try {
      // Try to fetch CSRF token using parent implementation
      return await super.fetchCsrfToken(
        url,
        retryCount,
        retryDelay,
        generation,
      );
    } catch (error) {
      // A 401 here may be an expired token; anything else is not ours to interpret.
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
          return super.fetchCsrfToken(url, retryCount, retryDelay, generation);
        }

        this.logger?.error(
          '[ERROR] JwtAbapConnection.fetchCsrfToken - 401 persists and the token could not be refreshed; the credential may need re-authentication',
        );
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
