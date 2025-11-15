export type SapAuthType = "basic" | "jwt";

export interface SapConfig {
  url: string;
  client?: string;
  authType: SapAuthType;
  username?: string;
  password?: string;
  jwtToken?: string;
}

/**
 * Produces a stable string signature for a SAP configuration.
 * Used internally for caching connection instances when configuration changes.
 */
/**
 * Get SAP configuration from environment variables
 * Used by tests and applications to create connection config
 */
export function getConfigFromEnv(): SapConfig {
  const rawUrl = process.env.SAP_URL;
  const url = rawUrl ? rawUrl.split('#')[0].trim() : rawUrl;
  const rawClient = process.env.SAP_CLIENT;
  const client = rawClient ? rawClient.split('#')[0].trim() : rawClient;
  const rawAuthType = process.env.SAP_AUTH_TYPE || 'basic';
  const authType = rawAuthType.split('#')[0].trim();

  if (!url || !/^https?:\/\//.test(url)) {
    throw new Error(`Missing or invalid SAP_URL: ${url}`);
  }

  const config: SapConfig = {
    url,
    authType: authType === 'xsuaa' ? 'jwt' : (authType as SapAuthType),
  };

  if (client) {
    config.client = client;
  }

  if (authType === 'jwt' || authType === 'xsuaa') {
    const jwtToken = process.env.SAP_JWT_TOKEN;
    if (!jwtToken) {
      throw new Error('Missing SAP_JWT_TOKEN for JWT authentication');
    }
    config.jwtToken = jwtToken;
  } else {
    const username = process.env.SAP_USERNAME;
    const password = process.env.SAP_PASSWORD;
    if (!username || !password) {
      throw new Error('Missing SAP_USERNAME or SAP_PASSWORD for basic authentication');
    }
    config.username = username;
    config.password = password;
  }

  return config;
}

export function sapConfigSignature(config: SapConfig): string {
  return JSON.stringify({
    url: config.url,
    client: config.client ?? null,
    authType: config.authType,
    username: config.username ?? null,
    password: config.password ? "set" : null,
    jwtToken: config.jwtToken ? "set" : null
  });
}

