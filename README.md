# @mcp-abap-adt/connection

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)

ABAP connection layer for MCP ABAP ADT server. Provides a unified interface for connecting to SAP ABAP systems via ADT (ABAP Development Tools) protocol, supporting both on-premise (Basic Auth) and cloud (JWT/OAuth2) authentication methods.

## Key Features

- 🔐 **Multiple Authentication Methods**: 
  - Basic Auth for on-premise SAP systems
  - JWT/OAuth2 for SAP BTP ABAP Environment
  - SAML session cookies for pre-authenticated enterprise flows
- 🔄 **Token Management**: 
  - Token refresh is handled by `@mcp-abap-adt/auth-broker` package
  - Connection package focuses on HTTP communication only
- 💾 **Session Management**: 
  - Session headers management (cookies, CSRF tokens)
  - Session state persistence is handled by `@mcp-abap-adt/auth-broker` package
- 🏗️ **Clean Architecture**:
  - One connector per SYSTEM (`AdtOnPremConnector`, `AdtCloudConnector`), handed an auth provider
  - Authentication is a parameter, not a subclass — nothing about the system is inferred from it
  - Proper separation of concerns - no JWT logic in base class
- 🔌 **Realtime Transport Scaffold**:
  - Generic `GenericWebSocketTransport` with pluggable WS factory
  - Reusable for debugger/traces and other event-driven flows
- 📝 **Custom Logging**: Pluggable logger interface for integration with any logging system
- 🛠️ **CLI Tool**: See [JWT Auth Tools](./docs/JWT_AUTH_TOOLS.md) for obtaining SAP BTP tokens
- 📦 **TypeScript**: Full TypeScript support with type definitions included
- ⚡ **Timeout Management**: Configurable timeouts for different operation types

## Architecture

The package uses a clean separation of concerns:

- **`AbstractAbapConnection`** (abstract, internal only):
  - Common HTTP request logic
  - Session lifecycle: `connect()` / `disconnect()`, admission, lock windows, teardown draining
  - Session management (cookies, CSRF tokens)
  - CSRF token fetching with retry
  - Auth-agnostic - knows nothing about Basic or JWT
  
- **`AdtOnPremConnector`** (concrete, exported):
  - An on-prem system: the session arrives with the establishing call, and the platform's
    ICF logoff is how it is given back
  - Takes an auth provider — basic, SAML, certificate, a bearer token, whatever you hold

- **`AdtCloudConnector`** (concrete, exported):
  - An ABAP Cloud system: a session is a resource, opened at
    `/sap/bc/adt/core/http/sessions` and given back by `DELETE` on the address it publishes
  - Takes an auth provider, same as above

  **Which one you take is how you say where you are dialling.** Nothing is probed:
  the session resource answers on on-prem too, and its `DELETE` there leaves the
  session open while the logoff removes it — so asking the server would pick the
  mechanism that releases nothing.

- **Auth providers** (`BasicAuthProvider`, `TokenAuthProvider`, `SamlAuthProvider`,
  `CertificateAuthProvider`):
  - What a connection authenticates with, passed in
  - A token provider renews on its own; the connector asks it per request and, on a
    `401`, tells it the answer was refused before asking again

- **Transports** (`HttpTransport`, `RfcTransport`):
  - What a request travels over, and everything that is true of that wire.
    `HttpTransport` keeps the cookie jar, the CSRF token and the affinity
    headers; `RfcTransport` translates into `SADT_REST_RFC_ENDPOINT` and keeps a
    conversation that IS the session
  - On-prem is where this is a real choice; ABAP Cloud has one wire and its
    connector takes no such parameter
  - `rfcConversationFrom(config)` builds what `RfcTransport` needs, deriving
    `ashost` and `sysnr` and loading the SDK only when a conversation opens

- **`GenericWebSocketTransport`** (concrete, exported):
  - Transport abstraction for realtime WS message flows
  - Pluggable factory, envelope-based send/receive
  - Intended for higher-level debugger/trace session orchestration

