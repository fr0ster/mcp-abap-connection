import { AxiosError } from 'axios';
import { generateSpnegoToken } from '../auth/kerberosSpnego.js';
import {
  isBareNegotiateChallenge,
  isNegotiateContinuation,
  isNtlmChallenge,
} from '../auth/ntlm.js';
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
      // ONE attempt, deliberately — the shared default is 3 retries a second
      // apart, and every one of them corrupts this exchange:
      //
      //  - A GSS token is one-shot. Replaying it is meaningless at best, and
      //    replay protection may answer it differently than the original.
      //  - Worse, a 401 that sets a cookie silences buildAuthorizationHeader()
      //    (a cookie carries auth after the first round trip), so the retry
      //    goes out with NO Authorization at all and draws the server's plain
      //    opening challenge.
      //
      // Either way the classifier below would read the LAST response and name
      // the wrong cause. The retry cannot help here anyway: nothing about a
      // rejected token changes by waiting a second. Retrying a transient
      // network failure is the caller's business now that connect() is
      // explicit, and a fresh connect() mints a fresh token.
      const token = await this.fetchCsrfToken(discoveryUrl, 0, 0);
      this.setCsrfToken(token);
    } catch (error) {
      // The token went out and was not accepted, so it is spent. Keeping it
      // would make every later connect() replay a token already known to fail.
      this.currentToken = '';

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

        // A 401 carrying a Negotiate token is a CONTINUATION, not a success.
        //
        // Per RFC 4559 the server is handing back gssapi-data for the client to
        // feed into its GSS context and retry. This client cannot do that:
        // generateSpnegoToken() calls step('') once and discards the context,
        // so there is nothing to continue with. The token it holds is the
        // initial one, and sending it again produces the same 401.
        //
        // So this fails, and says why — resolving here would claim a readiness
        // that does not exist and move the failure to the first real request,
        // where it reads as an unrelated auth error.
        if (isNegotiateContinuation(wwwAuth)) {
          throw new Error(
            'KerberosAbapConnection: the server continued the SPNEGO exchange ' +
              '(401 with a Negotiate token), which requires feeding that token ' +
              'back into the GSS context and retrying. This client performs a ' +
              'single-leg exchange only — the context is discarded after the ' +
              'first step — so multi-leg SPNEGO is not supported. See ' +
              'https://www.rfc-editor.org/rfc/rfc4559',
          );
        }

        // A BARE Negotiate is a different problem with a different fix: the
        // initial Authorization has already gone out, so an empty challenge is
        // the server declining it. No token came back, so there is nothing to
        // step even for a client that supports multi-leg.
        if (isBareNegotiateChallenge(wwwAuth)) {
          throw new Error(
            'KerberosAbapConnection: the server rejected the SPNEGO token ' +
              '(401 with a bare Negotiate challenge, no token returned). The ' +
              'credentials were not accepted — check the SPN, the ticket ' +
              '(klist / kinit), and that the user is permitted Kerberos logon.',
          );
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
