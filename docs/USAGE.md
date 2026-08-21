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
const connection = createAbapConnection(config, logger, undefined, undefined, {
  system: 'onprem', // or 'cloud' — said by you, never detected
});
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

## Which system, and how you authenticate

Two independent choices, and they must stay independent. The connector says
which SYSTEM you are dialling; the auth provider says how you prove who you
are. A communication user against ABAP Cloud and a bearer token against an
on-prem system are both ordinary, and a design where the credential picked the
system's session mechanism got one of them wrong whichever way it guessed.

Nothing is detected. `/sap/bc/adt/core/http/sessions` answers on on-prem too,
and its `DELETE` there leaves the session open while the platform logoff removes
it — so asking the server would choose the mechanism that releases nothing.

### Basic Authentication (On-Premise)

For on-premise SAP systems using basic authentication:

```typescript
import {
  AdtOnPremConnector,
  BasicAuthProvider,
} from '@mcp-abap-adt/connection';

const config = {
  url: 'https://sap-server.local:8000',
  authType: 'basic' as const,
  username: 'developer',
  password: 'SecurePass123',
  client: '100',
};

const connection = new AdtOnPremConnector(
  config,
  new BasicAuthProvider(config.username, config.password),
  logger,
);
await connection.connect();   // required: nothing is established implicitly
```

### JWT Authentication (Cloud/BTP)

For SAP BTP ABAP Environment. Token refresh belongs to
`@mcp-abap-adt/auth-broker`; this package only carries the token:

```typescript
import {
  AdtCloudConnector,
  TokenAuthProvider,
} from '@mcp-abap-adt/connection';

const config = {
  url: 'https://tenant.abap.cloud',
  authType: 'jwt' as const,
  client: '100', // Optional for cloud
};

// A bare token works and has no renewal behind it. Hand the provider an
// ITokenRefresher instead — from @mcp-abap-adt/auth-broker or your own — and it
// checks expiry and refreshes on its own.
const connection = new AdtCloudConnector(
  config,
  new TokenAuthProvider('eyJhbGciOiJSUzI1NiIs...'),
  logger,
);
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
const connection = createAbapConnection(config, logger, undefined, undefined, {
  system: 'onprem', // or 'cloud' — said by you, never detected
});
await connection.connect();

// Each request is independent
await connection.makeAdtRequest({ method: 'GET', url: '/sap/bc/adt/discovery' });
```

### Stateful Mode (Session Headers)

Enable stateful session mode for operations requiring consistent session state:

```typescript
const connection = createAbapConnection(config, logger, undefined, undefined, {
  system: 'onprem', // or 'cloud' — said by you, never detected
});
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

> **A Kerberos limitation worth knowing.** SPNEGO here is single-leg: one
> `step('')` produces the token and the GSS context is discarded. If the server
> continues the exchange — a 401 carrying a `Negotiate` token, which
> [RFC 4559](https://www.rfc-editor.org/rfc/rfc4559) defines as a continuation —
> this client cannot feed that token back, so `connect()` fails with an error
> saying exactly that. Multi-leg SPNEGO is not implemented.

> **Availability.** `connect()` is on the shared `IAbapConnection` contract and
> works on every connection. The rest of this section is on the contract too, but
> as a **capability atom** in `@mcp-abap-adt/interfaces` rather than as methods on
> `IAbapConnection`: `ISessionLifecycleAware` — `disconnect()`, `isConnected()`,
> `getSessionIdentity()`.
>
> The split is the point. `IAbapConnection` is the minimum every transport can
> honour, and `RfcAbapConnection` has none of these — on RFC the session *is* the
> open client, so it needs none. Requiring them of every connection would force a
> transport with no HTTP session to implement a lie.
>
> So ask for the atom you need, not for a concrete class:
>
> ```typescript
> function tearDownAfter(conn: IAbapConnection & ISessionLifecycleAware) { /* ... */ }
> ```
>
> **How you satisfy that parameter decides whether you get a compile-time
> guarantee, and there is only one way that does.**
>
> Construct the connection through a concrete HTTP class and the compiler knows
> it implements the atom, so passing an RFC connection is an error at the call
> site:
>
> ```typescript
> const conn = new AdtOnPremConnector(config, provider, logger);
> tearDownAfter(conn);                       // ✅ checked
> tearDownAfter(new RfcAbapConnection(cfg)); // ✅ compile error, as it should be
> ```
>
> `createAbapConnection()` cannot give you that. It returns `IAbapConnection` for
> **every** config, RFC included, so the type carries no evidence either way and
> the compiler rejects its result whatever the transport. Asserting past that —
> `conn as IAbapConnection & ISessionLifecycleAware` — silences the error for the
> HTTP case *and* for RFC, which then fails at runtime. An assertion is not a
> check; it is a promise you make to the compiler on your own authority.
>
> When you only have an `IAbapConnection` — from the factory, or from a caller —
> narrow it at runtime with a predicate:
>
> ```typescript
> function ownsItsSession(
>   conn: IAbapConnection,
> ): conn is IAbapConnection & ISessionLifecycleAware {
>   const candidate = conn as Partial<ISessionLifecycleAware>;
>   // EVERY method of the atom. A predicate narrows to the whole interface, so
>   // checking one and promising three puts the failure back where this check
>   // was meant to remove it — inside the branch that looked safe.
>   return (
>     typeof candidate.disconnect === 'function' &&
>     typeof candidate.isConnected === 'function' &&
>     typeof candidate.getSessionIdentity === 'function'
>   );
> }
>
> if (ownsItsSession(conn)) {
>   tearDownAfter(conn);       // narrowed by evidence, not by assertion
> } else {
>   // No HTTP session here. On RFC that is expected, not a failure.
> }
> ```
>
> That is a real check, and two things about it are load-bearing. The predicate
> covers the atom in full — a partial implementation must fail it, not pass it and
> break later. And the `else` branch is the honest part: a transport without the
> capability needs a different plan, not a cast.
>
> `ISessionLifecycleAware` takes the same treatment, over all three of
> `disconnect`, `isConnected` and `getSessionIdentity`.

### connect() is required, and it tells the truth

```typescript
import { AdtOnPremConnector, BasicAuthProvider } from '@mcp-abap-adt/connection';

