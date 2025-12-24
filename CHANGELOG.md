# Changelog

All notable changes to the `@mcp-abap-adt/connection` package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.8] - 2025-12-24

### Changed
- **Dependencies**: Updated `@mcp-abap-adt/interfaces` from `^0.2.5` to `^0.2.13`

## [0.2.7] - 2025-12-23
### Fixed
- Fixed LICENSE file - corrected copyright attribution (removed incorrect fork author)

## [0.2.6] - 2025-12-22

### Changed
- **Biome Migration**: Migrated from ESLint/Prettier to Biome for linting and formatting
  - Added `@biomejs/biome` as dev dependency
  - Added `lint`, `lint:check`, and `format` scripts to package.json
  - Integrated Biome check into build process (`npx biome check src --diagnostic-level=error`)
  - Updated Node.js imports to use `node:` protocol (`crypto`, `https`)
- **Type Safety**: Improved type safety by replacing `any` with `unknown`
  - `AbstractAbapConnection.ts`: `updateCookiesFromResponse` method parameter changed from `Record<string, any>` to `Record<string, unknown>`
  - `tokenRefresh.ts`: `error` parameter in catch block changed from `any` to `unknown` with added type guards

### Fixed
- Fixed computed property access by using literal keys where possible (`Authorization`, `Accept`, `Cookie` headers)
- Fixed non-null assertions by adding proper null checks (`JwtAbapConnection.ts`)
- Fixed optional chaining usage in `tokenRefresh.ts`
- Removed unused imports (`AbapConnection.ts`)
- Improved error handling with proper type guards for `unknown` error types

## [0.2.5] - 2025-12-21

### Added
- **connectionFactory tokenRefresher**: `createAbapConnection()` now accepts optional 4th parameter `tokenRefresher`
  - Passes through to `JwtAbapConnection` for automatic token refresh DI
  - Enables external token management via `AuthBroker.createTokenRefresher()`

## [0.2.4] - 2025-12-21

### Added
- **ITokenRefresher Support**: `JwtAbapConnection` now supports automatic token refresh via dependency injection
  - New optional `tokenRefresher` parameter in constructor
  - If provided, 401/403 errors trigger automatic token refresh and request retry
  - If not provided, legacy behavior (throw error on expired token)
  - Works with `AuthBroker.createTokenRefresher(destination)` from `@mcp-abap-adt/auth-broker`

### Changed
- **Dependencies**: Updated `@mcp-abap-adt/interfaces` to `^0.2.5`
  - New `ITokenRefresher` interface for token management DI
  - Simplified `IAbapConnection` interface

### Usage Example
```typescript
import { JwtAbapConnection } from '@mcp-abap-adt/connection';
import { AuthBroker } from '@mcp-abap-adt/auth-broker';

// Create token refresher from broker
const tokenRefresher = broker.createTokenRefresher('TRIAL');

// Inject into connection - 401/403 handled automatically
const connection = new JwtAbapConnection(config, logger, sessionId, tokenRefresher);
```

## [0.2.3] - 2025-12-19

