/**
 * Example: JWT Connection with Automatic Token Refresh
 * 
 * This example demonstrates how to create a JwtAbapConnection with
 * automatic token refresh using ITokenRefresher from auth-broker.
 * 
 * When 401/403 errors occur, the connection automatically:
 * 1. Calls tokenRefresher.refreshToken() to get a new token
 * 2. Updates internal token state
 * 3. Retries the failed request with the new token
 */

const { JwtAbapConnection } = require('@mcp-abap-adt/connection');
// const { AuthBroker } = require('@mcp-abap-adt/auth-broker');

// Simple logger
const logger = {
  info: (msg, meta) => console.log('[INFO]', msg, meta || ''),
  error: (msg, meta) => console.error('[ERROR]', msg, meta || ''),
  warn: (msg, meta) => console.warn('[WARN]', msg, meta || ''),
  debug: (msg, meta) => console.debug('[DEBUG]', msg, meta || ''),
};

async function main() {
  // Option 1: Using AuthBroker (recommended for production)
  // const broker = new AuthBroker({
  //   sessionStore: mySessionStore,
  //   serviceKeyStore: myServiceKeyStore,
  //   tokenProvider: myTokenProvider,
  // });
  // const tokenRefresher = broker.createTokenRefresher('TRIAL');
  // const initialToken = await tokenRefresher.getToken();

  // Option 2: Manual ITokenRefresher implementation (for testing/custom scenarios)
  const tokenRefresher = {
    getToken: async () => {
      console.log('getToken called - returning cached or refreshed token');
      return process.env.SAP_JWT_TOKEN || 'your-jwt-token';
    },
    refreshToken: async () => {
      console.log('refreshToken called - forcing token refresh');
      // In real implementation: call OAuth2 token endpoint
      // Save new token to session store
      // Return new token
      return 'newly-refreshed-jwt-token';
    },
  };

  // Get initial token
  const initialToken = await tokenRefresher.getToken();

  // JWT configuration
  const config = {
    url: process.env.SAP_URL || 'https://your-instance.abap.cloud.sap',
    authType: 'jwt',
    jwtToken: initialToken,
  };

  // Create connection with token refresher
  // 4th parameter is the ITokenRefresher
  const connection = new JwtAbapConnection(config, logger, undefined, tokenRefresher);

  try {
    // This request will automatically refresh token if 401/403 occurs
    const response = await connection.makeAdtRequest({
      method: 'GET',
      url: '/sap/bc/adt/discovery',
    });

    console.log('Request succeeded:', response.status);
    console.log('Discovery data available');
  } catch (error) {
    console.error('Request failed:', error.message);
  }
}

main().catch(console.error);