const connection = new AdtOnPremConnector(
  config,
  new BasicAuthProvider(user, pass),
  logger,
);

await connection.connect();          // establishes the session, or rejects
connection.isConnected();            // true only while a usable session exists
connection.getSessionIdentity();     // which SAP session, or null
```

A resolved `connect()` means a usable session exists — there is no third
outcome. A request before it, or after a teardown, is refused with
`ADT_NOT_CONNECTED` and never reaches the server.

`connect()` is idempotent and safe to call concurrently: callers share one
establishment rather than opening a session each.

Match on the code rather than the message, so a rename is a compile error on your
side instead of a condition that silently stops matching. The codes live in
`@mcp-abap-adt/interfaces` — import them from there, not from this package:

```typescript
import { ADT_SESSION_ERROR } from '@mcp-abap-adt/interfaces';

try {
  await connection.makeAdtRequest(options);
} catch (error) {
  if ((error as { code?: string }).code === ADT_SESSION_ERROR.SESSION_REPLACED) {
    // The SAP session was replaced under us. Anything locked over the old one
    // is orphaned: re-connect, then re-acquire the lock.
  }
}
```

`AdtSessionErrorCode` comes from the same place, as does the capability interface
this connection implements — `ISessionLifecycleAware`. Depend on that rather than
on a concrete connection class where you can: an `RfcAbapConnection` is a valid
`IAbapConnection` that does not implement it, so the atom you require is also the
documentation of what your code actually needs.

### disconnect() waits for nothing

```typescript
await connection.disconnect();   // Promise<void>
```

It never throws, and it always settles. **It waits for nothing** — not for
requests in flight, not for anything you hold. Deciding when to disconnect is
yours, and so is preparing for it.

Requests already in flight run to completion untouched; nothing is aborted. What
the connection guarantees is that their results can no longer reach it: a
response arriving after the teardown is fenced, so it cannot write its cookies
over a session established since, and cannot be mistaken for a replacement.

An earlier version waited for in-flight requests before clearing anything. That
turned out to be unbounded — a request whose caller chose no timeout could hold a
teardown open forever, and since lifecycle transitions are serialized, every
later `connect()` queued behind it.

**Over HTTP it does not release locks.** The ABAP session lives on until its
timeout, along with whatever it held. Unlock first; disconnecting is not a way to
clean up after yourself.

### Uninterruptible spans

The connection does **not** track locks — it does not know one exists, what
object it covers, or what would release it. Pairing every LOCK with its UNLOCK is
`@mcp-abap-adt/adt-clients`' job, and it does it per object in its lock registry.

What this layer owns is the timeout, because a timeout is the server taking too
long and nothing about it depends on the caller. Aborting a request mid-flight
leaves an operation whose outcome you cannot determine — a `LOCK` that may have
succeeded server-side, with a handle you never received:

```typescript
connection.beginCriticalSection();
try {
  const handle = await lock(connection, 'ZCL_MY_CLASS');
  await update(connection, 'ZCL_MY_CLASS', handle);
  await unlock(connection, 'ZCL_MY_CLASS', handle);
} finally {
  connection.endCriticalSection();
}
```

While a section is active the effective timeout is raised to
`SAP_TIMEOUT_CRITICAL` (600s by default) — `Math.max(yours, the ceiling)`, so it
never shortens a timeout you chose. The pair is reference-counted, so nesting is
safe.

The raise is **connection-wide**: while any section is active, every request on
that connection gets the ceiling, including one that has nothing to do with the
locked object. Those requests share one ABAP session, and an abort leaves that
session in the same uncertain state during a span someone declared sensitive
precisely to avoid it.

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
const connection = createAbapConnection(config, logger, undefined, undefined, {
  system: 'onprem', // or 'cloud' — said by you, never detected
});
console.log(connection.getSessionId()); // e.g., '7f3a8b2c-...'

// Or provide your own when creating connection
const connection = createAbapConnection(config, logger, 'custom-session-123');
console.log(connection.getSessionId()); // 'custom-session-123'
```

