# Changelog

All notable changes to the `@mcp-abap-adt/connection` package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **BREAKING**: Architecture refactoring for better separation of concerns:
  - `BaseAbapConnection` (abstract class) → `AbstractAbapConnection` (contains common logic for all auth types)
  - `OnPremAbapConnection` (Basic Auth) → `BaseAbapConnection` (clearer naming: "Base" = Basic Auth)
  - `CloudAbapConnection` (JWT) → `JwtAbapConnection` (more descriptive name)
  - Auto-refresh logic is now contained ONLY in `JwtAbapConnection` (no JWT-specific code in `AbstractAbapConnection`)
  - Old names available as deprecated aliases for backward compatibility:
    - `OnPremAbapConnection` → alias for `BaseAbapConnection`
    - `CloudAbapConnection` → alias for `JwtAbapConnection`

### Added
- Automatic JWT token refresh functionality for cloud connections
  - Auto-refresh on 401/403 errors in `fetchCsrfToken()`, `makeAdtRequest()`, and `request()`
  - `canRefreshToken()` method to check if refresh is possible
  - `refreshToken()` method to refresh JWT using UAA OAuth endpoint
- Unit tests for auto-refresh logic (`src/__tests__/auto-refresh.test.ts`)
- Documentation structure:
  - `docs/INSTALLATION.md` - Installation guide
  - `docs/USAGE.md` - Usage examples and API documentation
  - `docs/AUTO_REFRESH_TESTING.md` - Testing guide for auto-refresh
  - `docs/CUSTOM_SESSION_STORAGE.md` - Custom session storage implementation
- Example files:
  - `examples/basic-connection.js` - Simple connection example
  - `examples/auto-refresh.js` - JWT auto-refresh demonstration
  - `examples/session-persistence.js` - FileSessionStorage usage
  - Updated `examples/README.md` with all examples

### Changed
- `JwtAbapConnection.canRefreshToken()` now includes debug logging
- `BaseAbapConnection.fetchCsrfToken()` simplified auto-refresh logic
  - Removed complex `isJwtExpiredError()` checks
  - Auto-refresh triggers on any 401/403 for JWT auth
- `connect()` method now throws auth errors immediately for JWT expired scenarios
- README.md updated with documentation links

### Removed
- `AUTO_REFRESH_IMPROVEMENTS.md` (temporary document, content moved to CHANGELOG)
- `CONNECTION_LAYER_ROADMAP.md` (roadmap belongs in root project)
- `PUBLICATION_ROADMAP.md` (roadmap belongs in root project)

### Fixed
- Auto-refresh not triggering due to `canRefreshToken()` returning false
  - Root cause: Test configuration not reading UAA credentials from environment
  - Fixed in `packages/adt-clients` by updating `getConfig()` to read UAA variables

## [0.1.0] - 2024-11-14

### Added
- Initial release of `@mcp-abap-adt/connection` package
- Support for Basic Auth (on-premise systems)
- Support for JWT/OAuth2 (SAP BTP cloud systems)
- CSRF token management
- Cookie-based session management
- `FileSessionStorage` for session persistence
- `ISessionStorage` interface for custom session storage
- CLI tool (`sap-abap-auth`) for browser-based authentication
- TypeScript type definitions
- Configurable timeouts for different operation types
- Custom logger interface (`ILogger`)
- Connection factory (`createAbapConnection()`)
- `OnPremAbapConnection` for basic auth
- `JwtAbapConnection` (formerly `CloudAbapConnection`) for JWT auth
- Session state management (`getSessionState()`, `setSessionState()`)

### Documentation
- Initial README.md with basic usage examples
- Example: `custom-session-storage.js`

[Unreleased]: https://github.com/fr0ster/mcp-abap-adt/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/fr0ster/mcp-abap-adt/releases/tag/v0.1.0
