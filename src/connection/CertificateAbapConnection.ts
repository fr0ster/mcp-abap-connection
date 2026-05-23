import type { AgentOptions } from 'node:https';
import type {
  ICertificateMaterial,
  ICertificateMaterialLoader,
} from '@mcp-abap-adt/interfaces';
import { AxiosError } from 'axios';
import { FileCertificateMaterialLoader } from '../auth/FileCertificateMaterialLoader.js';
import type { SapConfig } from '../config/sapConfig.js';
import type { ILogger } from '../logger.js';
import { AbstractAbapConnection } from './AbstractAbapConnection.js';

/** Client-certificate (mTLS) authentication. Credential lives on the TLS agent. */
export class CertificateAbapConnection extends AbstractAbapConnection {
  private loader: ICertificateMaterialLoader;
  private material: ICertificateMaterial | null = null;

  constructor(
    config: SapConfig,
    logger?: ILogger | null,
    sessionId?: string,
    loader?: ICertificateMaterialLoader,
  ) {
    CertificateAbapConnection.validateConfig(config);
    super(config, logger || null, sessionId);
    this.loader = loader ?? new FileCertificateMaterialLoader();
  }

  private static validateConfig(config: SapConfig): void {
    if (config.authType !== 'certificate') {
      throw new Error(
        `Certificate connection expects authType "certificate", got "${config.authType}"`,
      );
    }
    if (config.connectionType === 'rfc') {
      throw new Error(
        'Certificate auth is not supported with connectionType "rfc".',
      );
    }
    const hasPem = !!(config.certPath && config.certKeyPath); // complete PEM pair present
    const hasPfx = !!config.certPfxPath;
    if (!hasPem && !hasPfx) {
      throw new Error(
        'Certificate auth requires certPfxPath OR (certPath AND certKeyPath).',
      );
    }
    if ((config.certPath || config.certKeyPath) && config.certPfxPath) {
      throw new Error(
        'Certificate auth: provide either PEM pair OR PFX, not both.',
      );
    }
  }

  protected async ensureMaterial(): Promise<void> {
    if (!this.material) {
      this.material = await this.loader.load(this.getConfig());
    }
  }

  /**
   * Loads certificate material and primes the session. MUST be called before the first
   * request — the TLS agent is built lazily and needs the client cert present.
   */
  async connect(): Promise<void> {
    await this.ensureMaterial();
    const baseUrl = await this.getBaseUrl();
    const discoveryUrl = `${baseUrl}/sap/bc/adt/discovery`;
    try {
      const token = await this.fetchCsrfToken(discoveryUrl, 3, 1000);
      this.setCsrfToken(token);
    } catch (error) {
      this.logger?.warn(
        `[WARN] CertificateAbapConnection - connect deferred: ${error instanceof Error ? error.message : String(error)}`,
      );

      if (error instanceof AxiosError && error.response?.headers) {
        if (this.getCookies()) {
          this.logger?.debug(
            `[DEBUG] CertificateAbapConnection - Cookies extracted from error response during connect (first 100 chars): ${this.getCookies()?.substring(0, 100)}...`,
          );
        }
      }
    }
  }

  protected getHttpsAgentOptions(): AgentOptions {
    if (!this.material) {
      throw new Error(
        'CertificateAbapConnection: certificate material not loaded. Call connect() before making requests.',
      );
    }
    const { cert, key, pfx, passphrase } = this.material;
    return { cert, key, pfx, passphrase };
  }

  protected buildAuthorizationHeader(): string {
    return '';
  }
}
