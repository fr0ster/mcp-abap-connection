# Usage Guide

**Version:** see [CHANGELOG.md](../CHANGELOG.md)  

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

// Establish the session. This is REQUIRED: a request on a connection that was
// never connected is refused with ADT_NOT_CONNECTED, and connect() rejects if
// the session cannot be established — it never resolves over a broken one.
await connection.connect();

const response = await connection.makeAdtRequest({
  method: 'GET',
  url: '/sap/bc/adt/repository/nodestructure',
});

console.log(response.data);
```

Tearing the session down is `disconnect()`, but it is not on the
`IAbapConnection` type this factory returns — see
[Session Lifecycle](#session-lifecycle) for where it lives and how to reach it.

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
await connection.connect();   // required: nothing is established implicitly
```

### JWT Authentication (Cloud/BTP)

For SAP BTP ABAP Environment. Token refresh belongs to
`@mcp-abap-adt/auth-broker`; this package only carries the token:

```typescript
import { JwtAbapConnection } from '@mcp-abap-adt/connection';

const config = {
  url: 'https://tenant.abap.cloud',
  authType: 'jwt' as const,
  jwtToken: 'eyJhbGciOiJSUzI1NiIs...',
  client: '100', // Optional for cloud
};

const connection = new JwtAbapConnection(config, logger);
await connection.connect();   // required: nothing is established implicitly

// Note: Token refresh is handled by @mcp-abap-adt/auth-broker package
// Connection package only handles HTTP communication
const response = await connection.makeAdtRequest({
  method: 'GET',
  url: '/sap/bc/adt/repository/nodestructure',
});
```

## Making ADT Requests

All requests are made using the `makeAdtRequest()` method. CSRF token handling
is automatic; **the connection is not** — the examples below assume
`await connection.connect()` has already succeeded, and without it every one of
them is refused with `ADT_NOT_CONNECTED`.

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
await connection.connect();

// Each request is independent
await connection.makeAdtRequest({ method: 'GET', url: '/sap/bc/adt/discovery' });
```

### Stateful Mode (Session Headers)

Enable stateful session mode for operations requiring consistent session state:

```typescript
const connection = createAbapConnection(config, logger);
await connection.connect();

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

## Session Lifecycle

The connection owns its session, and that ownership is explicit rather than
implied. Four things follow from it.

> **One exception, for Kerberos.** SPNEGO here is single-leg: the first request
> carries the `Negotiate` header and SAP issues the session cookie in response
> to it. A `Negotiate` 401 during `connect()` is therefore the handshake, not a
> failure — `connect()` resolves, `isConnected()` is true because the credential
> is ready, and `getSessionIdentity()` stays `null` until the cookie arrives
> with the first request. An NTLM challenge is still rejected outright, and a
> 401 carrying no challenge at all still fails.

> **Availability.** `connect()` is on the shared `IAbapConnection` contract and
> works on every connection. The rest of this section — `disconnect()`,
> `isConnected()`, `getSessionIdentity()`, `beginWindow()`, `endWindow()` — is
> **not on the contract yet** and exists on the HTTP connection classes only.
> Reach it through a concrete type, not through what `createAbapConnection()`
> returns, and note that `RfcAbapConnection` does not have these at all: on RFC
> the session *is* the open client, so it needs none of them.

### connect() is required, and it tells the truth

```typescript
import { BaseAbapConnection } from '@mcp-abap-adt/connection';

const connection = new BaseAbapConnection(config, logger);

await connection.connect();          // establishes the session, or rejects
connection.isConnected();            // true only while a usable session exists
connection.getSessionIdentity();     // which SAP session, or null
```

A resolved `connect()` means a usable session exists — there is no third
outcome. A request before it, or after a teardown, is refused with
`ADT_NOT_CONNECTED` and never reaches the server.

`connect()` is idempotent and safe to call concurrently: callers share one
establishment rather than opening a session each.

### disconnect() reports what it could not finish

```typescript
const report = await connection.disconnect();
// { abandonedWindows: string[], releasePending: boolean }
```

It never throws — the report says what did not finish instead. It waits for
in-flight requests to settle before clearing anything, so a teardown never
pulls the session out from under a request already running.