## Responsibilities and Design Principles

### Core Development Principle

**Interface-Only Communication**: This package follows a fundamental development principle: **all interactions with external dependencies happen ONLY through interfaces**. The code knows **NOTHING beyond what is defined in the interfaces**.

This means:
- Does not know about concrete implementation classes from other packages
- Does not know about internal data structures or methods not defined in interfaces
- Does not make assumptions about implementation behavior beyond interface contracts
- Does not access properties or methods not explicitly defined in interfaces

This principle ensures:
- **Loose coupling**: Connection classes are decoupled from concrete implementations in other packages
- **Flexibility**: New implementations can be added without modifying connection classes
- **Testability**: Easy to mock dependencies for testing
- **Maintainability**: Changes to implementations don't affect connection classes

### Package Responsibilities

This package is responsible for:

1. **HTTP communication with SAP systems**: Makes HTTP requests to SAP ABAP systems via ADT protocol
2. **Authentication handling**: Supports Basic Auth and JWT/OAuth2 authentication methods
3. **Session management**: Manages cookies, CSRF tokens, and session state
4. **Error handling**: Handles HTTP errors and connection issues

#### What This Package Does

- **Provides connection abstraction**: `AbapConnection` interface for interacting with SAP systems
- **Handles HTTP requests**: Makes requests to SAP ADT endpoints with proper headers and authentication
- **Manages sessions**: Handles cookies, CSRF tokens, and session state persistence

#### What This Package Does NOT Do

- **Does NOT obtain tokens**: Token acquisition is handled by `@mcp-abap-adt/auth-providers` and `@mcp-abap-adt/auth-broker`
- **Does NOT store tokens**: Token storage is handled by `@mcp-abap-adt/auth-stores`
- **Does NOT refresh tokens**: Token refresh is handled by `@mcp-abap-adt/auth-broker`
- **Does NOT orchestrate authentication**: Token lifecycle management is handled by `@mcp-abap-adt/auth-broker`
- **Does NOT know about destinations**: Destination-based authentication is handled by consumers
- **Does NOT handle OAuth2 flows**: OAuth2 flows are handled by token providers

### External Dependencies

This package interacts with external packages **ONLY through interfaces**:

- **Logger interface**: Uses `ILogger` interface for logging - does not know about concrete logger implementation
- **No direct dependencies on auth packages**: All token-related operations are handled through configuration (`SapConfig`) passed by consumers

## Documentation

- 📦 **[Installation Guide](./docs/INSTALLATION.md)** - Setup and installation instructions
- 📚 **[Usage Guide](./docs/USAGE.md)** - Detailed usage examples and API documentation
- 🚚 **[Migration to 6.0.0](./docs/MIGRATION-6.0.md)** - the factory and the per-credential classes are removed; RFC is a transport, not a class
- 🚚 **[Migration to 4.0.0](./docs/MIGRATION-4.0.md)** - a 401 refreshes the token, a 403 reaches you with the server's message; the synthesised "JWT token has expired" is gone
- 🚚 **[Migration: the explicit session lifecycle](./docs/MIGRATION-2.0.md)** - `connect()` is now required; start here if you are coming from 1.x
- 💡 **[Examples](./examples/)** - Working code examples

## Features

- 🔐 **Multiple Authentication Methods**: Basic Auth for on-premise systems, JWT/OAuth2 for SAP BTP ABAP Environment
- 💾 **Session Management**: Session headers management (cookies, CSRF tokens) for HTTP communication
- 📝 **Custom Logging**: Pluggable logger interface for integration with any logging system (optional)
- 📦 **TypeScript**: Full TypeScript support with type definitions included
- ⚡ **Timeout Management**: Configurable timeouts for different operation types
- 🌐 **Network Error Detection**: Automatic detection and proper handling of network-level errors (connection refused, timeout, DNS failures)

## Installation

```bash
npm install @mcp-abap-adt/connection
```

For detailed installation instructions, see [Installation Guide](./docs/INSTALLATION.md).

## Quick Start