### Fixed
- **Network Error Detection**: Add proper detection and handling of network-level errors in `AbstractAbapConnection.makeAdtRequest()`
  - Detect network errors: `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `ECONNRESET`, `ENETUNREACH`, `EHOSTUNREACH`
  - Skip retry logic for network errors (CSRF token retry, 401 cookie retry)
  - Throw network errors immediately with clear error message
  - Prevents confusing error messages when VPN is down or server is unreachable
  - Network errors now clearly indicate infrastructure issues vs application errors

### Changed
- **Error Handling**: Improved error handling logic to distinguish between network errors and HTTP errors
  - Network errors (connection issues) are now handled separately from HTTP errors (401, 403, 404)
  - No retry attempts for network errors (retries cannot fix infrastructure issues)
  - Better error logging with network error context

### Documentation
- Added "Network Error Detection" section to `docs/USAGE.md` with examples and best practices
- Documented all detected network error codes and their meanings
- Added error handling examples showing how to handle network vs HTTP errors

## [0.2.2] - 2025-12-13

### Fixed
- Add missing `ILogger` import from `@mcp-abap-adt/interfaces` to restore TypeScript build

## [0.2.1] - 2025-12-13

### Changed
- Dependency bump: `@mcp-abap-adt/interfaces` → `^0.1.16` to align with latest interfaces release
- Repository metadata: point package links to `fr0ster/mcp-abap-connection` (correct repo)

## [0.2.0] - 2025-12-08

### Breaking Changes

- **Token Refresh Removed**: Token refresh functionality has been completely removed from this package
  - `refreshToken()` method removed from `JwtAbapConnection`
  - `canRefreshToken()` method removed from `JwtAbapConnection`
  - All automatic token refresh logic removed from connection classes
  - Token refresh is now handled exclusively by `@mcp-abap-adt/auth-broker` package
  - This is a breaking change - code that relied on connection-level token refresh will need to use auth-broker instead

- **Logger is Optional**: Logger parameter is now optional in all connection constructors
  - `BaseAbapConnection`, `JwtAbapConnection`, and `createAbapConnection()` now accept `logger?: ILogger | null`
  - All logger calls use optional chaining (`logger?.info()`, `logger?.debug()`, etc.)
  - If no logger is provided, no logging output is produced (no-op behavior)
  - This allows using connections without requiring a logger instance

- **Session Storage Removed**: Session storage functionality has been completely removed from this package
  - `sessionStorage` parameter removed from all connection constructors (`BaseAbapConnection`, `JwtAbapConnection`, `createAbapConnection()`)
  - All session storage methods removed: `setSessionStorage()`, `getSessionStorage()`, `loadSessionState()`, `saveSessionState()`, `clearSessionState()`, `getSessionState()`, `setSessionState()`
  - `FileSessionStorage` utility class removed
  - Session state persistence is now handled exclusively by `@mcp-abap-adt/auth-broker` package
  - Connection package now handles only HTTP communication and session headers (cookies, CSRF tokens) without persistence
  - This is a breaking change - code that relied on connection-level session storage will need to use auth-broker instead

### Changed

- **Connection Package Scope**: Package now focuses solely on HTTP connection management
  - Removed all token refresh logic from `JwtAbapConnection`
  - Removed all token refresh logic from `connect()`, `makeAdtRequest()`, and `fetchCsrfToken()` methods
  - Removed all session storage and state persistence logic
  - Connection package now handles only HTTP communication and session headers (cookies, CSRF tokens)
  - Token lifecycle management and session state persistence are delegated to auth-broker package

### Removed

- **Token Refresh Methods**: 
  - `refreshToken()` method removed from `JwtAbapConnection`
  - `canRefreshToken()` method removed from `JwtAbapConnection`
  - `tokenRefreshInProgress` private field removed
  - Import of `refreshJwtToken` utility removed

- **Token Refresh Tests**:
  - `auto-refresh.test.ts` removed
  - Replaced with simplified `jwt-connection.test.ts` that tests only configuration validation

- **Session Storage Components**:
  - `FileSessionStorage` utility class removed
  - `ISessionStorage` and `SessionState` type exports removed
  - All session storage related imports and exports removed

### Migration Guide

If you were using token refresh functionality:

**Before (0.1.x)**:
```typescript
const connection = new JwtAbapConnection(config, logger);
if (connection.canRefreshToken()) {
  await connection.refreshToken();
}
```

**After (0.2.0)**:
```typescript
// Token refresh is now handled by auth-broker
// Connection package only handles HTTP communication
const connection = new JwtAbapConnection(config, logger);
// No refreshToken() or canRefreshToken() methods available
```

**Logger Usage**:
```typescript
// Logger is now optional
const connection = new JwtAbapConnection(config); // No logger - no logging output
const connection = new JwtAbapConnection(config, logger); // With logger - logging enabled
const connection = new JwtAbapConnection(config, null); // Explicitly no logger
```

If you were using session storage functionality:

**Before (0.1.x)**:
```typescript
import { FileSessionStorage } from '@mcp-abap-adt/connection';

