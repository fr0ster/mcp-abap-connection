// Import interfaces from shared package
import type {
  ISapConfig,
  ISapHttpConfig,
  ISapRfcConfig,
  SapAuthType,
  SapConnectionType,
} from '@mcp-abap-adt/interfaces-auth-sap';

// Re-export for backward compatibility
export type { SapAuthType, SapConnectionType };
/** A system's configuration: `SapHttpConfig` or `SapRfcConfig`, by `connectionType`. */
export type SapConfig = ISapConfig;
/** An HTTP destination: its URL, no RFC key. */
export type SapHttpConfig = ISapHttpConfig;
/** An RFC destination: its stated address, client and language, no URL. */
export type SapRfcConfig = ISapRfcConfig;

export function sapConfigSignature(config: ISapConfig): string {
  // Include token preview (first 10 and last 10 chars) to detect token changes
  // This allows connection recreation when token is updated via HTTP headers
  const jwtTokenPreview = config.jwtToken
    ? `${config.jwtToken.substring(0, 10)}...${config.jwtToken.substring(Math.max(0, config.jwtToken.length - 10))}`
    : null;
  const refreshTokenPreview = config.refreshToken
    ? `${config.refreshToken.substring(0, 10)}...${config.refreshToken.substring(Math.max(0, config.refreshToken.length - 10))}`
    : null;
  const sessionCookiesPreview = config.sessionCookies
    ? `${config.sessionCookies.substring(0, 10)}...${config.sessionCookies.substring(Math.max(0, config.sessionCookies.length - 10))}`
    : null;

  return JSON.stringify({
    url: config.url,
    client: config.client ?? null,
    authType: config.authType,
    username: config.username ?? null,
    password: config.password ? 'set' : null,
    jwtToken: jwtTokenPreview,
    refreshToken: refreshTokenPreview,
    sessionCookies: sessionCookiesPreview,
    certPath: config.certPath ?? null,
    certKeyPath: config.certKeyPath ?? null,
    certPfxPath: config.certPfxPath ?? null,
    certPassphrase: config.certPassphrase ? 'set' : null,
    kerberosSpn: config.kerberosSpn ?? null,
  });
}
