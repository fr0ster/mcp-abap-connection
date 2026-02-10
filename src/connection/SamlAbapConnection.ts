import { AxiosError } from 'axios';
import type { SapConfig } from '../config/sapConfig.js';
import type { ILogger } from '../logger.js';
import { AbstractAbapConnection } from './AbstractAbapConnection.js';

/**
 * SAML session cookie authentication for SAP systems
 */
export class SamlAbapConnection extends AbstractAbapConnection {
  private sessionCookies: string;

  constructor(config: SapConfig, logger?: ILogger | null, sessionId?: string) {
    SamlAbapConnection.validateConfig(config);
    super(config, logger || null, sessionId);
    this.sessionCookies = config.sessionCookies || '';
    if (this.sessionCookies) {
      this.setInitialCookies(this.sessionCookies);
    }
  }

  /**
   * Connect to SAP system using existing session cookies
   * Fetches CSRF token to establish session context
   */
  async connect(): Promise<void> {
    const baseUrl = await this.getBaseUrl();
    const discoveryUrl = `${baseUrl}/sap/bc/adt/discovery`;

    this.logger?.debug(
      `[DEBUG] SamlAbapConnection - Connecting to SAP system: ${discoveryUrl}`,
    );

    try {
      const token = await this.fetchCsrfToken(discoveryUrl, 3, 1000);
      this.setCsrfToken(token);

      this.logger?.debug('Successfully connected to SAP system', {
        hasCsrfToken: !!this.getCsrfToken(),
        hasCookies: !!this.getCookies(),
        cookieLength: this.getCookies()?.length || 0,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger?.warn(
        `[WARN] SamlAbapConnection - Could not connect to SAP system upfront: ${errorMsg}. Will retry on first request.`,
      );

      if (error instanceof AxiosError && error.response?.headers) {
        if (this.getCookies()) {
          this.logger?.debug(
            `[DEBUG] SamlAbapConnection - Cookies extracted from error response during connect (first 100 chars): ${this.getCookies()?.substring(0, 100)}...`,
          );
        }
      }
    }
  }

  protected buildAuthorizationHeader(): string {
    return '';
  }

  async getAuthHeaders(): Promise<Record<string, string>> {
    const headers = await super.getAuthHeaders();
    if (this.sessionCookies) {
      headers.Cookie = this.sessionCookies;
    }
    return headers;
  }

  private static validateConfig(config: SapConfig): void {
    if (config.authType !== 'saml') {
      throw new Error(
        `SAML connection expects authType "saml", got "${config.authType}"`,
      );
    }

    if (!config.sessionCookies) {
      throw new Error('SAML authentication requires sessionCookies');
    }
  }
}
