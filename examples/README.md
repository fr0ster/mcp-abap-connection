# Connection Examples

This directory contains example code demonstrating how to use the `@mcp-abap-adt/connection` package.

## Prerequisites

```bash
# Install dependencies
cd packages/connection
npm install

# Build the package
npm run build

# Set up environment variables
cp .env.example .env
# Edit .env with your SAP credentials
```

## Available Examples

### basic-connection.js

Simple example showing how to connect to SAP and make an ADT request.

```bash
node examples/basic-connection.js
```

**What it demonstrates:**
- Creating connection with factory function
- Connecting to SAP system
- Making GET request to ADT endpoint
- Basic error handling

### jwt-with-token-refresh.js

Shows how to use `ITokenRefresher` for automatic token refresh.

```bash
node examples/jwt-with-token-refresh.js
```

**What it demonstrates:**
- Creating connection with token refresher injection
- Automatic token refresh on 401 errors
- Retry logic with refreshed token
- A 403 propagating untouched, with its status and body intact

### saml-connection.js

Shows how to use cookie-based SAML connection.

```bash
node examples/saml-connection.js
```

**What it demonstrates:**
- Creating SAML connection via factory (`authType: "saml"`)
- Using `sessionCookies` from environment
- Fetching CSRF token and making ADT request with cookie auth

### websocket-transport.js

Shows how to use `GenericWebSocketTransport` with injected WS factory.

```bash
node examples/websocket-transport.js
```

**What it demonstrates:**
- Creating `GenericWebSocketTransport`
- Registering `onOpen`, `onMessage`, `onError`, `onClose` handlers
- Sending `IWebSocketMessageEnvelope` payload
- Connecting/disconnecting transport lifecycle

## Configuration

### Using .env file

Create `.env` in project root:

```bash
# Basic Auth
SAP_URL=https://your-sap-system.com
SAP_AUTH_TYPE=basic
SAP_USERNAME=your_username
SAP_PASSWORD=your_password
SAP_CLIENT=100

# JWT Auth (Cloud/BTP)
SAP_AUTH_TYPE=jwt
SAP_JWT_TOKEN=eyJhbGciOiJSUzI1NiIs...
# Note: Token refresh is handled by @mcp-abap-adt/auth-broker package

# SAML Auth (Cookie-based)
SAP_AUTH_TYPE=saml
SAP_SESSION_COOKIES=sap-usercontext=sap-client=100; sap-contextid=...
```

### Using Environment Variables

```bash
export SAP_URL=https://your-sap-system.com
export SAP_USERNAME=your_username
export SAP_PASSWORD=your_password
node examples/basic-connection.js
```

## See Also

- [Connection README](../README.md) - Main package documentation
- [Session Lifecycle](../docs/USAGE.md#session-lifecycle) - connect/disconnect, lock windows, a lost session
