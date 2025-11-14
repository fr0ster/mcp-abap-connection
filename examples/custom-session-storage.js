/**
 * Example: Custom Session Storage
 *
 * This example demonstrates how to use getSessionState() and setSessionState()
 * to store session data in your own storage (database, Redis, etc.) instead of
 * using the built-in FileSessionStorage.
 *
 * Run: node examples/custom-session-storage.js
 */

const { createAbapConnection } = require('@mcp-abap-adt/connection');

async function main() {
  // Configuration
  const config = {
    url: process.env.SAP_URL || 'https://your-sap-system.com',
    authType: 'basic',
    username: process.env.SAP_USERNAME || 'YOUR_USERNAME',
    password: process.env.SAP_PASSWORD || 'YOUR_PASSWORD',
  };

  const logger = {
    debug: () => {},
    info: console.log,
    warn: console.warn,
    error: console.error,
  };

  console.log('Example: Custom Session Storage\n');
  console.log('='.repeat(50));

  // ===================================================================
  // Step 1: Make a request and capture session state
  // ===================================================================

  console.log('\n📡 Step 1: Making initial request...\n');

  const connection1 = createAbapConnection(config, logger);

  try {
    // Make any ADT request (this will create session with cookies/CSRF token)
    await connection1.makeAdtRequest({
      url: '/sap/bc/adt/discovery',
      method: 'GET',
      timeout: 10000,
    });

    console.log('✓ Request successful\n');

    // Get session state - this is plain JSON that you can store anywhere
    const sessionState = connection1.getSessionState();

    if (sessionState) {
      console.log('📦 Session state captured:');
      console.log(JSON.stringify(sessionState, null, 2));
      console.log('\n💡 You can now save this JSON to:');
      console.log('   - Database (MongoDB, PostgreSQL, etc.)');
      console.log('   - Redis/Memcached');
      console.log('   - File system');
      console.log('   - Environment variables');
      console.log('   - Any other storage\n');

      // ===================================================================
      // Step 2: Store in your custom storage
      // ===================================================================

      // Example: In-memory storage (you would use your own storage here)
      const myCustomStorage = {
        sessionId: 'my-custom-session-001',
        savedAt: new Date().toISOString(),
        sessionState: sessionState,
      };

      console.log('💾 Saved to custom storage (in-memory for this example)\n');

      // ===================================================================
      // Step 3: Later, create new connection and restore session
      // ===================================================================

      console.log('🔄 Step 2: Simulating app restart...\n');
      console.log('Creating new connection and restoring session from custom storage\n');

      // Create a fresh connection (simulates restart)
      const connection2 = createAbapConnection(config, logger);

      // Restore session from your custom storage
      connection2.setSessionState(myCustomStorage.sessionState);

      console.log('✓ Session restored from custom storage');
      console.log(`   Session ID: ${myCustomStorage.sessionId}`);
      console.log(`   Saved at: ${myCustomStorage.savedAt}\n`);

      // Now make another request - it will use the restored cookies/CSRF token
      await connection2.makeAdtRequest({
        url: '/sap/bc/adt/discovery',
        method: 'GET',
        timeout: 10000,
      });

      console.log('✓ Request with restored session successful\n');
      console.log('🎉 Custom session storage works!\n');

    } else {
      console.log('⚠️  No session state available (no cookies/CSRF token yet)\n');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  // Load .env file if available (optional)
  try {
    require('dotenv').config({ path: '../adt-clients/.env' });
  } catch (e) {
    // dotenv not available or .env not found - that's ok
  }

  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { main };
