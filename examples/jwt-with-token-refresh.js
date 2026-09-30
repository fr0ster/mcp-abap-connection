/**
 * Example: JWT Connection with Automatic Token Refresh
 *
 * This example demonstrates how to create a cloud connection with
 * automatic token refresh using ITokenRefresher from auth-broker.
 *
 * When a **401** survives the wire's own session recovery, the connection
 * puts it to the provider (`rejected`). `TokenAuthProvider.from` then:
 * 1. Calls tokenRefresher.refreshToken() to get a new token
 * 2. Answers Ok, so the connection authorizes the request again
 * 3. The request is sent exactly once more; a second refusal is an
 *    AuthRefusedError carrying the provider's words
 *
 * A **403** is left alone. It means the server authenticated you and refused
 * the action anyway — an authorization gap, not an expired credential — so it
 * propagates with its status and the server's message, and a new token would
 * change nothing.
 */

const {
  CloudHttpTransport,
  AdtCloudConnector,
} = require('@mcp-abap-adt/connection');
const { TokenAuthProvider } = require('@mcp-abap-adt/auth-providers');
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

  // The refresher IS the credential: the provider asks it for a token before
  // every attempt and renews when the system refuses one. `.fixed(token)` would
  // be a token with nothing behind it.
  const connection = new AdtCloudConnector(
    config,
    TokenAuthProvider.from(tokenRefresher),
    new CloudHttpTransport(() => ({}), console, {
      client: config.client,
      baseUrl: config.url,
    }),
    logger,
  );

  try {
    await connection.connect();

    // If a 401 survives the session recovery, the provider is asked once and
    // the request is retried once. A 403 arrives as-is — read
    // err.response.status and err.response.data to see which authorization
    // object the server named.
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
