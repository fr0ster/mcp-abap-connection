/**
 * Session Persistence Example
 *
 * Demonstrates using FileSessionStorage to persist and reuse sessions
 */

const { createAbapConnection } = require('@mcp-abap-adt/connection');
const { FileSessionStorage } = require('@mcp-abap-adt/connection');
const path = require('path');

async function main() {
  const config = {
    url: process.env.SAP_URL,
    authType: process.env.SAP_AUTH_TYPE || 'basic',
    username: process.env.SAP_USERNAME,
    password: process.env.SAP_PASSWORD,
    client: process.env.SAP_CLIENT || '100',
  };

  // Create session storage
  const sessionStorage = new FileSessionStorage({
    sessionsDir: path.join(__dirname, '.sessions'),
    enablePersistence: true,
  });

  const sessionId = 'my-persistent-session';

  console.log('Creating connection with session persistence');
  console.log('Session ID:', sessionId);
  console.log('Sessions dir:', sessionStorage.sessionsDir);

  const connection = createAbapConnection(
    config,
    console,
    sessionStorage,
    sessionId
  );

  try {
    // First connection - will fetch CSRF token and save session
    console.log('\n--- First Connection ---');
    await connection.connect();
    console.log('✓ Connected and session saved');

    // Make a request
    const response1 = await connection.request({
      method: 'GET',
      url: '/sap/bc/adt/discovery',
    });
    console.log('✓ Request 1 successful');

    // Simulate disconnection
    console.log('\n--- Simulating Disconnection ---');
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Create new connection with same session ID
    console.log('\n--- Second Connection (Reusing Session) ---');
    const connection2 = createAbapConnection(
      config,
      console,
      sessionStorage,
      sessionId
    );

    await connection2.connect();
    console.log('✓ Session reused (no new CSRF token fetch needed)');

    // Make another request
    const response2 = await connection2.request({
      method: 'GET',
      url: '/sap/bc/adt/discovery',
    });
    console.log('✓ Request 2 successful with reused session');

    console.log('\n✓ Session persistence working correctly');

  } catch (error) {
    console.error('✗ Error:', error.message);
    process.exit(1);
  }
}

main();
