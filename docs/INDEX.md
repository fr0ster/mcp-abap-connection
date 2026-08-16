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
│   ├── MIGRATION-4.0.md            # JWT error classification: 401 refreshes, 403 propagates
│   ├── SCOPE.md                    # What this package does and does not own
│   ├── STATEFUL_SESSION_GUIDE.md   # Stateful requests and lock windows
│   └── JWT_AUTH_TOOLS.md           # CLI tool for authentication
├── examples/               # Working code examples
│   ├── README.md          # Examples overview
│   └── basic-connection.js # Simple connection example
├── bin/                   # CLI tools
│   └── sap-abap-auth.js  # JWT authentication CLI
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

### Core Features
- 🔑 [JWT Auth Tools](./JWT_AUTH_TOOLS.md) - CLI tool for browser-based authentication

### Upgrading
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
- **CLI Tool**: [JWT_AUTH_TOOLS.md](./JWT_AUTH_TOOLS.md)

### Session Management
- **Overview**: [USAGE.md - Session Management](./USAGE.md#session-management)
- **Stateful Mode**: Use `setSessionType('stateful')` for session headers
- **Session State Persistence**: Handled by `@mcp-abap-adt/auth-broker` package
- **API Methods**:
  - `getSessionId()` - Get current session ID (auto-generated UUID)
  - `setSessionType()` - Switch between stateful/stateless modes

### API Reference
- **Connection Interface**: [USAGE.md - API Reference](./USAGE.md#api-reference)
- **Configuration Types**: [USAGE.md - Configuration Types](./USAGE.md#configuration-types)
- **Factory Function**: `createAbapConnection()`
- **Connection Classes**: `BaseAbapConnection`, `JwtAbapConnection`

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
