# Documentation Index

**Package:** `@mcp-abap-adt/connection`  
**Version:** see [CHANGELOG.md](../CHANGELOG.md) — kept there rather than
duplicated here, where it went stale by eight minor versions.

## Package Structure

```
mcp-abap-connection/
├── README.md                 # Main package documentation
├── CHANGELOG.md             # Version history and changes
├── docs/                    # Detailed documentation
│   ├── INDEX.md                    # This file - documentation overview
│   ├── INSTALLATION.md             # Setup and installation guide
│   ├── USAGE.md                    # API documentation and examples
│   ├── MIGRATION-2.0.md            # Moving to the explicit session lifecycle
│   ├── MIGRATION-14.0.md           # the sap-abap-auth CLI, open and commander are removed
│   ├── MIGRATION-13.0.md           # interfaces-auth 7, auth-errors 2, auth-providers 6.0.0; no behaviour change
│   ├── MIGRATION-12.0.md           # refusals follow the auth error contract (interfaces-auth 6, auth-errors)
│   ├── MIGRATION-11.0.md           # the server certificate is verified by default
│   ├── MIGRATION-10.0.md           # providers move to auth-providers; IAuthProvider 3.0; AuthRefusedError
│   ├── MIGRATION-9.0.md            # the contracts split out of @mcp-abap-adt/interfaces
│   ├── MIGRATION-8.0.md            # request headers leave the stateful branch; onto interfaces 39; flushGoodbye
│   ├── MIGRATION-6.0.md            # the factory and the per-credential classes go; RFC is a transport
│   ├── MIGRATION-4.0.md            # JWT error classification: 401 refreshes, 403 propagates
│   ├── SCOPE.md                    # What this package does and does not own
│   └── STATEFUL_SESSION_GUIDE.md   # Stateful requests and lock windows
├── examples/               # Working code examples
│   ├── README.md          # Examples overview
│   └── basic-connection.js # Simple connection example
└── src/                  # Source code
    ├── connection/       # Connection classes
    ├── config/          # Configuration utilities
    ├── utils/           # Helper functions
    └── __tests__/       # Unit tests
```

## Quick Links

### Getting Started
- 📦 [Installation Guide](./INSTALLATION.md) - How to install and set up the package
- 📚 [Usage Guide](./USAGE.md) - Basic usage and comprehensive API documentation
- 📖 [Main README](../README.md) - Package overview and quick start
- 🧭 [Scope and Boundaries](./SCOPE.md) - What this package does (and does not), sibling packages, and why there is no RFC to cloud

### Upgrading
- 🚚 [Migrating to 14.0.0](./MIGRATION-14.0.md) - the `sap-abap-auth` CLI is removed; use `@mcp-abap-adt/auth-broker-cli`
- 🚚 [Migrating to 13.0.0](./MIGRATION-13.0.md) - interfaces-auth 7 and auth-errors 2; the connection's behaviour is unchanged, a consumer holds one interfaces-auth major and takes the providers from auth-providers 6.0.0
- 🚚 [Migrating to 12.0.0](./MIGRATION-12.0.md) - refusals follow the auth error contract: `AuthRefusedError.refusal` is an `IAuthProviderError` (read its `kind`), a custom `ILogonTarget` mints its refusal through `@mcp-abap-adt/auth-errors`, and no auth-providers release fits 12.x — auth-providers 6.0.0 goes with 13.0.0
- 🚚 [Migrating to 11.0.0](./MIGRATION-11.0.md) - the server certificate is verified by default; trust a self-signed system with `agentOptions.ca`, or opt out explicitly with `TLS_REJECT_UNAUTHORIZED=0`
- 🚚 [Migrating to 10.0.0](./MIGRATION-10.0.md) - the credential providers moved to `@mcp-abap-adt/auth-providers`; the connection speaks `IAuthProvider` 3.0 and raises `AuthRefusedError`; the RFC factory takes the logon parameters
- 🚚 [Migrating to 9.0.0](./MIGRATION-9.0.md) - the contracts split into `interfaces-adt`, `-auth`, `-network` and `-utils`, and this package stopped depending on the umbrella; `interfaces-auth-sap` joined them in the release after, when authentication split into what is SAP's and what is not
- 🚚 [Migrating to 7.0.0 and 8.0.0](./MIGRATION-8.0.md) - `sap-adt-request-id` and `X-sap-adt-profiling` on every request, `x-sap-security-session: use` on cloud, the contracts floor at 39, and `flushGoodbye()`
- 🚚 [Migrating to 6.0.0](./MIGRATION-6.0.md) - the factory and the per-credential classes are removed; the RFC wire is a transport you hand to the on-prem connector
- 🧱 [Migrating to 4.0.0](./MIGRATION-4.0.md) - JWT error classification: a 401 refreshes, a 403 propagates with the server's message
- 🧱 [Migrating to 2.0.0](./MIGRATION-2.0.md) - The explicit session lifecycle: `connect()` is required