const sessionStorage = new FileSessionStorage();
const connection = new JwtAbapConnection(config, logger, sessionStorage);
await connection.saveSessionState();
const state = await connection.getSessionState();
```

**After (0.2.0)**:
```typescript
// Session storage is now handled by auth-broker
// Connection package only handles HTTP communication
const connection = new JwtAbapConnection(config, logger);
// No sessionStorage parameter, no saveSessionState() or getSessionState() methods
```

## [0.1.15] - 2025-12-05

### Changed
- **Logger Interface Migration**: Migrated from specialized logger methods to standard `ILogger` interface
  - Replaced `logger.csrfToken()` calls with standard `debug()` and `error()` methods
  - Replaced `logger.tlsConfig()` calls with standard `debug()` method
  - Now uses only `ILogger` interface from `@mcp-abap-adt/interfaces` without dependency on concrete logger implementation
  - Follows Dependency Inversion Principle - depends on interface, not implementation

### Added
- **npm Configuration**: Added `.npmrc` file with `prefer-online=true` to ensure packages are installed from npmjs.com registry instead of local file system dependencies

## [0.1.14] - 2025-12-04

### Added
- **Interfaces Package Integration**: Migrated to use `@mcp-abap-adt/interfaces` package for all interface definitions
  - All interfaces now imported from shared package
  - Backward compatibility maintained with type aliases
  - Dependency on `@mcp-abap-adt/interfaces@^0.1.0` added

### Changed
- **Interface Renaming**: Interfaces renamed to follow `I` prefix convention:
  - `SapConfig` → `ISapConfig` (type alias for backward compatibility)
  - `AbapConnection` → `IAbapConnection` (type alias for backward compatibility)
  - `AbapRequestOptions` → `IAbapRequestOptions` (type alias for backward compatibility)
  - `SessionState` → `ISessionState` (type alias for backward compatibility)
  - `TokenRefreshResult` → `ITokenRefreshResult` (type alias for backward compatibility)
  - `TimeoutConfig` → `ITimeoutConfig` (type alias for backward compatibility)
  - Old names still work via type aliases for backward compatibility

### Documentation
- **Responsibilities and Design Principles**: Added comprehensive documentation section explaining package responsibilities and design principles

## [0.1.13] - 2025-12-01

### Added
- **CSRF Configuration Export**: Exported `CSRF_CONFIG` and `CSRF_ERROR_MESSAGES` constants for consistent CSRF token handling across different connection implementations
  - `CSRF_CONFIG`: Centralized constants for CSRF token fetching (retry count, delay, endpoint, headers)
  - `CSRF_ERROR_MESSAGES`: Standardized error messages for CSRF token operations
  - Enables other projects (e.g., Cloud SDK-based connections) to use the same CSRF configuration
  - See [PR Proposal](./PR_PROPOSAL_CSRF_CONFIG.md) for details

### Changed
- **CSRF Token Endpoint**: Updated CSRF token fetching to use `/sap/bc/adt/core/discovery` endpoint instead of `/sap/bc/adt/discovery`
  - Lighter response payload
  - Available on all SAP systems (on-premise and cloud)
  - Standard ADT discovery endpoint

## [0.1.12] - 2025-11-28

### Changed
- **BREAKING**: Removed all file reading functionality from connection package:
  - Connection package no longer reads `.env` files or any configuration files
  - Connection package no longer depends on `dotenv` or file system operations for configuration
  - Consumers must now pass `SapConfig` directly to connection constructors
  - This change improves separation of concerns: connection layer is now purely about connection logic, not configuration management

### Removed
- `loadEnvFile(envPath?: string): boolean` - Function that loaded `.env` files
- `loadConfigFromEnvFile(envPath?: string): SapConfig` - Convenience function that combined file loading and config reading
- `getConfigFromEnv(): SapConfig` - Function that read configuration from `process.env`
- All file system dependencies (`fs`, `path`) from `sapConfig.ts`
- All `dotenv` usage and dependencies from the package

### Fixed
- Resolved `stdio` mode output corruption issues by removing `dotenv` dependency
- Connection package is now cleaner and more focused on connection logic only
- Configuration management is now the responsibility of consumers (e.g., `mcp-abap-adt`)

### Migration Guide
If you were using `getConfigFromEnv()` or `loadConfigFromEnvFile()`:
1. Read environment variables in your application code (using `dotenv` or manual parsing)
2. Create `SapConfig` object from environment variables
3. Pass `SapConfig` directly to `createAbapConnection()` or connection constructors

Example:
```typescript
// Before (0.1.11 and earlier):
import { loadConfigFromEnvFile, createAbapConnection } from '@mcp-abap-adt/connection';
const config = loadConfigFromEnvFile();
const connection = createAbapConnection(config, logger);

