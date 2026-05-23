import { AxiosError } from 'axios';
import { generateSpnegoToken } from '../auth/kerberosSpnego.js';
import type { SapConfig } from '../config/sapConfig.js';
import type { ILogger } from '../logger.js';
import { AbstractAbapConnection } from './AbstractAbapConnection.js';

/** Kerberos / SPNEGO single-leg auth: send Negotiate token, reuse the resulting SAP session cookie. */
export class KerberosAbapConnection extends AbstractAbapConnection {
  private spn: string;
  private currentToken = '';

  constructor(config: SapConfig, logger?: ILogger | null, sessionId?: string) {
    KerberosAbapConnection.validateConfig(config);
    super(config, logger || null, sessionId);
    this.spn =
      config.kerberosSpn ??
      `${config.kerberosService ?? 'HTTP'}@${new URL(config.url).hostname}`;
  }

  private static validateConfig(config: SapConfig): void {
    if (config.authType !== 'kerberos') {
      throw new Error(
        `Kerberos connection expects authType "kerberos", got "${config.authType}"`,
      );
    }
    if (config.connectionType === 'rfc') {
      throw new Error(
        'Kerberos auth is not supported with connectionType "rfc".',
      );
    }
  }

  /** Generate the SPNEGO token once (single-leg). */
  protected async ensureToken(): Promise<void> {
    if (!this.currentToken)
      this.currentToken = await generateSpnegoToken(this.spn);
  }

  /**
   * Generates the SPNEGO token and primes the session. MUST be called before the first
   * request — the first request carries the Negotiate header; SAP then issues a session
   * cookie which is reused for subsequent requests.
   */
  async connect(): Promise<void> {
    await this.ensureToken();
    const baseUrl = await this.getBaseUrl();
    const discoveryUrl = `${baseUrl}/sap/bc/adt/discovery`;
    this.logger?.debug(
      `[DEBUG] KerberosAbapConnection - Connecting to SAP system: ${discoveryUrl}`,
    );
    try {
      const token = await this.fetchCsrfToken(discoveryUrl, 3, 1000);
      this.setCsrfToken(token);
    } catch (error) {
      this.logger?.warn(
        `[WARN] KerberosAbapConnection - connect deferred: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (
        error instanceof AxiosError &&
        error.response?.headers &&
        this.getCookies()
      ) {
        this.logger?.debug(
          '[DEBUG] KerberosAbapConnection - cookies captured from error response during connect',
        );
      }
    }
  }

  protected buildAuthorizationHeader(): string {
    if (this.getCookies()) return ''; // cookie carries auth after first round-trip
    if (!this.currentToken) {
      throw new Error(
        'KerberosAbapConnection: SPNEGO token not yet available. Call connect() before making requests.',
      );
    }
    return `Negotiate ${this.currentToken}`;
  }
}
