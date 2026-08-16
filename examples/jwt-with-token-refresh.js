/**
 * Example: JWT Connection with Automatic Token Refresh
 *
 * This example demonstrates how to create a JwtAbapConnection with
 * automatic token refresh using ITokenRefresher from auth-broker.
 *
 * When a **401** occurs, the connection automatically:
 * 1. Calls tokenRefresher.refreshToken() to get a new token
 * 2. Updates internal token state
 * 3. Re-establishes the SAP session, which the new credential cannot inherit
 * 4. Retries the failed request
 *
 * A **403** is left alone. It means the server authenticated you and refused
 * the action anyway — an authorization gap, not an expired credential — so it
 * propagates with its status and the server's message, and a new token would
 * change nothing.
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
  const connection = new JwtAbapConnection(
    config,
    logger,
    undefined,
    tokenRefresher,
  );

  try {
    await connection.connect();

    // This request will automatically refresh the token if a 401 occurs. A
    // 403 arrives as-is — read err.response.status and err.response.data to
    // see which authorization object the server named. Note
    // that a refresh replaces the SAP session: with a lock window open the
    // request would fail with ADT_SESSION_REPLACED rather than continue on a
    // session your lock is not in.
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