### Basic Usage (On-Premise)

```typescript
import {
  AdtOnPremConnector,
  BasicAuthProvider,
  SapConfig,
} from "@mcp-abap-adt/connection";

const config: SapConfig = {
  url: "https://your-sap-system.com",
  client: "100",
  authType: "basic",
  username: "your-username",
  password: "your-password",
};

// Create a simple logger
const logger = {
  info: (msg: string, meta?: any) => console.log(msg, meta),
  error: (msg: string, meta?: any) => console.error(msg, meta),
  warn: (msg: string, meta?: any) => console.warn(msg, meta),
  debug: (msg: string, meta?: any) => console.debug(msg, meta),
};

// Which system you are dialling is the class you take; which credential it
// authenticates with is the object you hand it. Neither is detected.
const connection = new AdtOnPremConnector(
  config,
  new BasicAuthProvider(config.username!, config.password!),
  logger,
);
await connection.connect();   // required before any request

// Make ADT request
const response = await connection.makeAdtRequest({
  method: "GET",
  url: "/sap/bc/adt/programs/programs/your-program",
});
```

### Cloud Usage (JWT/OAuth2)

```typescript
import {
  AdtCloudConnector,
  SapConfig,
  TokenAuthProvider,
} from "@mcp-abap-adt/connection";

// JWT configuration
const config: SapConfig = {
  url: "https://your-instance.abap.cloud.sap",
  client: "100", // Optional
  authType: "jwt",
  jwtToken: "your-jwt-token-here", // Obtained via OAuth2 flow
};

const logger = {
  info: (msg: string, meta?: any) => console.log(msg, meta),
  error: (msg: string, meta?: any) => console.error(msg, meta),
  warn: (msg: string, meta?: any) => console.warn(msg, meta),
  debug: (msg: string, meta?: any) => console.debug(msg, meta),
};

// Logger is optional - if not provided, no logging output.
// A bare string is a token with nothing behind it. Hand `TokenAuthProvider` an
// `ITokenRefresher` instead and it checks expiry and renews on its own, which
// is what you want in anything long-lived.
const connection = new AdtCloudConnector(
  config,
  new TokenAuthProvider(config.jwtToken!),
  logger,
);
await connection.connect();

// Note: obtaining and refreshing tokens is @mcp-abap-adt/auth-broker's job
const response = await connection.makeAdtRequest({
  method: "GET",
  url: "/sap/bc/adt/programs/programs/your-program",
});
```

### On-Premise over RFC

The same ADT calls, over `SADT_REST_RFC_ENDPOINT` — the function module Eclipse
ADT itself uses through JCo — instead of over HTTP. Worth taking on a system
where stateful HTTP sessions are not usable: an RFC conversation is one ABAP
session for its whole lifetime, which is the way past `423 invalid lock handle`
on BASIS < 7.50.

Needs the SAP NW RFC SDK on the machine and `npm install @mcp-abap-adt/sap-rfc-lite`.

```typescript
import {
  AdtOnPremConnector,
  BasicAuthProvider,
  RfcTransport,
  rfcConversationFrom,
} from "@mcp-abap-adt/connection";

const connection = new AdtOnPremConnector(
  config,
  new BasicAuthProvider(config.username!, config.password!),
  logger,
  undefined,
  { transport: new RfcTransport(rfcConversationFrom(config), logger) },
);

await connection.connect();
// Everything above the wire is the same: makeAdtRequest, setSessionType,
// disconnect. What differs is where the session lives — see below.
```

**Where to look for it.** An HTTP session is an ICF session and appears in
**SM05**. An RFC conversation is a gateway client: it appears in **SMGW → Logged
on Clients** as `NWRFC`, and never in SM05, because there is no ICM in that
path. Looking for one in the other monitor and finding nothing is not a fault.

There is no cloud equivalent: ABAP Cloud has one wire, and `AdtCloudConnector`
takes no transport parameter at all.

### SSO Usage (SAML Session Cookies)

