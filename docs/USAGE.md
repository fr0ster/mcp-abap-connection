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

### Basic Usage

```typescript
import {
  AdtOnPremConnector,
  BasicAuthProvider,
  OnPremHttpTransport,
  getTimeout,
} from '@mcp-abap-adt/connection';
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

// Three things, all stated by you and none of them detected: which system
// (the class), which credential (the object), which wire (the transport, which
// has no default — you build it and hand it over).
const connection = new AdtOnPremConnector(
  config,
  new BasicAuthProvider(config.username!, config.password!),
  new OnPremHttpTransport(() => ({}), logger, {
    client: config.client,
    baseUrl: config.url,
  }),
  logger, // optional; omit or pass null for no logging
);

// Establish the session. This is REQUIRED: a request on a connection that was
// never connected is refused with ADT_NOT_CONNECTED, and connect() rejects if
// the session cannot be established — it never resolves over a broken one.
await connection.connect();

const response = await connection.makeAdtRequest({
  method: 'GET',
  url: '/sap/bc/adt/repository/nodestructure',
  timeout: getTimeout('default'),
});

console.log(response.data);
```

Tearing the session down is `disconnect()`, but it is not on the
`IAbapConnection` type a connector satisfies — see
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
  OnPremHttpTransport,
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
  new OnPremHttpTransport(() => ({}), logger, {
    client: config.client,
    baseUrl: config.url,
  }),
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
  CloudHttpTransport,
  TokenAuthProvider,
  getTimeout,
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
  new CloudHttpTransport(() => ({}), logger, {
    client: config.client,
    baseUrl: config.url,
  }),
  logger,
);
await connection.connect();   // required: nothing is established implicitly

// Note: Token refresh is handled by @mcp-abap-adt/auth-broker package
// Connection package only handles HTTP communication
const response = await connection.makeAdtRequest({
  method: 'GET',
  url: '/sap/bc/adt/repository/nodestructure',
  timeout: getTimeout('default'),
});
```

## Making ADT Requests

All requests are made using the `makeAdtRequest()` method. CSRF token handling
is automatic; **the connection is not** — the examples below assume
`await connection.connect()` has already succeeded, and without it every one of
them is refused with `ADT_NOT_CONNECTED`.

### GET Request

```typescript
import { getTimeout } from '@mcp-abap-adt/connection';
const packages = await connection.makeAdtRequest({
  method: 'GET',
  url: '/sap/bc/adt/repository/nodestructure',
  params: {
    parent_name: 'DEVC/K',
    parent_type: 'DEVC/K',
    withShortDescriptions: 'true',
  },
  timeout: getTimeout('default'),
});
```

### POST Request (Create Object)

```typescript
import { getTimeout } from '@mcp-abap-adt/connection';
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
  timeout: getTimeout('default'),
});
```

### PUT Request (Update Object)

```typescript
const classSourceCode = 'CLASS zcl_my_class DEFINITION ...';
const lockToken = 'the handle the lock call returned';
import { getTimeout } from '@mcp-abap-adt/connection';
await connection.makeAdtRequest({
  method: 'PUT',
  url: '/sap/bc/adt/oo/classes/zcl_my_class/source/main',
  headers: { 'Content-Type': 'text/plain' },
  data: classSourceCode,      // the new source, as a string
  params: { lockHandle: lockToken },  // from the lock you took first
  timeout: getTimeout('default'),
});
```

### DELETE Request

```typescript
import { getTimeout } from '@mcp-abap-adt/connection';
await connection.makeAdtRequest({
  method: 'DELETE',
  url: '/sap/bc/adt/oo/classes/zcl_my_class',
  params: { deleteOption: 'deleteAndLocalVersions' },
  timeout: getTimeout('default'),
});
```

## Session Management

### Stateless Mode (Default)

By default, connections are stateless - each request gets fresh cookies and CSRF tokens:

```typescript
import { AdtOnPremConnector, BasicAuthProvider, OnPremHttpTransport, getTimeout } from '@mcp-abap-adt/connection';
const connection = new AdtOnPremConnector(
  config,
  new BasicAuthProvider(config.username!, config.password!),
  new OnPremHttpTransport(() => ({}), logger, {
    client: config.client,
    baseUrl: config.url,
  }),
  logger,
);
await connection.connect();

