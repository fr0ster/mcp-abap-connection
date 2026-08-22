/**
 * SAML Connection Example
 *
 * Demonstrates using cookie-based SAML authentication.
 * Session cookies are expected from prior login flow.
 */

const {
  AdtOnPremConnector,
  SamlAuthProvider,
} = require('@mcp-abap-adt/connection');

async function main() {
  const config = {
    url: process.env.SAP_URL || 'https://your-sap-server.com',
    authType: 'saml',
    sessionCookies: process.env.SAP_SESSION_COOKIES,
    client: process.env.SAP_CLIENT || '100',
  };

  if (!config.sessionCookies) {
    throw new Error(
      'SAP_SESSION_COOKIES is required for SAML example (full Cookie header value)',
    );
  }

  console.log('Creating SAML connection to', config.url);
  // The cookies ARE the credential — there is no Authorization header at all.
  const connection = new AdtOnPremConnector(
    config,
    new SamlAuthProvider(config.sessionCookies),
    console,
  );

  try {
    console.log('Connecting using session cookies...');
    await connection.connect();
    console.log('✓ Connected successfully');

    const response = await connection.makeAdtRequest({
      method: 'GET',
      url: '/sap/bc/adt/discovery',
    });

    console.log('✓ Request successful');
    console.log('Response status:', response.status);
  } catch (error) {
    console.error('✗ Error:', error.message || String(error));
    if (error.response) {
      console.error('  Status:', error.response.status);
      console.error('  Data:', error.response.data);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal:', error.message || String(error));
  process.exit(1);
});
