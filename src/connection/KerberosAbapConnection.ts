import { AxiosError } from 'axios';
import { generateSpnegoToken } from '../auth/kerberosSpnego.js';
import { isNegotiateChallenge, isNtlmChallenge } from '../auth/ntlm.js';
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
  /**
   * Establishes the session for this auth type. Called by
   * AbstractAbapConnection.connect(), which owns the lifecycle around it.
   */
  protected async establishSession(): Promise<void> {
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
      if (error instanceof AxiosError && error.response?.headers) {
        const wwwAuth = error.response.headers['www-authenticate'] as
          | string
          | undefined;
        if (isNtlmChallenge(wwwAuth)) {
          throw new Error(
            'KerberosAbapConnection: server offered NTLM authentication, which is rejected. ' +
              'Only Kerberos/SPNEGO is supported. Ensure the SAP system accepts Kerberos (SPNEGO) for your user.',
          );
        }
        if (this.getCookies()) {
          this.logger?.debug(
            '[DEBUG] KerberosAbapConnection - cookies captured from error response during connect',
          );
        }

        // A Negotiate 401 is not a failure here — it is the handshake.
        //
        // SPNEGO in this class is single-leg: the FIRST request carries the
        // Negotiate header and SAP issues the session cookie in response to it.
        // A 401 on the discovery fetch is therefore the expected first leg, and
        // rejecting on it would make connect() fail on every correctly
        // configured Kerberos system.
        //
        // This is the one place where a resolved connect() does not yet mean a
        // session cookie exists. What it does mean is that the credential is
        // ready: ensureToken() has produced the SPNEGO token, which is what
        // makes the next request able to authenticate. getSessionIdentity()
        // stays null until the cookie arrives — the same state as a server that
        // issues no session cookie at all.
        if (isNegotiateChallenge(wwwAuth)) {
          this.logger?.debug(
            'KerberosAbapConnection - Negotiate 401 during connect: the ' +
              'session cookie arrives with the first request',
          );
          return;
        }
      }
      throw error;
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
