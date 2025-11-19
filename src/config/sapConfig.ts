import * as path from 'path';
import * as fs from 'fs';

export type SapAuthType = "basic" | "jwt";

export interface SapConfig {
  url: string;
  client?: string;
  authType: SapAuthType;
  username?: string;
  password?: string;
  jwtToken?: string;
  refreshToken?: string;
  uaaUrl?: string; // UAA URL for token refresh (optional, can be extracted from service key)
  uaaClientId?: string; // UAA client ID for token refresh (optional)
  uaaClientSecret?: string; // UAA client secret for token refresh (optional)
}

/**
 * Produces a stable string signature for a SAP configuration.
 * Used internally for caching connection instances when configuration changes.
 */
/**
 * Load .env file if dotenv is available and file exists
 * @param envPath - Path to .env file (default: .env in current working directory or project root)
 * @returns true if .env was loaded, false otherwise
 */
export function loadEnvFile(envPath?: string): boolean {
  // Determine .env file path
  let resolvedPath: string;
  if (envPath) {
    resolvedPath = path.resolve(envPath);
  } else {
    // Try current directory first
    const currentDirEnv = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(currentDirEnv)) {
      resolvedPath = currentDirEnv;
    } else {
      // Try project root (go up from node_modules or dist)
      const projectRoot = path.resolve(__dirname, '../../..');
      resolvedPath = path.resolve(projectRoot, '.env');
    }
  }

  if (!fs.existsSync(resolvedPath)) {
    return false;
  }

  // Try to use dotenv if available
  try {
    const dotenv = require('dotenv');
    const result = dotenv.config({ path: resolvedPath, override: false });
    if (!result.error) {
      return true;
    }
  } catch (error) {
    // dotenv not available - fallback to manual parsing
  }

  // Manual fallback parser (supports KEY=VALUE, ignores comments)
  try {
    const content = fs.readFileSync(resolvedPath, 'utf8');
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) {
        continue;
      }
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Get SAP configuration from environment variables
 * Used by tests and applications to create connection config
 *
 * Automatically detects auth type:
 * - If SAP_JWT_TOKEN is present → uses 'jwt'
 * - If SAP_AUTH_TYPE is set → uses that value
 * - Otherwise → uses 'basic'
 */
export function getConfigFromEnv(): SapConfig {
  const rawUrl = process.env.SAP_URL;
  const url = rawUrl ? rawUrl.split('#')[0].trim() : rawUrl;
  const rawClient = process.env.SAP_CLIENT;
  const client = rawClient ? rawClient.split('#')[0].trim() : rawClient;

  // Auto-detect auth type: if JWT token is present, use JWT; otherwise check SAP_AUTH_TYPE or default to basic
  // Priority: SAP_JWT_TOKEN presence > SAP_AUTH_TYPE > default to basic
  let rawAuthType = process.env.SAP_AUTH_TYPE;
  if (process.env.SAP_JWT_TOKEN) {
    rawAuthType = 'jwt'; // Auto-detect JWT if token is present (overrides SAP_AUTH_TYPE)
  }
  rawAuthType = rawAuthType || 'basic';
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
    // Refresh token is optional but recommended for automatic token renewal
    const refreshToken = process.env.SAP_REFRESH_TOKEN;
    if (refreshToken) {
      config.refreshToken = refreshToken;
    }
    // UAA credentials for token refresh (optional but recommended)
    const uaaUrl = process.env.SAP_UAA_URL || process.env.UAA_URL;
    const uaaClientId = process.env.SAP_UAA_CLIENT_ID || process.env.UAA_CLIENT_ID;
    const uaaClientSecret = process.env.SAP_UAA_CLIENT_SECRET || process.env.UAA_CLIENT_SECRET;
    if (uaaUrl) config.uaaUrl = uaaUrl;
    if (uaaClientId) config.uaaClientId = uaaClientId;
    if (uaaClientSecret) config.uaaClientSecret = uaaClientSecret;
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

/**
 * Load .env file and get SAP configuration from environment variables
 * Convenience function that combines loadEnvFile() and getConfigFromEnv()
 *
 * @param envPath - Optional path to .env file (default: auto-detect)
 * @returns SAP configuration
 */
export function loadConfigFromEnvFile(envPath?: string): SapConfig {
  loadEnvFile(envPath);
  return getConfigFromEnv();
}

export function sapConfigSignature(config: SapConfig): string {
  return JSON.stringify({
    url: config.url,
    client: config.client ?? null,
    authType: config.authType,
    username: config.username ?? null,
    password: config.password ? "set" : null,
    jwtToken: config.jwtToken ? "set" : null,
    refreshToken: config.refreshToken ? "set" : null
  });
}