```typescript
import {
  AdtOnPremConnector,
  SamlAuthProvider,
  SapConfig,
} from "@mcp-abap-adt/connection";

const config: SapConfig = {
  url: "https://your-sap-system.com",
  authType: "saml",
  sessionCookies: "MYSAPSSO2=...; SAP_SESSIONID=...",
};

// The cookies ARE the credential here — there is no Authorization header at all.
const connection = new AdtOnPremConnector(
  config,
  new SamlAuthProvider(config.sessionCookies!),
  logger,
);
await connection.connect();

const response = await connection.makeAdtRequest({
  method: "GET",
  url: "/sap/bc/adt/programs/programs/your-program",
});
```

### Cloud Usage with Automatic Token Refresh

For automatic token refresh on **401** errors, inject `ITokenRefresher`:

```typescript
import {
  AdtCloudConnector,
  TokenAuthProvider,
  SapConfig,
} from "@mcp-abap-adt/connection";
import type { ITokenRefresher } from "@mcp-abap-adt/interfaces";

// Token refresher provides token acquisition and refresh
// (created by @mcp-abap-adt/auth-broker or custom implementation)
const tokenRefresher: ITokenRefresher = {
  getToken: async () => { /* return current token */ },
  refreshToken: async () => { /* refresh and return new token */ },
};

const config: SapConfig = {
  url: "https://your-instance.abap.cloud.sap",
  authType: "jwt",
};

// The connector says which SYSTEM this is; the provider says how to
// authenticate. Neither decides the other.
const connection = new AdtCloudConnector(
  config,
  new TokenAuthProvider(tokenRefresher),
  logger,
);
await connection.connect();

// On a 401 the connector tells the provider its token was refused, asks again,
// and only if the answer changed rebuilds the session and retries once. An
// unchanged answer means the server refused these credentials, and the 401
// reaches you. A refresh replaces the SAP session, so if a lock window is open
// the request fails with ADT_SESSION_REPLACED rather than continuing on a
// session your lock is not in.
const response = await connection.makeAdtRequest({
  method: "GET",
  url: "/sap/bc/adt/programs/programs/your-program",
});
```

**A 403 is never treated as an expired token.** It means the server
authenticated the caller and refused the action anyway, so no credential can
change the answer. It propagates unchanged — `error.response.status` and the
server's message, which usually names the authorization object — rather than
being reported as an expired token.

Earlier versions reported both 401 and 403 as
`JWT token has expired. Please re-authenticate.` and discarded the original
error. Code matching on that message must branch on `error.response.status`
instead — which it can now do, since the status is no longer thrown away.
See [MIGRATION-4.0.md](./docs/MIGRATION-4.0.md).

### Stateful Sessions

For operations that require session state (e.g., object modifications), you can enable stateful sessions:

```typescript
import {
  AdtOnPremConnector,
  BasicAuthProvider,
} from "@mcp-abap-adt/connection";

const connection = new AdtOnPremConnector(
  config,
  new BasicAuthProvider(config.username!, config.password!),
  logger,
);
await connection.connect();

// Enable stateful session mode (adds x-sap-adt-sessiontype: stateful header)
connection.setSessionType("stateful");

// Make requests - SAP will maintain session state
await connection.makeAdtRequest({
  method: "POST",
  url: "/sap/bc/adt/objects/domains",
  data: { /* domain data */ },
});

// Note: Session state persistence is handled by @mcp-abap-adt/auth-broker package
```

### Custom Logger

```typescript
import { ILogger } from "@mcp-abap-adt/connection";

class MyLogger implements ILogger {
  info(message: string, meta?: any): void {
    // Your logging implementation
  }

  error(message: string, meta?: any): void {
    // Your logging implementation
  }

  warn(message: string, meta?: any): void {
    // Your logging implementation
  }

  debug(message: string, meta?: any): void {
    // Your logging implementation
  }

  csrfToken(action: "fetch" | "retry" | "success" | "error", message: string, meta?: any): void {
    // CSRF token specific logging
  }

  tlsConfig(rejectUnauthorized: boolean): void {
    // TLS configuration logging
  }
}

const logger = new MyLogger();
const connection = new AdtOnPremConnector(
  config,
  new BasicAuthProvider(config.username!, config.password!),
  logger,
);
```

