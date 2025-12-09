# Documentation Index

**Package:** `@mcp-abap-adt/connection`  
**Version:** 0.2.0  
**Last Updated:** December 8, 2025

## Package Structure

```
mcp-abap-connection/
├── README.md                 # Main package documentation
├── CHANGELOG.md             # Version history and changes
├── docs/                    # Detailed documentation
│   ├── INDEX.md            # This file - documentation overview
│   ├── INSTALLATION.md     # Setup and installation guide
│   ├── USAGE.md            # API documentation and examples
│   └── JWT_AUTH_TOOLS.md   # CLI tool for authentication
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

### Core Features
- 🔑 [JWT Auth Tools](./JWT_AUTH_TOOLS.md) - CLI tool for browser-based authentication

### Version Information
- 📋 [CHANGELOG](../CHANGELOG.md) - Complete version history (0.1.0 - 0.2.0)
- 🆕 [Latest Changes (0.2.0)](../CHANGELOG.md#020---2025-12-08) - Breaking changes: token refresh and session storage removed

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

### 0.2.0 (Current) - 2025-12-08
- ⚠️ **Breaking Changes**: Token refresh and session storage removed
- 🔄 Token refresh moved to `@mcp-abap-adt/auth-broker` package
- 💾 Session state persistence moved to `@mcp-abap-adt/auth-broker` package
- 📝 Logger is now optional (uses optional chaining)
- 🎯 Package now focuses solely on HTTP connection management

### 0.1.9 - 2025-11-23
- 📝 Comprehensive documentation updates
- 📚 Enhanced README with new API methods
- 📋 Complete CHANGELOG with all versions
- 🔗 Fixed documentation structure and links

### 0.1.8 - 2025-01-23
- 🆕 Session management improvements
- ➕ `getSessionId()` method
- ➕ `setSessionType()` method
- 🔧 Base URL handling refactoring

### 0.1.6 - 2025-01-21
- ➕ Added `getSessionId()` and `setSessionType()` API methods
- 🎛️ Enhanced session control

### 0.1.4 - 2025-01-19
- 🤖 Automatic session ID generation
- 💡 No manual session ID required

### 0.1.0 - 2024-11-14
- 🎉 Initial release
- 🔐 Basic Auth and JWT/OAuth2 support
- 🛠️ CLI tool for authentication

See [CHANGELOG.md](../CHANGELOG.md) for complete version history.

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