// Each request is independent
await connection.makeAdtRequest({ method: 'GET', url: '/sap/bc/adt/discovery' , timeout: getTimeout('default') });
```

### Stateful Mode (Session Headers)

Enable stateful session mode for operations requiring consistent session state:

```typescript
import { AdtOnPremConnector, BasicAuthProvider, OnPremHttpTransport, getTimeout } from '@mcp-abap-adt/connection';
const connection = new AdtOnPremConnector(
  config,
  new BasicAuthProvider(config.username!, config.password!),
  new OnPremHttpTransport(() => ({}), logger, {
    client: config.client,
    baseUrl: config.url,
  }),
  logger,
);
await connection.connect();

// Enable stateful session mode (adds x-sap-adt-sessiontype: stateful header)
connection.setSessionType('stateful');

// Now all requests share the same session (cookies, CSRF token)
await connection.makeAdtRequest({ method: 'GET', url: '/sap/bc/adt/discovery' , timeout: getTimeout('default') });

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
> The split is the point. `IAbapConnection` is the minimum any consumer of ADT
> can honour — a caller that only issues requests should not have to implement a
> teardown it never performs. Both connectors implement the atom, over either
> wire: an RFC conversation has the whole lifecycle, and what it has none of is a
> session RESOURCE to open and close by address, which is an empty mechanism
> rather than an absent lifecycle.
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
> Construct a connector and the compiler knows it implements the atom, whichever
> wire you gave it:
>
> ```typescript
> const conn = new AdtOnPremConnector(config, provider, new OnPremHttpTransport(() => ({}), logger, { client: config.client, baseUrl: config.url }), logger);
> tearDownAfter(conn);   // ✅ checked
>
> const overRfc = new AdtOnPremConnector(
>   config,
>   provider,
>   new RfcTransport(rfcConversationFrom(config), logger),
>   logger,
> );
> tearDownAfter(overRfc); // ✅ also checked — same class, different wire
> ```
>
> What does NOT give you that is a bare `IAbapConnection` handed to you by
> somebody else: the type carries no evidence either way, and the compiler
> rejects it. Asserting past that — `conn as IAbapConnection &
> ISessionLifecycleAware` — silences the error whether or not the object has the
> methods. An assertion is not a check; it is a promise you make to the compiler
> on your own authority.
>
> When you only have an `IAbapConnection` — from a caller, or from a registry —
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
import { AdtOnPremConnector, BasicAuthProvider, OnPremHttpTransport } from '@mcp-abap-adt/connection';