### Switching Session Types

Dynamically switch between stateful and stateless modes:

```typescript
// Start in stateless mode (default)
const connection = createAbapConnection(config, logger, undefined, undefined, {
  system: 'onprem', // or 'cloud' — said by you, never detected
});
await connection.connect();

// Enable stateful for a series of operations
connection.setSessionType('stateful');

// Do stateful operations...
await connection.makeAdtRequest({ method: 'POST', url: '...' });

// Switch back to stateless
connection.setSessionType('stateless');
```

### Starting Over

There is no local-only reset. Discarding the cookie does not end the ABAP
session — the server keeps it until its own timeout, and sessions are limited
per user — so starting over means telling the server, then connecting again:

```typescript
await connection.disconnect(); // ends the session on the server too
await connection.connect(); // a new one, explicitly
```

A connection that was connected must be disconnected, which is why this belongs
in a `finally`. `disconnect()` never throws, so it is safe there.

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
const connection = createAbapConnection(config, logger, undefined, undefined, {
  system: 'onprem', // or 'cloud' — said by you, never detected
});
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

Anything beyond that is **not** on the contract. `getSessionMode()`
and the session lifecycle (`disconnect()`, `isConnected()`,
`getSessionIdentity()`) live on the HTTP
connection classes; `RfcAbapConnection` has some of them and not others, so
reach for them through a concrete type rather than through what
`createAbapConnection()` returns.

### `AdtOnPremConnector` / `AdtCloudConnector`

One per system, each handed an auth provider:

```typescript
class AdtOnPremConnector extends CredentialAbapConnection {
  constructor(
    config: SapConfig,
    provider: IAuthProvider,
    logger?: ILogger | null,
    sessionId?: string,
  );
}
// AdtCloudConnector has the same shape.
```

The difference is what each does with the session: on-prem takes it from the
establishing call and gives it back with the platform's ICF logoff; cloud opens
one at `/sap/bc/adt/core/http/sessions` and gives it back by `DELETE` on the
address the server publishes.

### `BaseAbapConnection` (Basic Auth) — deprecated

The previous shape, where the class stated the credential. Still works; see
[Migration to 5.0](./MIGRATION-5.0.md).

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


### `JwtAbapConnection` (JWT/OAuth2) — deprecated

For SAP BTP cloud systems. Token refresh is handled by `@mcp-abap-adt/auth-broker`:

```typescript
class JwtAbapConnection extends AbstractAbapConnection {
  constructor(
    config: SapConfig,
    logger?: ILogger | null,
    sessionId?: string,
    tokenRefresher?: ITokenRefresher,
  );
  // Note: refreshToken() and canRefreshToken() methods removed in 0.2.0
  // Token acquisition itself belongs to @mcp-abap-adt/auth-broker
}
```

**How failures are classified** (4.0.0 — see
[MIGRATION-4.0.md](./MIGRATION-4.0.md)):

| answer | what happens |
|---|---|
| **401** | with an injected `ITokenRefresher`, the token is refreshed, the SAP session re-established, and the request retried once. Without one, or when the retry is refused too, the server's error is rethrown |
| **403** | propagates untouched. The server authenticated the caller and refused the action anyway, so a new token is the same caller — usually the body names the authorization object |
| anything else | untouched |

The connection never replaces the server's error with one of its own: `error.response.status` and
`error.response.data` are always what SAP sent. Before 4.0.0 both 401 and 403 were reported as
`JWT token has expired. Please re-authenticate.` with the original error discarded.

Concurrent requests that meet the same expired token share **one** renewal — a single token fetch
and a single session re-establishment between them, not one each.

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
