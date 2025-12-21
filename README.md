# @mcp-abap-adt/connection

ABAP connection layer for MCP ABAP ADT server. Provides a unified interface for connecting to SAP ABAP systems via ADT (ABAP Development Tools) protocol, supporting both on-premise (Basic Auth) and cloud (JWT/OAuth2) authentication methods.

## Key Features

- 🔐 **Multiple Authentication Methods**: 
  - Basic Auth for on-premise SAP systems
  - JWT/OAuth2 for SAP BTP ABAP Environment
- 🔄 **Token Management**: 
  - Token refresh is handled by `@mcp-abap-adt/auth-broker` package
  - Connection package focuses on HTTP communication only
- 💾 **Session Management**: 
  - Session headers management (cookies, CSRF tokens)
  - Session state persistence is handled by `@mcp-abap-adt/auth-broker` package
- 🏗️ **Clean Architecture**:
  - Abstract base class for common HTTP/session logic
  - Auth-type specific implementations (BaseAbapConnection, JwtAbapConnection)
  - Proper separation of concerns - no JWT logic in base class
- 📝 **Custom Logging**: Pluggable logger interface for integration with any logging system
- 🛠️ **CLI Tool**: See [JWT Auth Tools](./docs/JWT_AUTH_TOOLS.md) for obtaining SAP BTP tokens
- 📦 **TypeScript**: Full TypeScript support with type definitions included
- ⚡ **Timeout Management**: Configurable timeouts for different operation types

## Architecture

The package uses a clean separation of concerns:

- **`AbstractAbapConnection`** (abstract, internal only):
  - Common HTTP request logic
  - Session management (cookies, CSRF tokens)
  - CSRF token fetching with retry
  - Auth-agnostic - knows nothing about Basic or JWT
  
- **`BaseAbapConnection`** (concrete, exported):
  - Basic Authentication implementation
  - Simple connect() - fetches CSRF token
  - Suitable for on-premise SAP systems
  
- **`JwtAbapConnection`** (concrete, exported):
  - JWT/OAuth2 Authentication implementation
  - Simple connect() - establishes connection with JWT token
  - Suitable for SAP BTP ABAP Environment
  - Token refresh handled by auth-broker package

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
import { createAbapConnection, SapConfig } from "@mcp-abap-adt/connection";

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

// Create connection
const connection = createAbapConnection(config, logger);

// Make ADT request
const response = await connection.makeAdtRequest({
  method: "GET",
  url: "/sap/bc/adt/programs/programs/your-program",
});
```

### Cloud Usage (JWT/OAuth2)

```typescript
import { createAbapConnection, SapConfig } from "@mcp-abap-adt/connection";

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

// Logger is optional - if not provided, no logging output
const connection = createAbapConnection(config, logger);

// Note: Token refresh is handled by @mcp-abap-adt/auth-broker package
const response = await connection.makeAdtRequest({
  method: "GET",
  url: "/sap/bc/adt/programs/programs/your-program",
});
```

### Cloud Usage with Automatic Token Refresh

For automatic token refresh on 401/403 errors, inject `ITokenRefresher`:

```typescript
import { JwtAbapConnection, SapConfig } from "@mcp-abap-adt/connection";
import type { ITokenRefresher } from "@mcp-abap-adt/interfaces";

// Token refresher provides token acquisition and refresh
// (created by @mcp-abap-adt/auth-broker or custom implementation)
const tokenRefresher: ITokenRefresher = {
  getToken: async () => { /* return current token */ },
  refreshToken: async () => { /* refresh and return new token */ },
};

// JWT configuration
const config: SapConfig = {
  url: "https://your-instance.abap.cloud.sap",
  authType: "jwt",
  jwtToken: await tokenRefresher.getToken(), // Get initial token
};

// Create connection with token refresher - 401/403 handled automatically
const connection = new JwtAbapConnection(config, logger, undefined, tokenRefresher);

// Requests automatically retry with refreshed token on auth errors
const response = await connection.makeAdtRequest({
  method: "GET",
  url: "/sap/bc/adt/programs/programs/your-program",
});
```

### Stateful Sessions

For operations that require session state (e.g., object modifications), you can enable stateful sessions:

```typescript
import { createAbapConnection } from "@mcp-abap-adt/connection";

const connection = createAbapConnection(config, logger);

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
const connection = createAbapConnection(config, logger);
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
  authType: "basic" | "jwt";
  // For basic auth
  username?: string;
  password?: string;
  // For JWT auth
  jwtToken?: string;
};
```

#### `AbapConnection`

Main interface for ABAP connections.

```typescript
interface AbapConnection {
  makeAdtRequest(options: AbapRequestOptions): Promise<AxiosResponse>;
  reset(): void;
  setSessionType(type: "stateless" | "stateful"): void; // Switch session type
  getSessionMode(): "stateless" | "stateful"; // Get current session mode
  getSessionId(): string | null; // Get current session ID
}
```

**Session Management:**
- `setSessionType(type)`: Programmatically switch between stateful and stateless modes
- `getSessionMode()`: Returns current session mode
- `getSessionId()`: Returns the current session ID (auto-generated UUID)

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

#### `createAbapConnection(config, logger?, sessionId?)`

Factory function to create an ABAP connection instance.

```typescript
function createAbapConnection(
  config: SapConfig,
  logger?: ILogger | null,
  sessionId?: string
): AbapConnection;
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

See [PR Proposal](./PR_PROPOSAL_CSRF_CONFIG.md) for more details.

## Requirements

- Node.js >= 18.0.0
- Access to SAP ABAP system (on-premise or BTP)

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for detailed version history and breaking changes.

**Latest version: 0.2.0**
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