### Version Information
- 📋 [CHANGELOG](../CHANGELOG.md) - Complete version history, including what the latest release changed

### Examples
- 📁 [Examples Overview](../examples/README.md) - All available examples
- 🔌 [Basic Connection](../examples/basic-connection.js) - Simple connection setup

## Documentation by Topic

### Authentication
- **Basic Auth**: [USAGE.md - Basic Authentication](./USAGE.md#basic-authentication-on-premise)
- **JWT/OAuth2**: [USAGE.md - JWT Authentication](./USAGE.md#jwt-authentication-cloudbtp)
- **Token Refresh**: Handled by `@mcp-abap-adt/auth-broker` package (removed in 0.2.0)
- **Obtaining tokens**: `@mcp-abap-adt/auth-broker-cli` (the CLI formerly bundled here was removed in 14.0.0)

### Session Management
- **Overview**: [USAGE.md - Session Management](./USAGE.md#session-management)
- **Stateful Mode**: Use `setSessionType('stateful')` for the LOCK / UNLOCK context; use stateless mode for GET / PUT
- **Session State Persistence**: Handled by `@mcp-abap-adt/auth-broker` package
- **API Methods**:
  - `getSessionId()` - Get current session ID (auto-generated UUID)
  - `setSessionType()` - Switch between stateful/stateless modes

### API Reference
- **Connection Interface**: [USAGE.md - API Reference](./USAGE.md#api-reference)
- **Configuration Types**: [USAGE.md - Configuration Types](./USAGE.md#configuration-types)
- **Connectors**: `AdtOnPremConnector`, `AdtCloudConnector`
- **Credentials**: an `IAuthProvider` (`@mcp-abap-adt/interfaces-auth`); the ready-made providers live in `@mcp-abap-adt/auth-providers` (6.0.0 with connection 13.x and 14.x)
- **Errors**: `AuthRefusedError` (its `refusal` an `IAuthProviderError` minted by `@mcp-abap-adt/auth-errors`), `WireLogonError`
- **Transports**: `HttpTransport`, `RfcTransport` (+ `rfcConversationFrom()`)

## Version Highlights

See [CHANGELOG.md](../CHANGELOG.md). This section used to restate it and drifted
eight minor versions behind — a second copy of a changelog is a changelog that
is wrong.

## Documentation Standards

### File Organization
- **README.md** - Package overview, quick start, basic API
- **CHANGELOG.md** - All changes, following [Keep a Changelog](https://keepachangelog.com/)
- **docs/** - Detailed documentation, tutorials, guides
- **examples/** - Working code examples with README

### Naming Conventions
- `UPPERCASE.md` - Main documentation files (README, CHANGELOG)
- `PascalCase.md` - Detailed guides in docs/ folder
- `kebab-case.js` - Example files

### Content Guidelines
- Keep README concise, link to detailed docs
- Include working code examples
- Document environment variables and configuration
- Provide troubleshooting sections
- Show both success and error handling

## Contributing Documentation

When adding new features:
1. Update CHANGELOG.md with changes
2. Add usage examples to USAGE.md
3. Create working examples in examples/
4. Update README.md if API changes
5. Add troubleshooting to relevant guide