## CLI Tool

The package includes a CLI tool for authenticating with SAP BTP using service keys:

### Installation Options

- **Local project install**
  ```bash
  npm install @mcp-abap-adt/connection --save-dev
  npx sap-abap-auth auth -k path/to/service-key.json
  ```
- **Global install**
  ```bash
  npm install -g @mcp-abap-adt/connection
  sap-abap-auth auth -k path/to/service-key.json
  ```
- **On-demand (npx)**
  ```bash
  npx @mcp-abap-adt/connection sap-abap-auth auth -k path/to/service-key.json
  ```

### Usage

```bash
# Show help
sap-abap-auth --help

# Authenticate with service key
sap-abap-auth auth -k service-key.json

# Specify browser
sap-abap-auth auth -k service-key.json --browser chrome

# Custom output file
sap-abap-auth auth -k service-key.json --output .env.production
```

### Options

- `-k, --key <path>` - Path to service key JSON file (required)
- `-b, --browser <name>` - Browser to open (chrome, edge, firefox, system, none)
- `-o, --output <path>` - Path to output .env file (default: .env)
- `-h, --help` - Show help message

### Using via `npx` (without global install)

If `@mcp-abap-adt/connection` is listed as a dependency in your project, you can invoke the CLI directly:

```bash
npx sap-abap-auth auth -k service-key.json
```

This works even when you do not install the package globally. For one-off usage, you can also run:

```bash
npx @mcp-abap-adt/connection sap-abap-auth auth -k service-key.json
```

This will download the package on demand and execute the CLI.
## API Reference

### Types

#### `SapConfig`

Configuration for SAP ABAP connection.

```typescript
type SapConfig = {
  url: string;
  client?: string;
  authType: "basic" | "jwt" | "saml";
  // For basic auth
  username?: string;
  password?: string;
  // For JWT auth
  jwtToken?: string;
  // For SAML session cookies
  sessionCookies?: string;
};
```

#### `AbapConnection`

Main interface for ABAP connections.

```typescript
// The shared contract (IAbapConnection), what every connection provides:
interface AbapConnection {
  connect(): Promise<void>; // REQUIRED before any request; rejects on failure
  makeAdtRequest(options: AbapRequestOptions): Promise<AxiosResponse>;
  getBaseUrl(): Promise<string>;
  setSessionType(type: "stateless" | "stateful"): void; // Switch session type
  getSessionId(): string | null; // Client-side conversation id
}
```

The connectors carry the rest of the session lifecycle. It is on the shared
contract as a **capability atom** in `@mcp-abap-adt/interfaces` rather than as
methods on `IAbapConnection`, so a consumer that only carries requests is
unaffected by its existence. Note that a connection over RFC has the whole of it
— what an RFC conversation has none of is a session RESOURCE to open and close
by address, which is an empty mechanism, not an absent lifecycle:

```typescript
// ISessionLifecycleAware
disconnect(): Promise<void>;         // never throws, and waits for nothing
isConnected(): boolean;
getSessionIdentity(): string | null; // WHICH SAP session; null is not "disconnected"
```

Import those names from `@mcp-abap-adt/interfaces`, not from this package: a
contract type re-exported under a second name is a contract type that can drift.

**The connection does not track locks.** Deciding when to disconnect, and
preparing for it, belongs to the caller; pairing every LOCK with its UNLOCK
belongs to `@mcp-abap-adt/adt-clients`, which holds the handles. What this layer
owns is not being interrupted by a timeout mid-operation — see
`beginCriticalSection()` below.

