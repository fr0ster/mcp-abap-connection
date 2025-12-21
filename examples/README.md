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
- Automatic token refresh on 401/403 errors
- Retry logic with refreshed token

### custom-session-storage.js

Advanced example showing custom session persistence implementation.

```bash
node examples/custom-session-storage.js
```

**What it demonstrates:**
- Using `getSessionState()` and `setSessionState()` methods
- Implementing custom session storage (in-memory, database, Redis, etc.)
- Session lifecycle management
- Restoring sessions across connections

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
```

### Using Environment Variables

```bash
export SAP_URL=https://your-sap-system.com
export SAP_USERNAME=your_username
export SAP_PASSWORD=your_password
node examples/basic-connection.js
```

## Session State Structure

The session state returned by `getSessionState()` is a plain JSON object:

```json
{
  "cookies": "sap-usercontext=sap-client=100; sap-XSRF_TRL_100=...; sap-contextid=...",
  "csrfToken": "abc123...",
  "cookieStore": {
    "sap-usercontext": "sap-client=100",
    "sap-XSRF_TRL_100": "...",
    "sap-contextid": "..."
  }
}
```

You can serialize this to JSON, store it anywhere, and later restore it with `setSessionState()`.

## See Also

- [Connection README](../README.md) - Main package documentation
- [Custom Session Storage Guide](../CUSTOM_SESSION_STORAGE.md) - Detailed guide with more examples