**Over HTTP it does not release locks.** The ABAP session lives on until its
timeout, along with whatever it held. Unlock first; disconnecting is not a way
to clean up after yourself.

### Lock windows

A lock outlives the request that takes it, which makes it the one thing a
teardown has to know about:

```typescript
const token = connection.beginWindow('Class/ZCL_MY_CLASS');

let lockHandle: string | undefined;
try {
  lockHandle = await lock(connection, 'ZCL_MY_CLASS');   // your LOCK call
} catch (error) {
  // The LOCK is confirmed to have failed, so nothing is held: close the window.
  connection.endWindow(token);
  throw error;
}

try {
  await update(connection, 'ZCL_MY_CLASS', lockHandle);
  await unlock(connection, 'ZCL_MY_CLASS', lockHandle);
  // The UNLOCK is confirmed: the lock is released, so close the window.
  connection.endWindow(token);
} catch (error) {
  // Deliberately NOT closed here. The unlock may have failed, never gone out,
  // or come back with an unknown outcome — in each of those the lock is most
  // likely still held, and a window left open is what makes a teardown wait for
  // it and report it by name instead of walking past it.
  throw error;
}
```

Note what the `catch` does **not** do. A `finally { endWindow(token) }` reads
naturally and is wrong here: it closes the window exactly when the lock is most
likely still there. The window tracks *"a lock may be held"*, so only proof that
nothing is held closes it — a confirmed unlock, or a confirmed failure to lock.

The cost of forgetting `endWindow()` on the success path is not silence: every
later teardown waits out `SAP_TIMEOUT_CRITICAL` and then reports the window as
abandoned.

While a window is open, a teardown waits for it rather than abandoning it, and
a new window cannot be opened once a teardown has been requested. A window that
never closes is given up on after `SAP_TIMEOUT_CRITICAL` and comes back **named**
in `TeardownReport.abandonedWindows`.

### When the session is lost

Two different things can cost you the session, and they do not behave alike.

**The session was replaced** — a renewed credential, or a session cookie that
changed underneath you. This is fatal **only while a lock window is open**:

```typescript
// window open  → ADT_SESSION_REPLACED, the connection stops being usable
// no window    → transparent; work continues on the new session
```

With nothing held there is nothing to lose, so the connector carries on. The
error exists to tell you that a lock handle you are carrying is now dead, which
is the one thing you cannot work out for yourself.

**The server says the session is gone** — an answer meaning the session it was
given no longer exists. This is **always** fatal, window or not: the connection
raises `ADT_SESSION_REPLACED` and stops being usable. Unlike a replacement,
nothing here suggests a working session to continue on — the one we had is
confirmed dead, and re-establishing silently is what let the old connector
carry on over a session the caller never opened.

In both cases the connector does **not** retry the request internally. Retrying
blindly is what produced further orphaned locks in the field. That decision is
yours.

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
await connection.connect();

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

`AbapConnection` is an alias for `IAbapConnection` — the contract every
connection satisfies, including RFC:

```typescript
interface AbapConnection {
  connect(): Promise<void>; // REQUIRED before any request
  makeAdtRequest(options: AbapRequestOptions): Promise<AxiosResponse>;
  getBaseUrl(): Promise<string>;
  setSessionType(type: "stateless" | "stateful"): void;
  getSessionId(): string | null; // client-side conversation id
}
```

Anything beyond that is **not** on the contract. `reset()`, `getSessionMode()`
and the session lifecycle (`disconnect()`, `isConnected()`,
`getSessionIdentity()`, `beginWindow()`, `endWindow()`) live on the HTTP
connection classes; `RfcAbapConnection` has some of them and not others, so
reach for them through a concrete type rather than through what
`createAbapConnection()` returns.

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

See [CHANGELOG.md](../CHANGELOG.md) for the version history.

## Next Steps

- Token refresh functionality is now in `@mcp-abap-adt/auth-broker` package
- Session state persistence is now in `@mcp-abap-adt/auth-broker` package
- See [JWT_AUTH_TOOLS.md](./JWT_AUTH_TOOLS.md) for CLI authentication tool
- See [INSTALLATION.md](./INSTALLATION.md) for installation instructions
