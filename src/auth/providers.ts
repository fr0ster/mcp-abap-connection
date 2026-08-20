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

  authorizationHeader(): string {
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
  private token: string;

  constructor(
    initialToken: string,
    private readonly refresher?: ITokenRefresher,
  ) {
    this.token = initialToken;
  }

  async prepare(): Promise<void> {
    if (!this.refresher) return;
    // Asked once per establishment rather than per request: a refresher may go
    // to the network, and a connection that did that on every call would spend
    // more time authenticating than working.
    this.token = await this.refresher.getToken();
  }

  authorizationHeader(): string {
    return this.token ? `Bearer ${this.token}` : '';
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

  authorizationHeader(): string {
    return '';
  }

  /** The cookies to present. Read by the connection, not by the contract. */
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

  authorizationHeader(): string {
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