// After (0.1.12+):
import { SapConfig, createAbapConnection } from '@mcp-abap-adt/connection';
// Load .env file in your application (using dotenv or manual parsing)
const config: SapConfig = {
  url: process.env.SAP_URL!,
  authType: 'jwt',
  jwtToken: process.env.SAP_JWT_TOKEN!,
  // ... other config
};
const connection = createAbapConnection(config, logger);
```

## [0.1.11] - 2025-11-25

### Changed
- Updated documentation:
  - `docs/JWT_AUTH_TOOLS.md`: Added examples showing token expiry information in generated `.env` files, explained automatic expiry detection feature
  - `docs/INSTALLATION.md`: Updated JWT authentication section with token expiry examples, added manual setup option, updated version to 0.1.10
  - Documentation now reflects the new token expiry feature introduced in 0.1.10 and provides clear guidance for users

## [0.1.10] - 2025-11-25

### Added
- Token expiry information in `.env` file generated by `sap-abap-auth` CLI:
  - Automatic JWT token expiry date extraction and display
  - Automatic refresh token expiry date extraction and display
  - Human-readable expiry dates in UTC timezone
  - ISO 8601 formatted expiry timestamps
  - Comments added at the beginning of `.env` file for easy reference
- `getTokenExpiry()` utility function in `sap-abap-auth.js`:
  - Decodes JWT tokens to extract expiration information
  - Handles base64url encoding/decoding
  - Returns structured expiry information (timestamp, date, readable format)
  - Gracefully handles invalid or non-standard JWT tokens

### Changed
- Enhanced `updateEnvFile()` function in `sap-abap-auth.js`:
  - Now includes token expiry comments at the beginning of `.env` files
  - Provides clear visibility into when tokens will expire
  - Helps users proactively refresh tokens before expiration

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

## [0.1.8] - 2025-11-22

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

## [0.1.7] - 2025-11-22

### Changed
- Refactored base URL handling in `AbstractAbapConnection`:
  - Base URL construction now centralized and consistent
  - Improved URL parsing and validation
  - Removed deprecated URL handling methods

### Removed
- Deprecated methods for base URL manipulation
  - Use constructor-based URL configuration instead

## [0.1.6] - 2025-11-22

### Added
- `getSessionId()` method to retrieve current session ID
- `setSessionType()` method to programmatically switch between stateful/stateless modes
- Better session management API for external control

### Changed
- Enhanced session management with more granular control
- Session type can now be changed after connection creation

## [0.1.5] - 2025-11-22

### Changed
- Refactored session ID generation and state management in `AbstractAbapConnection`
- Improved session state persistence logic
- Better handling of session lifecycle

### Fixed
- Session state management edge cases
- Session ID consistency across connection lifecycle

## [0.1.4] - 2025-11-21

### Added
- Automatic session ID generation when not explicitly provided
- Session ID now auto-generated using UUID if not specified
- Improved session management for stateful connections

### Changed
- Session creation logic simplified - no manual ID required
- Default session behavior more intuitive

## [0.1.3] - 2025-11-20

### Added
- GitHub Actions workflow for automated release process
- Automated npm publishing on version tags
- CI/CD pipeline for package releases

### Changed
- Release process now automated via GitHub Actions
- Version tagging triggers automatic npm publish

## [0.1.2] - 2025-11-20

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
  - `docs/CUSTOM_SESSION_STORAGE.md` - Custom session storage implementation
- Example files:
  - `examples/basic-connection.js` - Simple connection example
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
  - `docs/CUSTOM_SESSION_STORAGE.md` - Custom session storage implementation
  - `docs/STATEFUL_SESSION_GUIDE.md` - Session state management guide
- Example files:
  - `examples/basic-connection.js` - Simple connection example
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

[Unreleased]: https://github.com/fr0ster/mcp-abap-adt/compare/v0.1.15...HEAD
[0.1.15]: https://github.com/fr0ster/mcp-abap-adt/releases/tag/v0.1.15
[0.1.14]: https://github.com/fr0ster/mcp-abap-adt/releases/tag/v0.1.14
[0.1.13]: https://github.com/fr0ster/mcp-abap-adt/releases/tag/v0.1.13
[0.1.12]: https://github.com/fr0ster/mcp-abap-adt/releases/tag/v0.1.12
[0.1.11]: https://github.com/fr0ster/mcp-abap-adt/releases/tag/v0.1.11
[0.1.10]: https://github.com/fr0ster/mcp-abap-adt/releases/tag/v0.1.10
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
