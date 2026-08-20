/**
 * The credentials a connector can be handed.
 *
 * Each is the authentication half of one of the connection classes that used to
 * carry both halves, lifted out unchanged — the header a `BasicAuthProvider`
 * builds is byte for byte what `BaseAbapConnection` built, and the TLS options a
 * `CertificateAuthProvider` returns are what `CertificateAbapConnection`
 * returned. Nothing about how a credential works changed; only who owns it.
 */

import type { AgentOptions } from 'node:https';
import type {
  ICertificateMaterial,
  ICertificateMaterialLoader,
  ISapConfig,
  ITokenRefresher,
} from '@mcp-abap-adt/interfaces';
import type { IAuthProvider } from './IAuthProvider.js';

/** Username and password, as `Basic base64(user:pass)`. */
export class BasicAuthProvider implements IAuthProvider {
  readonly kind = 'basic';

  constructor(
    private readonly username: string,
    private readonly password: string,
  ) {}

  async authorizationHeader(): Promise<string> {
    return `Basic ${Buffer.from(`${this.username ?? ''}:${this.password ?? ''}`).toString('base64')}`;
  }
}

/**
 * A bearer token, kept current by whoever issued it.
 *
 * Takes an `ITokenRefresher` — the contract `@mcp-abap-adt/auth-broker` already
 * produces and `@mcp-abap-adt/auth-providers` already implements twelve ways.
 * This package depends on neither: it speaks the contract, and the consumer
 * brings the implementation, exactly as it does for `IAbapConnection`.
 *
 * **This carries no session recovery.** What happens to a session when the
 * credential behind it is renewed mid-flight is the connection's business and
 * stays there; see `JwtAbapConnection`, which still owns that machinery.
 */
export class TokenAuthProvider implements IAuthProvider {
  readonly kind = 'token';

  /**
   * A token, or something that can produce one.
   *
   * A bare string is a token with no renewal behind it — honest, and fine for a
   * short task. An `ITokenRefresher` or a function is a provider that checks
   * expiry and renews on its own, which is where this belongs in a long-lived
   * process.
   */
  constructor(
    private readonly source: string | ITokenRefresher | (() => Promise<string>),
  ) {}

  /**
   * Asked every time, and nothing kept.
   *
   * The provider behind this already caches the token, knows when it expires,
   * and renews before handing one back. A second cache here would serve the
   * stale one and hide exactly the renewal the provider exists to do — which
   * is what the first version of this class did.
   */
  async authorizationHeader(): Promise<string> {
    const token =
      typeof this.source === 'string'
        ? this.source
        : typeof this.source === 'function'
          ? await this.source()
          : await this.source.getToken();
    return token ? `Bearer ${token}` : '';
  }

  /**
   * The token was refused, so force a new one.
   *
   * `getToken()` is documented to return the cached token while it believes it
   * is still valid — which is exactly the situation after a 401 on a token the
   * provider has not yet noticed is dead. `refreshToken()` is the contract's
   * answer for that, and this is the only place it is called.
   */
  async renew(): Promise<void> {
    if (typeof this.source === 'string' || typeof this.source === 'function') {
      // Nothing to force: a fixed token has no source, and a function is asked
      // afresh every time anyway.
      return;
    }
    await this.source.refreshToken();
  }
}

/**
 * A SAML session, already negotiated, presented as cookies.
 *
 * No `Authorization` header at all — the cookies are the credential, and they
 * are added by the connection alongside its own.
 */
export class SamlAuthProvider implements IAuthProvider {
  readonly kind = 'saml';

  constructor(private readonly sessionCookies: string) {}

  async authorizationHeader(): Promise<string> {
    return '';
  }

  /** The cookies to present. */
  cookies(): string {
    return this.sessionCookies;
  }
}

/**
 * Client certificate: the credential lives in the TLS handshake.
 *
 * `prepare()` is where the material is read, which is why it exists at all —
 * building an agent before it is loaded is what used to reject a connect
 * before a single request went out.
 */
export class CertificateAuthProvider implements IAuthProvider {
  readonly kind = 'certificate';
  private material: ICertificateMaterial | null = null;

  constructor(
    private readonly loader: ICertificateMaterialLoader,
    private readonly config: ISapConfig,
  ) {}

  async prepare(): Promise<void> {
    if (!this.material) {
      this.material = await this.loader.load(this.config);
    }
  }

  async authorizationHeader(): Promise<string> {
    return '';
  }

  httpsAgentOptions(): AgentOptions {
    if (!this.material) {
      throw new Error(
        'CertificateAuthProvider: certificate material not loaded. connect() prepares it; a request before that has nothing to present.',
      );
    }
    const { cert, key, pfx, passphrase } = this.material;
    return { cert, key, pfx, passphrase };
  }
}
