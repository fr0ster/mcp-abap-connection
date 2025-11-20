# Auto-Refresh JWT Token - Testing Guide

## Overview

Auto-refresh functionality automatically refreshes expired JWT tokens using a refresh token and UAA OAuth endpoint. This prevents test failures and user interruptions when JWT tokens expire.

## Architecture

### Three Levels of Error Handling

1. **Connection Level** (`packages/connection/`)
   - Auto-refresh logic in `BaseAbapConnection.ts`
   - Triggered on 401/403 errors in:
     - `fetchCsrfToken()` - CSRF token acquisition
     - `makeAdtRequest()` - ADT API calls
     - `request()` - Axios interceptor
   - Checks `canRefreshToken()` before attempting refresh
   - Calls `refreshToken()` to get new access token from UAA

2. **Test Configuration Level** (`packages/adt-clients/src/__tests__/helpers/`)
   - `getConfig()` reads UAA credentials from environment variables
   - Provides `refreshToken`, `uaaUrl`, `uaaClientId`, `uaaClientSecret` to connection

3. **Test Suite Level** (`packages/adt-clients/src/__tests__/integration/`)
   - `beforeEach` catches auth errors during `connect()`
   - Calls `markAuthFailed()` if auto-refresh fails
   - Subsequent tests check `hasAuthFailed()` and skip

## Test Coverage

### Unit Tests (`packages/connection/src/__tests__/`)

**Location**: `auto-refresh.test.ts`

Tests `canRefreshToken()` logic without HTTP calls:
- ✅ Returns `true` when all UAA credentials present
- ✅ Returns `false` when any credential missing
- ✅ Validates config requirements
- ✅ Tests all credential combinations

**Run**: `cd packages/connection && npm test`

### Integration Tests (`packages/adt-clients/src/__tests__/integration/`)

**Location**: Various test files (e.g., `class/create.test.ts`)

Tests full auto-refresh flow with real SAP system:
- ✅ Auto-refresh on expired JWT during `connect()`
- ✅ Auto-refresh during ADT operations
- ✅ Test skip when refresh fails
- ✅ Error handling and logging

**Run**: `cd packages/adt-clients && npm test`

## Environment Variables Required

For auto-refresh to work, set these in `.env`:

```bash
# JWT authentication
SAP_AUTH_TYPE=jwt
SAP_JWT_TOKEN=<your-jwt-token>

# Auto-refresh credentials
SAP_REFRESH_TOKEN=<your-refresh-token>
SAP_UAA_URL=<uaa-server-url>
SAP_UAA_CLIENT_ID=<client-id>
SAP_UAA_CLIENT_SECRET=<client-secret>
```

## Behavior Matrix

| Scenario | canRefreshToken() | Behavior | Test Result |
|----------|-------------------|----------|-------------|
| Valid JWT + No refresh creds | `false` | Immediate error on 401 | SKIP (if in beforeEach) |
| Valid JWT + Valid refresh creds | `true` | Success, no refresh needed | PASS |
| Expired JWT + Valid refresh creds | `true` | Auto-refresh → Success | PASS |
| Expired JWT + Expired refresh token | `true` | Auto-refresh fails → Error | SKIP |
| Expired JWT + No refresh creds | `false` | Immediate error | SKIP |

## Success Flow

```
Test Start
  ↓
beforeEach
  ↓
connect()
  ↓
fetchCsrfToken()
  ↓
401 Error (JWT expired)
  ↓
canRefreshToken() → true
  ↓
refreshToken() → Success
  ↓
Retry fetchCsrfToken() → Success
  ↓
Test Runs → PASS
```

## Failure Flow

```
Test Start
  ↓
beforeEach
  ↓
connect()
  ↓
fetchCsrfToken()
  ↓
401 Error (JWT expired)
  ↓
canRefreshToken() → true
  ↓
refreshToken() → FAIL (refresh token expired)
  ↓
Throw "JWT token has expired and refresh failed"
  ↓
beforeEach catch
  ↓
markAuthFailed(TEST_SUITE_NAME)
  ↓
All Tests → SKIP
```

## Debug Logging

Enable debug logs to see auto-refresh in action:

```bash
DEBUG_TESTS=true npm test -- integration/class/create
```

Look for:
- `🔍 canRefreshToken check:` - Shows credential status
- `Received 401 in fetchCsrfToken, attempting automatic token refresh...`
- `Refreshing JWT token...`
- `JWT token refreshed successfully`

## Troubleshooting

### Tests FAIL instead of SKIP

**Symptom**: Tests fail with "JWT token has expired" error

**Cause**: `getConfig()` not reading UAA credentials from `.env`

**Fix**: Verify `sessionConfig.ts` reads all SAP_* environment variables

### Auto-refresh not triggering

**Symptom**: No "attempting automatic token refresh" logs

**Cause**: `canRefreshToken()` returns `false`

**Debug**:
1. Check `.env` has all credentials
2. Verify `getConfig()` passes them to connection
3. Add debug logging to `canRefreshToken()`

### Refresh succeeds but test still fails

**Symptom**: Logs show "JWT token refreshed successfully" but test fails

**Cause**: Token not updated in connection config

**Fix**: Verify `refreshToken()` updates `config.jwtToken` and clears CSRF/cookies

## Related Documentation

- [AUTO_REFRESH_IMPROVEMENTS.md](./AUTO_REFRESH_IMPROVEMENTS.md) - Implementation details
- [CONNECTION_LAYER_ROADMAP.md](./CONNECTION_LAYER_ROADMAP.md) - Connection architecture
- [TEST_ERROR_HANDLING_PATTERN.md](../adt-clients/TEST_ERROR_HANDLING_PATTERN.md) - Test patterns
