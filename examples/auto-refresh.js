/**
 * JWT Auto-Refresh Example
 *
 * Demonstrates automatic JWT token refresh when token expires
 */

const { CloudAbapConnection } = require('@mcp-abap-adt/connection');

async function main() {
  // JWT configuration with refresh credentials
  const config = {
    url: process.env.SAP_URL,
    authType: 'jwt',
    client: process.env.SAP_CLIENT || '100',

    // Initial JWT token (may be expired)
    jwtToken: process.env.SAP_JWT_TOKEN,

    // Auto-refresh credentials
    refreshToken: process.env.SAP_REFRESH_TOKEN,
    uaaUrl: process.env.SAP_UAA_URL,
    uaaClientId: process.env.SAP_UAA_CLIENT_ID,
    uaaClientSecret: process.env.SAP_UAA_CLIENT_SECRET,
  };

  console.log('Creating cloud connection with auto-refresh enabled');
  console.log('Can refresh token:', !!(
    config.refreshToken &&
    config.uaaUrl &&
    config.uaaClientId &&
    config.uaaClientSecret
  ));

  const connection = new CloudAbapConnection(config, console);

  try {
    // This will auto-refresh if JWT is expired
    console.log('\nConnecting to SAP cloud system...');
    await connection.connect();
    console.log('✓ Connected (token refreshed if needed)');

    // Make multiple requests - will auto-refresh on 401/403
    for (let i = 1; i <= 3; i++) {
      console.log(`\nRequest ${i}...`);

      const response = await connection.request({
        method: 'GET',
        url: '/sap/bc/adt/discovery',
      });

      console.log(`✓ Request ${i} successful (status: ${response.status})`);

      // Simulate delay between requests
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    console.log('\n✓ All requests completed successfully');

  } catch (error) {
    console.error('\n✗ Error:', error.message);

    if (error.message.includes('refresh failed')) {
      console.error('\nRefresh token is invalid or expired.');
      console.error('Please re-authenticate to get new tokens.');
    }

    process.exit(1);
  }
}

// Check required environment variables
const required = [
  'SAP_URL',
  'SAP_JWT_TOKEN',
  'SAP_REFRESH_TOKEN',
  'SAP_UAA_URL',
  'SAP_UAA_CLIENT_ID',
  'SAP_UAA_CLIENT_SECRET',
];

const missing = required.filter(key => !process.env[key]);

if (missing.length > 0) {
  console.error('Missing required environment variables:');
  missing.forEach(key => console.error(`  - ${key}`));
  console.error('\nSet them in .env file or export them:');
  console.error('  export SAP_URL=https://...');
  process.exit(1);
}

main();
