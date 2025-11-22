# Documentation Index

**Package:** `@mcp-abap-adt/connection`  
**Version:** 0.1.9  
**Last Updated:** November 23, 2025

## Package Structure

```
mcp-abap-connection/
├── README.md                 # Main package documentation
├── CHANGELOG.md             # Version history and changes
├── docs/                    # Detailed documentation
│   ├── INDEX.md            # This file - documentation overview
│   ├── INSTALLATION.md     # Setup and installation guide
│   ├── USAGE.md            # API documentation and examples
│   ├── AUTO_REFRESH_TESTING.md     # Testing guide for JWT auto-refresh
│   ├── CUSTOM_SESSION_STORAGE.md   # Session storage implementation
│   ├── STATEFUL_SESSION_GUIDE.md   # Session state management guide
│   └── JWT_AUTH_TOOLS.md   # CLI tool for authentication
├── examples/               # Working code examples
│   ├── README.md          # Examples overview
│   ├── basic-connection.js # Simple connection example
│   ├── auto-refresh.js    # JWT auto-refresh demo
│   └── session-persistence.js # FileSessionStorage usage
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
- 🔄 [Auto-Refresh Testing](./AUTO_REFRESH_TESTING.md) - JWT token auto-refresh functionality
- 💾 [Custom Session Storage](./CUSTOM_SESSION_STORAGE.md) - Implementing custom session persistence
- 🔐 [Stateful Session Guide](./STATEFUL_SESSION_GUIDE.md) - HTTP-level session state management
- 🔑 [JWT Auth Tools](./JWT_AUTH_TOOLS.md) - CLI tool for browser-based authentication

### Version Information
- 📋 [CHANGELOG](../CHANGELOG.md) - Complete version history (0.1.0 - 0.1.9)
- 🆕 [Latest Changes (0.1.9)](../CHANGELOG.md#019---2025-11-23) - Documentation updates

### Examples
- 📁 [Examples Overview](../examples/README.md) - All available examples
- 🔌 [Basic Connection](../examples/basic-connection.js) - Simple connection setup
- 🔄 [Auto-Refresh](../examples/auto-refresh.js) - JWT token auto-refresh
- 💾 [Session Persistence](../examples/session-persistence.js) - FileSessionStorage usage

## Documentation by Topic

### Authentication
- **Basic Auth**: [USAGE.md - Basic Authentication](./USAGE.md#basic-authentication-on-premise)
- **JWT/OAuth2**: [USAGE.md - JWT Authentication](./USAGE.md#jwt-authentication-cloudbtp)
- **Auto-Refresh**: [AUTO_REFRESH_TESTING.md](./AUTO_REFRESH_TESTING.md)
- **CLI Tool**: [JWT_AUTH_TOOLS.md](./JWT_AUTH_TOOLS.md)

### Session Management
- **Overview**: [USAGE.md - Session Management](./USAGE.md#session-management)
- **Stateful Sessions**: [STATEFUL_SESSION_GUIDE.md](./STATEFUL_SESSION_GUIDE.md)
- **Custom Storage**: [CUSTOM_SESSION_STORAGE.md](./CUSTOM_SESSION_STORAGE.md)
- **API Methods** (new in 0.1.6+):
  - `getSessionId()` - Get current session ID
  - `setSessionType()` - Switch between stateful/stateless

### API Reference
- **Connection Interface**: [USAGE.md - API Reference](./USAGE.md#api-reference)
- **Configuration Types**: [USAGE.md - Configuration Types](./USAGE.md#configuration-types)
- **Factory Function**: `createAbapConnection()`
- **Connection Classes**: `BaseAbapConnection`, `JwtAbapConnection`

## Version Highlights

### 0.1.9 (Current) - 2025-11-23
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
- 🔄 Automatic JWT token refresh
- 💾 Session persistence
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
