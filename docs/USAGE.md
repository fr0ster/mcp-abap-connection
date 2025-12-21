# Usage Guide

**Version:** 0.2.4  
**Last Updated:** December 2025

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

// Logger is optional - if not provided, no logging output
const logger = {
  info: (msg: string, meta?: any) => console.log(msg, meta),
  error: (msg: string, meta?: any) => console.error(msg, meta),
  warn: (msg: string, meta?: any) => console.warn(msg, meta),
  debug: (msg: string, meta?: any) => console.debug(msg, meta),
};

// Create connection (logger is optional)
const connection = createAbapConnection(config, logger);
// Or without logger:
// const connection = createAbapConnection(config);

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

### JWT Authentication (Cloud/BTP)

For SAP BTP ABAP Environment, use `@mcp-abap-adt/auth-broker` for token refresh functionality:

```typescript
const config = {
  url: 'https://tenant.abap.cloud',
  authType: 'jwt' as const,
  jwtToken: 'eyJhbGciOiJSUzI1NiIs...',
  client: '100', // Optional for cloud
};

const connection = new JwtAbapConnection(config, logger);

// Note: Token refresh is handled by @mcp-abap-adt/auth-broker package
// Connection package only handles HTTP communication
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

### Stateful Mode (Session Headers)

Enable stateful session mode for operations requiring consistent session state:

```typescript
const connection = createAbapConnection(config, logger);

// Enable stateful session mode (adds x-sap-adt-sessiontype: stateful header)
connection.setSessionType('stateful');

// Now all requests share the same session (cookies, CSRF token)
await connection.makeAdtRequest({ method: 'GET', url: '/sap/bc/adt/discovery' });

// Check session mode
console.log(connection.getSessionMode()); // 'stateful'

// Get session ID (auto-generated UUID)
console.log(connection.getSessionId()); // e.g., '7f3a8b2c-...'

// Switch back to stateless
connection.setSessionType('stateless');
```

**Note:** Session state persistence is handled by `@mcp-abap-adt/auth-broker` package. The connection package only manages session headers (cookies, CSRF tokens) for HTTP communication.

## Advanced Features

### Session ID Management

Session IDs are auto-generated (UUID) when connection is created:

```typescript
const connection = createAbapConnection(config, logger);
console.log(connection.getSessionId()); // e.g., '7f3a8b2c-...'

// Or provide your own when creating connection
const connection = createAbapConnection(config, logger, 'custom-session-123');
console.log(connection.getSessionId()); // 'custom-session-123'
```

### Switching Session Types

Dynamically switch between stateful and stateless modes:

```typescript
// Start in stateless mode (default)
const connection = createAbapConnection(config, logger);

// Enable stateful for a series of operations
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

### Network Error Detection

The connection automatically detects network-level errors and prevents unnecessary retry attempts. Network errors include:

- `ECONNREFUSED` - Connection refused (server not reachable)
- `ETIMEDOUT` - Connection timeout
- `ENOTFOUND` - DNS resolution failed (hostname not found)
- `ECONNRESET` - Connection reset by peer
- `ENETUNREACH` - Network unreachable
- `EHOSTUNREACH` - Host unreachable

When these errors occur, the connection:
1. **Does NOT attempt CSRF token retry** - network issues can't be fixed by retrying authentication
2. **Immediately throws the error** with clear network-related message
3. **Logs the error** with full context for troubleshooting

```typescript
try {
  await connection.makeAdtRequest({
    method: 'GET',
    url: '/sap/bc/adt/repository/nodestructure',
  });
} catch (error) {
  // Check for specific network error codes
  if (error.code === 'ECONNREFUSED') {
    console.error('Cannot connect to SAP server - check VPN connection');
  } else if (error.code === 'ETIMEDOUT') {
    console.error('Connection timeout - server not responding');
  } else if (error.code === 'ENOTFOUND') {
    console.error('Cannot resolve hostname - check SAP URL');
  } else if (error.response) {
    console.error(`HTTP ${error.response.status}:`, error.response.data);
  } else {
    console.error('Request failed:', error.message);
  }
}
```

**Best Practices:**
- Always handle network errors separately from HTTP errors
- Network errors indicate infrastructure issues (VPN, DNS, firewall)
- HTTP errors (401, 403, 404, etc.) indicate application-level issues
- Use error codes to provide specific user guidance


## API Reference

### `AbapConnection` Interface

Main interface for all connection types:

```typescript
interface AbapConnection {
  makeAdtRequest(options: AbapRequestOptions): Promise<AxiosResponse>;
  reset(): void;
  setSessionType(type: "stateless" | "stateful"): void;
  getSessionMode(): "stateless" | "stateful";
  getSessionId(): string | null;
}
```

### `BaseAbapConnection` (Basic Auth)

For on-premise SAP systems:

```typescript
class BaseAbapConnection extends AbstractAbapConnection {
  constructor(config: SapConfig, logger?: ILogger | null, sessionId?: string);
}
```

### `CSRF_CONFIG` and `CSRF_ERROR_MESSAGES` (New in 0.1.13+)

Exported constants for consistent CSRF token handling across different connection implementations:

