# Connection Examples

This directory contains example code demonstrating how to use the `@mcp-abap-adt/connection` package.

## Running Examples

```bash
# From packages/connection directory
node examples/custom-session-storage.js
```

## Available Examples

### custom-session-storage.js

Demonstrates how to use `getSessionState()` and `setSessionState()` methods to implement custom session persistence.

**Use cases:**
- Store sessions in database (MongoDB, PostgreSQL, etc.)
- Store sessions in Redis/Memcached
- Store sessions in cloud storage
- Implement custom session lifecycle management

**What it shows:**
1. Making a request and capturing session state with `getSessionState()`
2. Storing session state in custom storage (in-memory example)
3. Creating a new connection and restoring session with `setSessionState()`
4. Making requests with restored session

## Configuration

Examples can be configured via environment variables:

```bash
# Set environment variables
export SAP_URL=https://your-sap-system.com
export SAP_USERNAME=your_username
export SAP_PASSWORD=your_password

# Or use .env file in adt-clients package
# Examples will try to load ../adt-clients/.env
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
