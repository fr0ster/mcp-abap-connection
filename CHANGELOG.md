# Changelog

All notable changes to the `@mcp-abap-adt/connection` package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

### Added

### Removed

### Fixed

## [0.1.9] - 2025-11-23

### Changed
- Updated documentation in README.md:
  - Added information about new API methods (`getSessionId()`, `setSessionType()`)
  - Enhanced `AbapConnection` interface documentation
  - Added Changelog section with link to CHANGELOG.md
  - Fixed documentation links to use `docs/` directory
  - Specified current version (0.1.8) with key features
- Updated CHANGELOG.md:
  - Added detailed descriptions for all versions (0.1.1-0.1.8)
  - Fixed version ordering (newest to oldest)
  - Added proper version links for all releases
  - Documented all features, changes, and fixes for each version

### Added
- Comprehensive version history documentation
- Version comparison links in CHANGELOG

## [0.1.8] - 2025-01-23

### Changed
- Refactored base URL handling in `AbstractAbapConnection`:
  - Removed deprecated `setBaseUrl()` and `getBaseUrl()` methods
  - Base URL now managed internally via constructor
  - Improved URL construction consistency
- Enhanced session management:
  - Added `getSessionId()` method to retrieve current session ID
  - Added `setSessionType()` method to switch between stateful/stateless modes
  - Session ID now auto-generated if not provided
  - Improved session state management in `AbstractAbapConnection`

### Added
- cSpell configuration for custom words in settings.json
- Automatic session ID generation when not explicitly provided
- GitHub Actions workflow for automated release process
- Environment file loading and configuration utilities
- `getSessionId()` and `setSessionType()` public methods for better session control

### Removed
- Deprecated `setBaseUrl()` and `getBaseUrl()` methods from `AbstractAbapConnection`
  - Use constructor parameter instead for setting base URL

### Fixed
- Session ID generation now more robust
- Base URL handling more consistent across connection types

## [0.1.7] - 2025-01-22

### Changed
- Refactored base URL handling in `AbstractAbapConnection`:
  - Base URL construction now centralized and consistent
  - Improved URL parsing and validation
  - Removed deprecated URL handling methods

### Removed
- Deprecated methods for base URL manipulation
  - Use constructor-based URL configuration instead

## [0.1.6] - 2025-01-21

### Added
- `getSessionId()` method to retrieve current session ID
- `setSessionType()` method to programmatically switch between stateful/stateless modes
- Better session management API for external control

### Changed
- Enhanced session management with more granular control
- Session type can now be changed after connection creation

## [0.1.5] - 2025-01-20

### Changed
- Refactored session ID generation and state management in `AbstractAbapConnection`
- Improved session state persistence logic
- Better handling of session lifecycle

### Fixed
- Session state management edge cases
- Session ID consistency across connection lifecycle

## [0.1.4] - 2025-01-19

### Added
- Automatic session ID generation when not explicitly provided
- Session ID now auto-generated using UUID if not specified
- Improved session management for stateful connections

### Changed
- Session creation logic simplified - no manual ID required
- Default session behavior more intuitive

## [0.1.3] - 2025-01-18

### Added
- GitHub Actions workflow for automated release process
- Automated npm publishing on version tags
- CI/CD pipeline for package releases

### Changed
- Release process now automated via GitHub Actions
- Version tagging triggers automatic npm publish

## [0.1.2] - 2024-11-16

### Changed
- Updated dependencies to latest versions
- Enhanced TypeScript configuration for better type safety
- Improved build output structure

### Added
- Better TypeScript compiler options
- Stricter type checking enabled

## [0.1.0] - 2024-11-14

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
- `BaseAbapConnection` for basic auth (formerly `OnPremAbapConnection`)
- `JwtAbapConnection` for JWT auth (formerly `CloudAbapConnection`)
- Session state management (`getSessionState()`, `setSessionState()`)
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
  - `docs/STATEFUL_SESSION_GUIDE.md` - Session state management guide
- Example files:
  - `examples/basic-connection.js` - Simple connection example
  - `examples/auto-refresh.js` - JWT auto-refresh demonstration
  - `examples/session-persistence.js` - FileSessionStorage usage
  - `examples/README.md` with all examples

### Removed
- JWT-specific logic from `AbstractAbapConnection`:
  - Removed `isJwtExpiredError()` helper method
  - Removed JWT refresh logic from base `connect()` method
  - Removed JWT error messages from abstract class
- `AbstractAbapConnection` from public exports (internal use only)
  - Only `BaseAbapConnection` and `JwtAbapConnection` are exported publicly

### Fixed
- JWT token refresh now properly handles connection errors (401/403 during initial connect)
- Permission errors (403 with "ExceptionResourceNoAccess") no longer trigger JWT refresh loops
- Proper separation: base class handles HTTP/session, concrete classes handle auth-specific errors

[Unreleased]: https://github.com/fr0ster/mcp-abap-adt/compare/v0.1.9...HEAD
[0.1.9]: https://github.com/fr0ster/mcp-abap-adt/releases/tag/v0.1.9
[0.1.8]: https://github.com/fr0ster/mcp-abap-adt/releases/tag/v0.1.8
[0.1.7]: https://github.com/fr0ster/mcp-abap-adt/releases/tag/v0.1.7
[0.1.6]: https://github.com/fr0ster/mcp-abap-adt/releases/tag/v0.1.6
[0.1.5]: https://github.com/fr0ster/mcp-abap-adt/releases/tag/v0.1.5
[0.1.4]: https://github.com/fr0ster/mcp-abap-adt/releases/tag/v0.1.4
[0.1.3]: https://github.com/fr0ster/mcp-abap-adt/releases/tag/v0.1.3
[0.1.2]: https://github.com/fr0ster/mcp-abap-adt/releases/tag/v0.1.2
[0.1.1]: https://github.com/fr0ster/mcp-abap-adt/releases/tag/v0.1.1
[0.1.0]: https://github.com/fr0ster/mcp-abap-adt/releases/tag/v0.1.0