```typescript
import { CSRF_CONFIG, CSRF_ERROR_MESSAGES } from '@mcp-abap-adt/connection';

// CSRF_CONFIG structure:
const config = {
  RETRY_COUNT: 3,                    // Number of retry attempts
  RETRY_DELAY: 1000,                 // Delay between retries (ms)
  ENDPOINT: '/sap/bc/adt/core/discovery',  // CSRF token endpoint
  REQUIRED_HEADERS: {
    'x-csrf-token': 'fetch',
    'Accept': 'application/atomsvc+xml'
  }
};

// CSRF_ERROR_MESSAGES structure:
const messages = {
  FETCH_FAILED: (attempts: number, cause: string) => string,
  NOT_IN_HEADERS: 'No CSRF token in response headers',
  REQUIRED_FOR_MUTATION: 'CSRF token is required for POST/PUT requests but could not be fetched'
};
```

**Use case:** When implementing custom connection classes (e.g., Cloud SDK-based), use these constants to ensure consistent CSRF token handling:

```typescript
import { CSRF_CONFIG, CSRF_ERROR_MESSAGES } from '@mcp-abap-adt/connection';
import { executeHttpRequest } from '@sap-cloud-sdk/http-client';

export class CloudSdkAbapConnection {
  async fetchCsrfToken(baseUrl: string): Promise<string> {
    const csrfUrl = `${baseUrl}${CSRF_CONFIG.ENDPOINT}`;
    
    for (let attempt = 0; attempt <= CSRF_CONFIG.RETRY_COUNT; attempt++) {
      try {
        const response = await executeHttpRequest(
          { destinationName: this.destination },
          {
            method: 'GET',
            url: csrfUrl,
            headers: CSRF_CONFIG.REQUIRED_HEADERS
          }
        );
        
        const token = response.headers['x-csrf-token'];
        if (!token) {
          if (attempt < CSRF_CONFIG.RETRY_COUNT) {
            await new Promise(resolve => setTimeout(resolve, CSRF_CONFIG.RETRY_DELAY));
            continue;
          }
          throw new Error(CSRF_ERROR_MESSAGES.NOT_IN_HEADERS);
        }
        
        return token;
      } catch (error) {
        if (attempt >= CSRF_CONFIG.RETRY_COUNT) {
          throw new Error(
            CSRF_ERROR_MESSAGES.FETCH_FAILED(
              CSRF_CONFIG.RETRY_COUNT + 1,
              error instanceof Error ? error.message : String(error)
            )
          );
        }
        await new Promise(resolve => setTimeout(resolve, CSRF_CONFIG.RETRY_DELAY));
      }
    }
    
    throw new Error(CSRF_ERROR_MESSAGES.FETCH_FAILED(CSRF_CONFIG.RETRY_COUNT + 1, 'Unknown error'));
  }
}
```

See [PR Proposal](../PR_PROPOSAL_CSRF_CONFIG.md) for more details.

### `JwtAbapConnection` (JWT/OAuth2)

For SAP BTP cloud systems. Token refresh is handled by `@mcp-abap-adt/auth-broker`:

```typescript
class JwtAbapConnection extends AbstractAbapConnection {
  constructor(config: SapConfig, logger?: ILogger | null);
  // Note: refreshToken() and canRefreshToken() methods removed in 0.2.0
  // Use @mcp-abap-adt/auth-broker for token refresh functionality
}
```

### `createAbapConnection()` Factory

Recommended way to create connections:

```typescript
function createAbapConnection(
  config: SapConfig,
  logger?: ILogger | null,
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
  
  // Note: Token refresh credentials (refreshToken, uaaUrl, etc.) are not used by connection package
  // Token refresh is handled by @mcp-abap-adt/auth-broker package
};
```

## Examples Directory

See [examples/](../examples/) for complete working examples:

- `basic-connection.js` - Simple connection example
- `basic-connection.js` - Basic authentication example
- See [examples/README.md](../examples/README.md) for full list

## Best Practices

1. **Use Factory Function**: Prefer `createAbapConnection()` over direct instantiation - it auto-detects auth type
2. **Enable Stateful Mode**: Use `setSessionType('stateful')` for multi-request operations (locks, transactions)
3. **Token Refresh**: For cloud systems, use `@mcp-abap-adt/auth-broker` for token refresh functionality
4. **Session State Persistence**: Use `@mcp-abap-adt/auth-broker` for session state persistence
5. **Handle Errors Gracefully**: Wrap requests in try-catch blocks and check `error.response` for HTTP errors
6. **Use Proper Logging**: Implement custom logger for production systems with appropriate log levels (logger is optional)
7. **Session ID Management**: Session IDs are auto-generated (UUID) or can be provided when creating connection
8. **Switch Session Types**: Use `setSessionType()` to dynamically change between stateful/stateless modes

## Version History

- **0.1.9**: Documentation improvements (this document updated)
- **0.1.8**: Session management improvements
- **0.1.7**: Base URL handling refactoring
- **0.1.6**: Added `getSessionId()` and `setSessionType()` methods
- **0.1.4**: Automatic session ID generation
- **0.2.0**: Token refresh moved to auth-broker package
- **0.1.0**: Initial release

See [CHANGELOG.md](../CHANGELOG.md) for complete version history.

## Next Steps

- Token refresh functionality is now in `@mcp-abap-adt/auth-broker` package
- Session state persistence is now in `@mcp-abap-adt/auth-broker` package
- See [JWT_AUTH_TOOLS.md](./JWT_AUTH_TOOLS.md) for CLI authentication tool
- See [INSTALLATION.md](./INSTALLATION.md) for installation instructions
