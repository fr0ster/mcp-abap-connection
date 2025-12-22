// Import interfaces from shared package
import type { ISapConfig, SapAuthType } from '@mcp-abap-adt/interfaces';

// Re-export for backward compatibility
export type { SapAuthType };
export type SapConfig = ISapConfig;

export function sapConfigSignature(config: ISapConfig): string {
  // Include token preview (first 10 and last 10 chars) to detect token changes
  // This allows connection recreation when token is updated via HTTP headers
  const jwtTokenPreview = config.jwtToken
    ? `${config.jwtToken.substring(0, 10)}...${config.jwtToken.substring(Math.max(0, config.jwtToken.length - 10))}`
    : null;
  const refreshTokenPreview = config.refreshToken
    ? `${config.refreshToken.substring(0, 10)}...${config.refreshToken.substring(Math.max(0, config.refreshToken.length - 10))}`
    : null;

  return JSON.stringify({
    url: config.url,
    client: config.client ?? null,
    authType: config.authType,
    username: config.username ?? null,
    password: config.password ? 'set' : null,
    jwtToken: jwtTokenPreview,
    refreshToken: refreshTokenPreview,
  });
}
