/**
 * A connection whose authentication is passed in.
 *
 * The shared half of the two platform connectors, and the reason the split is
 * possible at all: `establishSession()` was measured to be the same work in
 * every one of the five auth classes — fetch a CSRF token from
 * `/sap/bc/adt/discovery`, keep it, tolerate a failure — with the only
 * per-credential part being a step before it. That step is `prepare()`.
 *
 * So this owns the establishing call, and the credential contributes three
 * things at most: what to prepare, what header to send, and what TLS material
 * to present. Which system this is talking to was stated by the caller when it
 * chose the subclass, and is never worked out here.
 */

import type { AgentOptions } from 'node:https';
import { AxiosError } from 'axios';
import type { IAuthProvider } from '../auth/IAuthProvider.js';
import type { SapConfig } from '../config/sapConfig.js';
import type { ILogger } from '../logger.js';
import { AbstractAbapConnection } from './AbstractAbapConnection.js';

export abstract class CredentialAbapConnection extends AbstractAbapConnection {
  constructor(
    config: SapConfig,
    protected readonly credential: IAuthProvider,
    logger: ILogger | null = null,
    sessionId?: string,
    options?: { skipSessionType?: boolean },
  ) {
    super(config, logger, sessionId, options);
  }

  /**
   * Whatever the credential needs before the first request goes out.
   *
   * Runs before the preflight, not inside the establishing call: building the
   * transport reads the TLS options, and a certificate whose material had not
   * been loaded yet rejected the connect while the argument was still being
   * evaluated — outside every catch, with no request sent.
   */
  protected override async prepareCredential(): Promise<void> {
    await this.credential.prepare?.();
  }

  protected buildAuthorizationHeader(): string {
    return this.credential.authorizationHeader();
  }

  /**
   * The credential's cookies travel with its header.
   *
   * On every path, not only on ordinary requests: a SAML session that is not
   * presented to the session preflight and the establishing call is a session
   * the server never sees us in.
   */
  override async getAuthHeaders(): Promise<Record<string, string>> {
    const headers = await super.getAuthHeaders();
    const cookies = this.credential.cookies?.();
    if (cookies) {
      headers.Cookie = cookies;
    }
    return headers;
  }

  protected override getHttpsAgentOptions(): AgentOptions {
    return (
      this.credential.httpsAgentOptions?.() ?? super.getHttpsAgentOptions()
    );
  }

  /**
   * The establishing call, shared because it always was.
   *
   * Failure is a warning rather than a throw, as it has been: the first request
   * retries it, and a system that answers the discovery call badly may still
   * answer everything else. What decides whether the connection is usable is
   * the session check that follows, not this.
   */
  protected async establishSession(): Promise<void> {
    const baseUrl = await this.getBaseUrl();
    const discoveryUrl = `${baseUrl}/sap/bc/adt/discovery`;

    try {
      const token = this.credential.fetchCsrfToken
        ? await this.credential.fetchCsrfToken(discoveryUrl)
        : await this.fetchCsrfToken(discoveryUrl);
      this.setCsrfToken(token);
      this.logger?.debug('Connected', {
        credential: this.credential.kind,
        hasCsrfToken: !!this.getCsrfToken(),
        hasCookies: !!this.getCookies(),
      });
    } catch (error) {
      this.logger?.warn(
        `Could not establish upfront (${this.credential.kind}): ${error instanceof Error ? error.message : String(error)}. The first request will retry.`,
      );
      // A rejecting response can still carry the cookies that matter; they are
      // taken by fetchCsrfToken itself, so nothing is read out of the error
      // here beyond saying whether any arrived.
      if (error instanceof AxiosError && error.response?.headers) {
        this.logger?.debug(
          `Cookies after a failed establishment: ${this.getCookies() ? 'present' : 'none'}`,
        );
      }
    }
  }
}
