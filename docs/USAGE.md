# Usage Guide

## Quick Start

### Basic Usage with Factory

```typescript
import { createAbapConnection } from '@mcp-abap-adt/connection';
import { SapConfig } from '@mcp-abap-adt/connection';

const config: SapConfig = {
  url: 'https://your-sap-server.com',
  authType: 'basic',
  username: 'your-username',
  password: 'your-password',
  client: '100',
};

// Create connection (auto-detects on-premise vs cloud)
const connection = createAbapConnection(config);

// Connect to SAP (gets CSRF token and cookies)
await connection.connect();

// Make ADT requests
const response = await connection.request({
  method: 'GET',
  url: '/sap/bc/adt/repository/nodestructure',
});

console.log(response.data);
```

## Authentication Types

### Basic Authentication (On-Premise)

```typescript
import { OnPremAbapConnection } from '@mcp-abap-adt/connection';

const config = {
  url: 'https://sap-server.local:8000',
  authType: 'basic' as const,
  username: 'developer',
  password: 'SecurePass123',
  client: '100',
};

const connection = new OnPremAbapConnection(config, console);
await connection.connect();
```

### JWT Authentication (Cloud/BTP)

```typescript
import { CloudAbapConnection } from '@mcp-abap-adt/connection';

const config = {
  url: 'https://tenant.abap.cloud',
  authType: 'jwt' as const,
  jwtToken: 'eyJhbGciOiJSUzI1NiIs...',
  client: '100',
};

const connection = new CloudAbapConnection(config, console);
await connection.connect();
```

### JWT with Auto-Refresh

```typescript
const config = {
  url: 'https://tenant.abap.cloud',
  authType: 'jwt' as const,
  jwtToken: 'eyJhbGciOiJSUzI1NiIs...',
  client: '100',
  
  // Auto-refresh configuration
  refreshToken: 'your-refresh-token',
  uaaUrl: 'https://tenant.authentication.cloud',
  uaaClientId: 'sb-client-id!b123',
  uaaClientSecret: 'client-secret-xyz',
};

const connection = new CloudAbapConnection(config, console);

// Token will auto-refresh on 401/403 errors
await connection.connect();
```

## Making ADT Requests

### GET Request

```typescript
const packages = await connection.request({
  method: 'GET',
  url: '/sap/bc/adt/repository/nodestructure',
  params: {
    parent_name: 'DEVC/K',
    parent_type: 'DEVC/K',
    withShortDescriptions: 'true',
  },
});
```

### POST Request (Create Object)

```typescript
const classXml = `<?xml version="1.0" encoding="UTF-8"?>
<class:abapClass xmlns:class="http://www.sap.com/adt/oo/classes" 
                 class:name="ZCL_MY_CLASS">
  <class:description>My Test Class</class:description>
</class:abapClass>`;

const response = await connection.request({
  method: 'POST',
  url: '/sap/bc/adt/oo/classes',
  headers: { 'Content-Type': 'application/xml' },
  data: classXml,
  params: { package: 'ZTEST' },
});
```

### PUT Request (Update Object)

```typescript
await connection.request({
  method: 'PUT',
  url: '/sap/bc/adt/oo/classes/zcl_my_class/source/main',
  headers: { 'Content-Type': 'text/plain' },
  data: classSourceCode,
  params: { lockHandle: lockToken },
});
```

### DELETE Request

```typescript
await connection.request({
  method: 'DELETE',
  url: '/sap/bc/adt/oo/classes/zcl_my_class',
  params: { deleteOption: 'deleteAndLocalVersions' },
});
```

## Session Management

### Using Session Storage

```typescript
import { FileSessionStorage } from '@mcp-abap-adt/connection';

const sessionStorage = new FileSessionStorage({
  sessionsDir: './.sessions',
  enablePersistence: true,
});

const connection = createAbapConnection(
  config,
  console,
  sessionStorage,
  'my-session-id'
);

// Connection will reuse existing session if available
await connection.connect();
```

### Custom Session Storage

```typescript
import { ISessionStorage } from '@mcp-abap-adt/connection';

class RedisSessionStorage implements ISessionStorage {
  async saveSession(sessionId: string, data: any): Promise<void> {
    await redis.set(`session:${sessionId}`, JSON.stringify(data));
  }
  
  async loadSession(sessionId: string): Promise<any> {
    const data = await redis.get(`session:${sessionId}`);
    return data ? JSON.parse(data) : null;
  }
  
  async deleteSession(sessionId: string): Promise<void> {
    await redis.del(`session:${sessionId}`);
  }
}

const storage = new RedisSessionStorage();
const connection = createAbapConnection(config, console, storage, 'user-123');
```

## Custom Logging

### Using Custom Logger

```typescript
import { ILogger } from '@mcp-abap-adt/connection';

class CustomLogger implements ILogger {
  info(message: string, context?: any) {
    console.log(`[INFO] ${message}`, context);
  }
  
  warn(message: string, context?: any) {
    console.warn(`[WARN] ${message}`, context);
  }
  
  error(message: string, context?: any) {
    console.error(`[ERROR] ${message}`, context);
  }
  
  debug(message: string, context?: any) {
    if (process.env.DEBUG) {
      console.debug(`[DEBUG] ${message}`, context);
    }
  }
}

const logger = new CustomLogger();
const connection = createAbapConnection(config, logger);
```

## Error Handling

### Basic Error Handling

```typescript
try {
  await connection.request({
    method: 'GET',
    url: '/sap/bc/adt/invalid/endpoint',
  });
} catch (error) {
  if (error.response) {
    console.error(`HTTP ${error.response.status}:`, error.response.data);
  } else {
    console.error('Network error:', error.message);
  }
}
```

### Auto-Refresh Error Handling

```typescript
try {
  await connection.connect();
} catch (error) {
  if (error.message.includes('JWT token has expired and refresh failed')) {
    console.error('Token refresh failed - please re-authenticate');
    // Trigger new authentication flow
  } else {
    console.error('Connection failed:', error.message);
  }
}
```

## CLI Tool Usage

### Interactive Authentication

```bash
# Start interactive auth flow
sap-abap-auth

# With custom port
sap-abap-auth --port 3001

# With redirect URL
sap-abap-auth --redirect-url http://localhost:3000/callback

# Force new authentication (ignore existing tokens)
sap-abap-auth --force
```

### Using CLI Output

The CLI saves tokens to `.env.auth`:

```bash
# Run CLI
sap-abap-auth

# Load tokens in your application
source .env.auth
node your-app.js
```

## Examples Directory

See [examples/](../examples/) for complete working examples:

- `basic-connection.js` - Simple connection example
- `create-class.js` - Create ABAP class
- `read-package.js` - Read package structure
- `session-persistence.js` - Session management
- `auto-refresh.js` - JWT auto-refresh

## Best Practices

1. **Use Factory Function**: Prefer `createAbapConnection()` over direct instantiation
2. **Enable Session Persistence**: Reuse sessions to avoid repeated CSRF token fetches
3. **Configure Auto-Refresh**: For cloud systems, always provide refresh credentials
4. **Handle Errors Gracefully**: Wrap requests in try-catch blocks
5. **Use Proper Logging**: Implement custom logger for production systems
6. **Close Connections**: Call `disconnect()` when done (if implemented)

## Next Steps

- See [AUTO_REFRESH_TESTING.md](./AUTO_REFRESH_TESTING.md) for testing guide
- See [CUSTOM_SESSION_STORAGE.md](./CUSTOM_SESSION_STORAGE.md) for advanced session management
- See API documentation in [README.md](../README.md)