const connection = new AdtOnPremConnector(
  config,
  new BasicAuthProvider(config.username!, config.password!),
  new OnPremHttpTransport(() => ({}), logger, {
    client: config.client,
    baseUrl: config.url,
  }),
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
import { getTimeout } from '@mcp-abap-adt/connection';

const options = {
  method: 'GET',
  url: '/sap/bc/adt/repository/nodestructure',
  timeout: getTimeout('default'),
};

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
this connection implements — `ISessionLifecycleAware`. Depend on the atom rather
than on a concrete class where you can: an `IAbapConnection` may come from
somewhere that implements only the minimum, so the atom you require is also the
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
import { AdtOnPremConnector, BasicAuthProvider, OnPremHttpTransport } from '@mcp-abap-adt/connection';
const connection = new AdtOnPremConnector(
  config,
  new BasicAuthProvider(config.username!, config.password!),
  new OnPremHttpTransport(() => ({}), logger, {
    client: config.client,
    baseUrl: config.url,
  }),
  logger,
);
console.log(connection.getSessionId()); // e.g., '7f3a8b2c-...'

// Or provide your own when creating connection
const connectionWithOwnId = new AdtOnPremConnector(
  config,
  new BasicAuthProvider(config.username!, config.password!),
  new OnPremHttpTransport(() => ({}), logger, {
    client: config.client,
    baseUrl: config.url,
  }),
  logger,
  'custom-session-123');
console.log(connectionWithOwnId.getSessionId()); // 'custom-session-123'
```

### Switching Session Types

Dynamically switch between stateful and stateless modes:

```typescript
import { AdtOnPremConnector, BasicAuthProvider, OnPremHttpTransport, getTimeout } from '@mcp-abap-adt/connection';
// Start in stateless mode (default)
const connection = new AdtOnPremConnector(
  config,
  new BasicAuthProvider(config.username!, config.password!),
  new OnPremHttpTransport(() => ({}), logger, {
    client: config.client,
    baseUrl: config.url,
  }),
  logger,
);
await connection.connect();

// Enable stateful for a series of operations
connection.setSessionType('stateful');

// Do stateful operations...
await connection.makeAdtRequest({ method: 'POST', url: '...' , timeout: getTimeout('default') });

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
import { AdtOnPremConnector, BasicAuthProvider, ILogger, OnPremHttpTransport } from '@mcp-abap-adt/connection';

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
const connection = new AdtOnPremConnector(
  config,
  new BasicAuthProvider(config.username!, config.password!),
  new OnPremHttpTransport(() => ({}), logger, {
    client: config.client,
    baseUrl: config.url,
  }),
  logger,
);
```

## Error Handling

### Basic Error Handling

```typescript
import { getTimeout } from '@mcp-abap-adt/connection';
try {
  await connection.makeAdtRequest({
    method: 'GET',
    url: '/sap/bc/adt/invalid/endpoint',
    timeout: getTimeout('default'),
  });
} catch (error) {
  const failure = error as {
    code?: string;
    response?: { status: number; data: unknown };
    message?: string;
  };
  if (failure.response) {
    console.error(`HTTP ${failure.response.status}:`, failure.response.data);
  } else {
    console.error('Network error:', failure.message);
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
import { getTimeout } from '@mcp-abap-adt/connection';
try {
  await connection.makeAdtRequest({
    method: 'GET',
    url: '/sap/bc/adt/repository/nodestructure',
    timeout: getTimeout('default'),
  });
} catch (error) {
  const failure = error as {
    code?: string;
    response?: { status: number; data: unknown };
    message?: string;
  };
  // Check for specific network error codes
  if (failure.code === 'ECONNREFUSED') {
    console.error('Cannot connect to SAP server - check VPN connection');
  } else if (failure.code === 'ETIMEDOUT') {
    console.error('Connection timeout - server not responding');
  } else if (failure.code === 'ENOTFOUND') {
    console.error('Cannot resolve hostname - check SAP URL');
  } else if (failure.response) {
    console.error(`HTTP ${failure.response.status}:`, failure.response.data);
  } else {
    console.error('Request failed:', failure.message);
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
import { AbapRequestOptions } from '@mcp-abap-adt/connection';
import type { AxiosResponse } from 'axios';
interface AbapConnection {
  connect(): Promise<void>; // REQUIRED before any request
  makeAdtRequest(options: AbapRequestOptions): Promise<AxiosResponse>;
  getBaseUrl(): Promise<string>;
  setSessionType(type: "stateless" | "stateful"): void;
  getSessionId(): string | null; // client-side conversation id
}
```

Anything beyond that is **not** on the contract. `getSessionMode()` and the
session lifecycle (`disconnect()`, `isConnected()`, `getSessionIdentity()`) live
on the connectors — both of them, over either wire — so reach for them through a
connector type or through the `ISessionLifecycleAware` atom, not through a bare
`IAbapConnection` somebody handed you.

### `AdtOnPremConnector` / `AdtCloudConnector`

One per system, each handed an auth provider:

```text
class AdtOnPremConnector<
  TCredential extends IAuthProvider = IAuthProvider,
  TTransport extends IOnPremTransport = OnPremHttpTransport,
> {
  constructor(
    config: SapConfig,
    credential: TCredential,
    transport: TTransport,
    logger?: ILogger | null,
    sessionId?: string,
  );
}

class AdtCloudConnector<
  TCredential extends IAuthProvider = IAuthProvider,
  TTransport extends ICloudTransport = CloudHttpTransport,
> {
  constructor(
    config: SapConfig,
    credential: TCredential,
    transport: TTransport,
    logger?: ILogger | null,
    sessionId?: string,
  );
}
```

The difference is what each does with the session: on-prem takes it from the
establishing call and gives it back with the platform's ICF logoff; cloud opens
one at `/sap/bc/adt/core/http/sessions` and gives it back by `DELETE` on the
address the server publishes.

**Both take a transport, and neither defaults one.** What differs is the CHOICE,
and the type parameter is where that is said: `TTransport` is bound to
`IOnPremTransport` on one and to `ICloudTransport` on the other, so on-prem
admits HTTP or RFC while "cloud over RFC" does not compile — there is no such
deployment. The parameter also records what a connection was built with, so a
signature can ask for `AdtOnPremConnector<IAuthProvider, RfcTransport>` and be
given one, instead of taking any connection and casting.

### `HttpTransport` / `RfcTransport`

What a request travels over, and everything true of that wire: addressing,
establishing, and whatever session state it keeps.

```text
new HttpTransport(agentOptions?, logger?, { client?, baseUrl? })
new RfcTransport(connect: () => IRfcConversation, logger?)
```

`HttpTransport` is the ordinary wire, and you name it because the connector
takes no default. In practice you name one of its two subclasses — the session
mechanism is what differs, and `OnPremHttpTransport` / `CloudHttpTransport` are
what the connectors' type parameters admit. `RfcTransport`
you build with `rfcConversationFrom(config)`, which derives `ashost` and `sysnr`
and loads the SAP NW RFC SDK only when a conversation opens.

The two differ in what they have, not in what they are asked:

| | HTTP | RFC |
|---|---|---|
| session is | an ICF session, addressed by `SAP_SESSIONID` | the conversation itself |
| `establish()` | earns a CSRF token, and the cookies with it | nothing to earn |
| cookies | a jar, replayed on every request | none, ever |
| affinity | `sap-adt-saplb`, to stay on one app server | none |
| visible in | SM05 | SMGW → Logged on Clients |

### `CSRF_CONFIG` and `CSRF_ERROR_MESSAGES` (New in 0.1.13+)

Exported constants for consistent CSRF token handling across different connection implementations:

```text
// Imported from '@mcp-abap-adt/connection'; shapes, not runnable code.

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
              error instanceof Error ? failure.message : String(error)
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


### The credential, and how a refusal is classified

For SAP BTP cloud systems, hand `AdtCloudConnector` a `TokenAuthProvider`. A bare
string is a token with nothing behind it; an `ITokenRefresher` is a provider that
checks expiry and renews on its own, which is what you want in anything
long-lived. Obtaining tokens in the first place is `@mcp-abap-adt/auth-broker`'s
job, not this package's.

```text
new AdtCloudConnector(
  config,
  new TokenAuthProvider(refresher),   // or a bare token string
  new CloudHttpTransport(() => ({}), logger, { client: config.client, baseUrl: config.url }),
  logger,
);
```

**How failures are classified** (6.0.0 — see
[MIGRATION-6.0.md](./MIGRATION-6.0.md)):

| answer | what happens |
|---|---|
| **401** | **surfaces.** Nothing here decides to get a new credential. An EXPIRED token is already replaced without anyone deciding — the provider is asked per request and checks expiry before answering — so a 401 is the other case: a credential the source still believes in and the server refuses. Whether that means "stale" is a judgement made with what you know, and `renew()` on an `IRenewableCredential` is the seam you make it with. The session is untouched: a refused credential is not a lost session |
| **403** | propagates untouched. The server authenticated the caller and refused the action anyway, so a new token is the same caller — usually the body names the authorization object |
| anything else | untouched |

The connection never replaces the server's error with one of its own:
`failure.response.status` and `failure.response.data` are always what SAP sent.

Concurrent requests that meet the same expired token share **one** renewal — a
single token fetch and a single session re-establishment between them, not one
each.

**A refusal during `connect()` surfaces.** Nothing is renewed behind you there:
the provider already renews on expiry it can see, every time it is asked for a
header, so a refusal at establishment means the credential needs attention that
this library cannot give it.

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

1. **State the three axes**: the connector says which system, the provider says which credential, the transport says which wire. Nothing is detected, and a connection that had to guess would guess wrong on the case that matters
2. **Enable Stateful Mode**: Use `setSessionType('stateful')` for multi-request operations (locks, transactions)
3. **Token Refresh**: For cloud systems, use `@mcp-abap-adt/auth-broker` for token refresh functionality
4. **Session State Persistence**: Use `@mcp-abap-adt/auth-broker` for session state persistence
5. **Handle Errors Gracefully**: Wrap requests in try-catch blocks and check `failure.response` for HTTP errors
6. **Use Proper Logging**: Implement custom logger for production systems with appropriate log levels (logger is optional)
7. **Session ID Management**: Session IDs are auto-generated (UUID) or can be provided when creating connection
8. **Switch Session Types**: Use `setSessionType()` to dynamically change between stateful/stateless modes

See [CHANGELOG.md](../CHANGELOG.md) for the version history.

## Next Steps

- Token refresh functionality is now in `@mcp-abap-adt/auth-broker` package
- Session state persistence is now in `@mcp-abap-adt/auth-broker` package
- See [JWT_AUTH_TOOLS.md](./JWT_AUTH_TOOLS.md) for CLI authentication tool
- See [INSTALLATION.md](./INSTALLATION.md) for installation instructions
