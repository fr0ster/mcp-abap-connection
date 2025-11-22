# Usage Guide

**Version:** 0.1.9  
**Last Updated:** November 23, 2025

## Table of Contents

- [Quick Start](#quick-start)
- [Authentication Types](#authentication-types)
- [Making ADT Requests](#making-adt-requests)
- [Session Management](#session-management)
- [Advanced Features](#advanced-features)
- [API Reference](#api-reference)

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

// Simple logger
const logger = {
  info: (msg: string, meta?: any) => console.log(msg, meta),
  error: (msg: string, meta?: any) => console.error(msg, meta),
  warn: (msg: string, meta?: any) => console.warn(msg, meta),
  debug: (msg: string, meta?: any) => console.debug(msg, meta),
};

// Create connection (auto-detects on-premise vs cloud)
const connection = createAbapConnection(config, logger);

// Make ADT requests (connection happens automatically)
const response = await connection.makeAdtRequest({
  method: 'GET',
  url: '/sap/bc/adt/repository/nodestructure',
});

console.log(response.data);
```

## Authentication Types

### Basic Authentication (On-Premise)

For on-premise SAP systems using basic authentication:

```typescript
import { BaseAbapConnection } from '@mcp-abap-adt/connection';

const config = {
  url: 'https://sap-server.local:8000',
  authType: 'basic' as const,
  username: 'developer',
  password: 'SecurePass123',
  client: '100',
};

const connection = new BaseAbapConnection(config, logger);
// Connection and CSRF token fetching happens automatically on first request
```

### JWT Authentication (Cloud/BTP)

For SAP BTP ABAP Environment using JWT tokens:

```typescript
import { JwtAbapConnection } from '@mcp-abap-adt/connection';

```typescript
import { JwtAbapConnection } from '@mcp-abap-adt/connection';

const config = {
  url: 'https://tenant.abap.cloud',
  authType: 'jwt' as const,
  jwtToken: 'eyJhbGciOiJSUzI1NiIs...',
  client: '100', // Optional for cloud
};

const connection = new JwtAbapConnection(config, logger);
```

### JWT with Auto-Refresh (Recommended for Cloud)

**New in 0.1.0+:** Automatic token refresh when JWT expires:

```typescript
const config = {
  url: 'https://tenant.abap.cloud',
  authType: 'jwt' as const,
  jwtToken: 'eyJhbGciOiJSUzI1NiIs...',
  client: '100',
  
  // Auto-refresh configuration (required for auto-refresh)
  // Auto-refresh configuration (required for auto-refresh)
  refreshToken: 'your-refresh-token',
  uaaUrl: 'https://tenant.authentication.cloud',
  uaaClientId: 'sb-client-id!b123',
  uaaClientSecret: 'client-secret-xyz',
};

const connection = new JwtAbapConnection(config, logger);

// Token will auto-refresh on 401/403 errors
// No manual intervention needed - just use the connection normally
const response = await connection.makeAdtRequest({
  method: 'GET',
  url: '/sap/bc/adt/repository/nodestructure',
});
```

## Making ADT Requests

All requests are made using `makeAdtRequest()` method. Connection and CSRF token management happen automatically.

### GET Request

```typescript
const packages = await connection.makeAdtRequest({
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

const response = await connection.makeAdtRequest({
  method: 'POST',
  url: '/sap/bc/adt/oo/classes',
  headers: { 'Content-Type': 'application/xml' },
  data: classXml,
  params: { package: 'ZTEST' },
});
```

### PUT Request (Update Object)

```typescript
await connection.makeAdtRequest({
  method: 'PUT',
  url: '/sap/bc/adt/oo/classes/zcl_my_class/source/main',
  headers: { 'Content-Type': 'text/plain' },
  data: classSourceCode,
  params: { lockHandle: lockToken },
});
```

### DELETE Request

```typescript
await connection.makeAdtRequest({
  method: 'DELETE',
  url: '/sap/bc/adt/oo/classes/zcl_my_class',
  params: { deleteOption: 'deleteAndLocalVersions' },
});
```

## Session Management

### Stateless Mode (Default)

By default, connections are stateless - each request gets fresh cookies and CSRF tokens:

```typescript
const connection = createAbapConnection(config, logger);

// Each request is independent
await connection.makeAdtRequest({ method: 'GET', url: '/sap/bc/adt/discovery' });
```

### Stateful Mode (Session Persistence)

**New in 0.1.0+:** Enable session persistence for operations requiring consistent session state:

```typescript
import { FileSessionStorage } from '@mcp-abap-adt/connection';

const sessionStorage = new FileSessionStorage({
  sessionsDir: './.sessions',
  enablePersistence: true,
});

const connection = createAbapConnection(config, logger);

// Enable stateful session
await connection.enableStatefulSession('my-session-id', sessionStorage);

// Now all requests share the same session (cookies, CSRF token)
await connection.makeAdtRequest({ method: 'GET', url: '/sap/bc/adt/discovery' });

// Check session mode
console.log(connection.getSessionMode()); // 'stateful'

// Get session ID (new in 0.1.6+)
console.log(connection.getSessionId()); // 'my-session-id'

// Switch back to stateless (new in 0.1.6+)
connection.setSessionType('stateless');

// Disable stateful session
connection.disableStatefulSession();
```

### Custom Session Storage

For production use, implement `ISessionStorage` for your backend (Redis, database, etc.):

```typescript
import { ISessionStorage, SessionState } from '@mcp-abap-adt/connection';

class RedisSessionStorage implements ISessionStorage {
  async save(sessionId: string, state: SessionState): Promise<void> {
    await redis.set(`session:${sessionId}`, JSON.stringify(state));
  }
  
  async load(sessionId: string): Promise<SessionState | null> {
    const data = await redis.get(`session:${sessionId}`);
    return data ? JSON.parse(data) : null;
  }
  
  async delete(sessionId: string): Promise<void> {
    await redis.del(`session:${sessionId}`);
  }
}

const storage = new RedisSessionStorage();
await connection.enableStatefulSession('user-123', storage);
```

## Advanced Features

### Session ID Management (New in 0.1.4+)

Session IDs are now auto-generated if not provided:

```typescript
// Auto-generated session ID
await connection.enableStatefulSession(undefined, storage);
console.log(connection.getSessionId()); // e.g., '7f3a8b2c-...'

// Or provide your own
await connection.enableStatefulSession('custom-session-123', storage);
```

### Switching Session Types (New in 0.1.6+)

Dynamically switch between stateful and stateless modes:

```typescript
// Start in stateless mode
const connection = createAbapConnection(config, logger);

// Enable stateful for a series of operations
await connection.enableStatefulSession('session-1', storage);
connection.setSessionType('stateful');

// Do stateful operations...
await connection.makeAdtRequest({ method: 'POST', url: '...' });

// Switch back to stateless
connection.setSessionType('stateless');
```

### Connection Reset

Reset connection state (clears cookies, CSRF token):

```typescript
connection.reset();
```

## Custom Logging

### Using Custom Logger

```typescript
import { ILogger } from '@mcp-abap-adt/connection';

class CustomLogger implements ILogger {
  info(message: string, meta?: any) {
    console.log(`[INFO] ${message}`, meta);
  }
  
  warn(message: string, meta?: any) {
    console.warn(`[WARN] ${message}`, meta);
  }
  
  error(message: string, meta?: any) {
    console.error(`[ERROR] ${message}`, meta);
  }
  
  debug(message: string, meta?: any) {
    if (process.env.DEBUG) {
      console.debug(`[DEBUG] ${message}`, meta);
    }
  }
  
  // Optional: CSRF-specific logging
  csrfToken?(action: 'fetch' | 'retry' | 'success' | 'error', message: string, meta?: any) {
    console.log(`[CSRF:${action.toUpperCase()}] ${message}`, meta);
  }
  
  // Optional: TLS config logging
  tlsConfig?(rejectUnauthorized: boolean) {
    console.log(`[TLS] rejectUnauthorized=${rejectUnauthorized}`);
  }
}

const logger = new CustomLogger();
const connection = createAbapConnection(config, logger);
```

## Error Handling

### Basic Error Handling

```typescript
try {
  await connection.makeAdtRequest({
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

JWT auto-refresh happens automatically, but you can detect when it fails:

```typescript
try {
  await connection.makeAdtRequest({ method: 'GET', url: '/sap/bc/adt/discovery' });
} catch (error) {
  if (error.message?.includes('refresh failed')) {
    console.error('Token refresh failed - please re-authenticate');
    // Trigger new authentication flow
  } else {
    console.error('Connection failed:', error.message);
  }
}
```

## API Reference

### `AbapConnection` Interface

Main interface for all connection types:

```typescript
interface AbapConnection {
  makeAdtRequest(options: AbapRequestOptions): Promise<AxiosResponse>;
  reset(): void;
  enableStatefulSession(sessionId: string | undefined, storage: ISessionStorage): Promise<void>;
  disableStatefulSession(): void;
  getSessionMode(): "stateless" | "stateful";
  getSessionId(): string | undefined; // New in 0.1.6+
  setSessionType(type: "stateless" | "stateful"): void; // New in 0.1.6+
}
```

### `BaseAbapConnection` (Basic Auth)

For on-premise SAP systems:

```typescript
class BaseAbapConnection extends AbstractAbapConnection {
  constructor(config: SapConfig, logger: ILogger);
}
```

### `JwtAbapConnection` (JWT/OAuth2)

For SAP BTP cloud systems with automatic token refresh:

```typescript
class JwtAbapConnection extends AbstractAbapConnection {
  constructor(config: SapConfig, logger: ILogger);
  canRefreshToken(): boolean; // Check if refresh is possible
  refreshToken(): Promise<void>; // Manually trigger refresh
}
```

### `createAbapConnection()` Factory

Recommended way to create connections:

```typescript
function createAbapConnection(
  config: SapConfig,
  logger: ILogger,
  sessionStorage?: ISessionStorage,
  sessionId?: string
): AbapConnection;
```

Auto-detects auth type and returns appropriate connection instance.

### Configuration Types

```typescript
type SapConfig = {
  url: string;                    // SAP system URL
  client?: string;                // SAP client (optional for cloud)
  authType: 'basic' | 'jwt';      // Authentication type
  
  // For basic auth
  username?: string;
  password?: string;
  
  // For JWT auth
  jwtToken?: string;
  
  // For JWT auto-refresh (optional but recommended)
  refreshToken?: string;
  uaaUrl?: string;
  uaaClientId?: string;
  uaaClientSecret?: string;
};
```

## Examples Directory

See [examples/](../examples/) for complete working examples:

- `basic-connection.js` - Simple connection example
- `auto-refresh.js` - JWT auto-refresh demonstration
- `session-persistence.js` - Session management with FileSessionStorage
- See [examples/README.md](../examples/README.md) for full list

## Best Practices

1. **Use Factory Function**: Prefer `createAbapConnection()` over direct instantiation - it auto-detects auth type
2. **Enable Session Persistence**: Use stateful sessions for multi-request operations (locks, transactions)
3. **Configure Auto-Refresh**: For cloud systems, always provide refresh credentials to avoid auth interruptions
4. **Handle Errors Gracefully**: Wrap requests in try-catch blocks and check `error.response` for HTTP errors
5. **Use Proper Logging**: Implement custom logger for production systems with appropriate log levels
6. **Session ID Management**: Use auto-generated session IDs (new in 0.1.4+) or provide meaningful IDs
7. **Switch Session Types**: Use `setSessionType()` (new in 0.1.6+) to dynamically change between stateful/stateless

## Version History

- **0.1.9**: Documentation improvements (this document updated)
- **0.1.8**: Session management improvements
- **0.1.7**: Base URL handling refactoring
- **0.1.6**: Added `getSessionId()` and `setSessionType()` methods
- **0.1.4**: Automatic session ID generation
- **0.1.0**: Initial release with JWT auto-refresh

See [CHANGELOG.md](../CHANGELOG.md) for complete version history.

## Next Steps

- See [AUTO_REFRESH_TESTING.md](./AUTO_REFRESH_TESTING.md) for JWT auto-refresh testing guide
- See [CUSTOM_SESSION_STORAGE.md](./CUSTOM_SESSION_STORAGE.md) for advanced session management
- See [STATEFUL_SESSION_GUIDE.md](./STATEFUL_SESSION_GUIDE.md) for session state management details
- See [JWT_AUTH_TOOLS.md](./JWT_AUTH_TOOLS.md) for CLI authentication tool
- See [INSTALLATION.md](./INSTALLATION.md) for installation instructions
