import { AxiosError } from 'axios';
import type { SapConfig } from '../config/sapConfig.js';
import type { ILogger } from '../logger.js';
import { AbstractAbapConnection } from './AbstractAbapConnection.js';
import type { IAdtTransport } from './IAdtTransport.js';

/**
 * @deprecated The class you take should say which SYSTEM you are dialling,
 * not which credential you hold — a session mechanism that rides along with
 * the credential gets one of them wrong. Use `AdtOnPremConnector` with `BasicAuthProvider`:
 *
 *   new AdtOnPremConnector(config, new BasicAuthProvider(user, pass), logger)
 *
 * Kept working, and not removed here: existing consumers are unaffected.
 */
export class BaseAbapConnection extends AbstractAbapConnection {
  constructor(
    config: SapConfig,
    logger?: ILogger | null,
    sessionId?: string,
    options?: { skipSessionType?: boolean; transport?: IAdtTransport },
  ) {
    BaseAbapConnection.validateConfig(config);
    super(config, logger || null, sessionId, options);
  }

  /**
   * Connect to SAP system with Basic Auth
   * Fetches CSRF token which also establishes session cookies
   */
  /**
   * Establishes the session for this auth type. Called by
   * AbstractAbapConnection.connect(), which owns the lifecycle around it.
   */
  protected async establishSession(): Promise<void> {
    const baseUrl = await this.getBaseUrl();
    const discoveryUrl = `${baseUrl}/sap/bc/adt/discovery`;

    this.logger?.debug(
      `[DEBUG] BaseAbapConnection - Connecting to SAP system: ${discoveryUrl}`,
    );

    try {
      // Try to get CSRF token (this will also get cookies)
      const token = await this.fetchCsrfToken(discoveryUrl);
      this.setCsrfToken(token);

      this.logger?.debug('Successfully connected to SAP system', {
        hasCsrfToken: !!this.getCsrfToken(),
        hasCookies: !!this.getCookies(),
        cookieLength: this.getCookies()?.length || 0,
      });
    } catch (error) {
      // For Basic auth, log warning but don't fail
      // The retry logic in makeAdtRequest will handle transient errors automatically
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger?.warn(
        `[WARN] BaseAbapConnection - Could not connect to SAP system upfront: ${errorMsg}. Will retry on first request.`,
      );

      // Still try to extract cookies from error response if available
      if (error instanceof AxiosError && error.response?.headers) {
        // updateCookiesFromResponse is private, but cookies are extracted in fetchCsrfToken
        if (this.getCookies()) {
          this.logger?.debug(
            `[DEBUG] BaseAbapConnection - Cookies extracted from error response during connect (first 100 chars): ${this.getCookies()?.substring(0, 100)}...`,
          );
        }
      }

      // Rethrow: a resolved connect() must mean a usable session exists. This
      // used to swallow and resolve anyway, deferring establishment to the
      // first request — coherent only while that lazy path existed. Without it,
      // swallowing would leave a connection that reports success, holds
      // nothing, and refuses every request.
      throw error;
    }
  }

  protected buildAuthorizationHeader(): string {
    const { username, password } = this.getConfig();
    const safeUsername = username ?? '';
    const safePassword = password ?? '';
    const token = Buffer.from(`${safeUsername}:${safePassword}`).toString(
      'base64',
    );
    return `Basic ${token}`;
  }

  private static validateConfig(config: SapConfig): void {
    if (config.authType !== 'basic') {
      throw new Error(
        `Basic authentication connection expects authType "basic", got "${config.authType}"`,
      );
    }

    if (!config.username || !config.password) {
      throw new Error(
        'Basic authentication requires both username and password',
      );
    }

    if (!config.client) {
      throw new Error(
        'Basic authentication requires SAP_CLIENT to be provided',
      );
    }
  }
}