See [docs/USAGE.md — Session Lifecycle](./docs/USAGE.md#session-lifecycle).

**Session Management:**
- `setSessionType(type)`: Programmatically switch between stateful and stateless modes *(on the contract)*
- `getSessionId()`: Returns the client-side conversation id, an auto-generated UUID *(on the contract)*
- `getSessionMode()`: Returns current session mode *(HTTP classes only)*

#### `ILogger`

Logger interface for custom logging implementations.

```typescript
interface ILogger {
  info(message: string, meta?: any): void;
  error(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
  debug(message: string, meta?: any): void;
  csrfToken?(action: "fetch" | "retry" | "success" | "error", message: string, meta?: any): void;
  tlsConfig?(rejectUnauthorized: boolean): void;
}
```

### Functions

#### `rfcConversationFrom(config)`

What `RfcTransport` is constructed with. Derives `ashost` from the url and
`sysnr` from the HTTP port by the SAP convention that `80XX` is the ICM port for
system `XX`, which `SAP_SYSNR` overrides for a port that follows no convention.

The SAP NW RFC SDK is loaded when a conversation opens, not when this is called,
so a machine without it fails at `connect()` with a message saying what to
install rather than at construction.

```typescript
function rfcConversationFrom(config: SapConfig): () => IRfcConversation;
function rfcParamsFrom(config: SapConfig): RfcConnectionParams;
```

```typescript
import {
  AdtOnPremConnector,
  BasicAuthProvider,
  RfcTransport,
  rfcConversationFrom,
} from "@mcp-abap-adt/connection";

const connection = new AdtOnPremConnector(
  config,
  new BasicAuthProvider(config.username!, config.password!),
  logger,
  undefined,
  { transport: new RfcTransport(rfcConversationFrom(config), logger) },
);
```

#### `CSRF_CONFIG` and `CSRF_ERROR_MESSAGES`

**New in 0.1.13+:** Exported constants for consistent CSRF token handling across different connection implementations.

```typescript
import { CSRF_CONFIG, CSRF_ERROR_MESSAGES } from '@mcp-abap-adt/connection';

// CSRF_CONFIG contains:
// - RETRY_COUNT: number (default: 3)
// - RETRY_DELAY: number (default: 1000ms)
// - ENDPOINT: string (default: '/sap/bc/adt/core/discovery')
// - REQUIRED_HEADERS: { 'x-csrf-token': 'fetch', 'Accept': 'application/atomsvc+xml' }

// CSRF_ERROR_MESSAGES contains:
// - FETCH_FAILED(attempts: number, cause: string): string
// - NOT_IN_HEADERS: string
// - REQUIRED_FOR_MUTATION: string
```

**Use case:** When implementing custom connection classes (e.g., Cloud SDK-based), you can use these constants to ensure consistent CSRF token handling:

```typescript
import { CSRF_CONFIG, CSRF_ERROR_MESSAGES } from '@mcp-abap-adt/connection';

async function fetchCsrfToken(baseUrl: string): Promise<string> {
  const csrfUrl = `${baseUrl}${CSRF_CONFIG.ENDPOINT}`;
  
  for (let attempt = 0; attempt <= CSRF_CONFIG.RETRY_COUNT; attempt++) {
    try {
      const response = await yourHttpClient.get(csrfUrl, {
        headers: CSRF_CONFIG.REQUIRED_HEADERS
      });
      
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
}
```


## Requirements

- Node.js >= 18.0.0
- Access to SAP ABAP system (on-premise or BTP)

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for detailed version history and breaking changes.

**Version history:** [CHANGELOG.md](./CHANGELOG.md)
- Removed token refresh functionality (handled by `@mcp-abap-adt/auth-broker`)
- Removed session storage functionality (handled by `@mcp-abap-adt/auth-broker`)
- Logger is now optional
- See [CHANGELOG.md](./CHANGELOG.md) for full details

## Documentation

- [Examples](./examples/README.md) - Working code examples
- [Changelog](./CHANGELOG.md) - Version history and release notes

## License

MIT

## Repository

https://github.com/fr0ster/mcp-abap-adt

## Related Projects

- [mcp-abap-adt](https://github.com/fr0ster/mcp-abap-adt) - Main MCP server for ABAP ADT
