/**
 * Basic Connection Example
 *
 * Demonstrates simple connection to SAP system and making ADT request
 */

const { createAbapConnection } = require('@mcp-abap-adt/connection');

async function main() {
  // Configuration from environment or hardcoded
  const config = {
    url: process.env.SAP_URL || 'https://your-sap-server.com',
    authType: process.env.SAP_AUTH_TYPE || 'basic',
    username: process.env.SAP_USERNAME,
    password: process.env.SAP_PASSWORD,
    client: process.env.SAP_CLIENT || '100',
  };

  console.log('Creating connection to', config.url);

  // Create connection (factory auto-detects cloud vs on-premise)
  const connection = createAbapConnection(config, console);

  try {
    // Connect and get CSRF token
    console.log('Connecting to SAP system...');
    await connection.connect();
    console.log('✓ Connected successfully');

    // Make a simple ADT request
    console.log('\nFetching repository structure...');
    const response = await connection.request({
      method: 'GET',
      url: '/sap/bc/adt/repository/nodestructure',
      params: {
        parent_name: 'DEVC/K',
        parent_type: 'DEVC/K',
        withShortDescriptions: 'true',
      },
    });

    console.log('✓ Request successful');
    console.log('Response status:', response.status);
    console.log('Data length:', response.data.length);

  } catch (error) {
    console.error('✗ Error:', error.message);
    if (error.response) {
      console.error('  Status:', error.response.status);
      console.error('  Data:', error.response.data);
    }
    process.exit(1);
  }
}

main();
