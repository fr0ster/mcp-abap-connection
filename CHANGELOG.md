# Changelog

All notable changes to the `@mcp-abap-adt/connection` package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **BREAKING**: Architecture refactoring for proper separation of concerns:
  - `connect()` method changed from concrete to **abstract** in `AbstractAbapConnection`
  - Each authentication type now implements its own `connect()` logic:
    - `BaseAbapConnection`: Basic auth with CSRF token fetch, logs warnings on errors
    - `JwtAbapConnection`: JWT auth with automatic token refresh on 401/403 errors
  - `fetchCsrfToken()` changed from `private` to `protected` for use by concrete implementations
  - Added protected getters/setters: `getCsrfToken()`, `setCsrfToken()`, `getCookies()`
  - Removed ALL JWT-specific logic from `AbstractAbapConnection`:
    - Removed JWT expiration checks from `connect()`
    - Removed JWT error handling from base class
    - Base class is now completely auth-agnostic
  - `JwtAbapConnection.connect()` now handles:
    - Token expiration detection (401/403 errors)
    - Permission vs auth error distinction (`ExceptionResourceNoAccess` check)
    - Automatic token refresh and retry
  - `JwtAbapConnection.makeAdtRequest()` override handles JWT refresh for regular requests
  - Previous architecture cleanup (from earlier versions):
    - `BaseAbapConnection` (abstract) → `AbstractAbapConnection` 
    - `OnPremAbapConnection` → `BaseAbapConnection`
    - `CloudAbapConnection` → `JwtAbapConnection`

### Added
- Automatic JWT token refresh functionality for cloud connections
  - Auto-refresh on 401/403 errors in both `connect()` and `makeAdtRequest()`
  - Permission error detection: skips refresh for "ExceptionResourceNoAccess", "No authorization", "Missing authorization"
  - `canRefreshToken()` method to check if refresh credentials available
  - `refreshToken()` method to refresh JWT using UAA OAuth2 endpoint
  - Concurrent refresh protection (prevents multiple simultaneous refresh attempts)
- Protected helper methods in `AbstractAbapConnection` for subclass use:
  - `fetchCsrfToken()` - CSRF token fetching with retry logic
  - `getCsrfToken()`, `setCsrfToken()` - CSRF token management
  - `getCookies()` - Cookie access for concrete implementations
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

### Removed
- JWT-specific logic from `AbstractAbapConnection`:
  - Removed `isJwtExpiredError()` helper method
  - Removed JWT refresh logic from base `connect()` method
  - Removed JWT error messages from abstract class
- `AbstractAbapConnection` from public exports (internal use only)
  - Only `BaseAbapConnection` and `JwtAbapConnection` are exported publicly
- `AUTO_REFRESH_IMPROVEMENTS.md` (temporary document, content moved to CHANGELOG)
- `CONNECTION_LAYER_ROADMAP.md` (roadmap belongs in root project)
- `PUBLICATION_ROADMAP.md` (roadmap belongs in root project)

### Fixed
- JWT token refresh now properly handles connection errors (401/403 during initial connect)
- Permission errors (403 with "ExceptionResourceNoAccess") no longer trigger JWT refresh loops
- Proper separation: base class handles HTTP/session, concrete classes handle auth-specific errors
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
