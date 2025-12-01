# PR Proposal: Export CSRF_CONFIG from @mcp-abap-adt/connection

## Summary

Propose exporting `CSRF_CONFIG` constants from `@mcp-abap-adt/connection` package to enable consistent CSRF token handling across different connection implementations (axios-based and Cloud SDK-based).

## Problem Statement

Currently, `cloud-llm-hub` implements its own `CSRF_CONFIG` in `srv/connections/csrfConfig.ts` to synchronize CSRF token fetching parameters between:

1. **Base connection** (`@mcp-abap-adt/connection`): Uses `axios` for direct Basic/JWT connections
2. **CloudSdkAbapConnection** (`cloud-llm-hub`): Uses SAP Cloud SDK `executeHttpRequest` for BTP Destination connections

While the implementations differ (different transport stacks), the retry logic, timeout parameters, and error messages should be synchronized for consistent behavior.

## Current State

### In mcp-abap-adt

In `BaseAbapConnection.fetchCsrfToken()` (from `dist/lib/connection/BaseAbapConnection.js`):

```javascript
async fetchCsrfToken(url, retryCount = 3, retryDelay = 1000) {
  // ... implementation
}
```

**Hardcoded values:**
- `retryCount = 3` (default parameter)
- `retryDelay = 1000` (default parameter, milliseconds)
- Endpoint: `/sap/bc/adt/discovery` (hardcoded in implementation)
- Required headers: `{ 'x-csrf-token': 'fetch', 'Accept': 'application/atomsvc+xml' }` (hardcoded)

### In cloud-llm-hub

In `srv/connections/csrfConfig.ts`:

```typescript
export const CSRF_CONFIG = {
  RETRY_COUNT: 3,
  RETRY_DELAY: 1000,
  ENDPOINT: '/sap/bc/adt/discovery',
  REQUIRED_HEADERS: {
    'x-csrf-token': 'fetch',
    'Accept': 'application/atomsvc+xml'
  }
} as const;

export const CSRF_ERROR_MESSAGES = {
  FETCH_FAILED: (attempts: number, cause: string) =>
    `Failed to fetch CSRF token after ${attempts} attempts: ${cause}`,
  NOT_IN_HEADERS: 'No CSRF token in response headers',
  REQUIRED_FOR_MUTATION: 'CSRF token is required for POST/PUT requests but could not be fetched'
} as const;
```

## Proposed Solution

### 1. Create `src/connection/csrfConfig.ts` in mcp-abap-connection

```typescript
/**
 * CSRF Token Configuration
 * 
 * Centralized constants for CSRF token fetching to ensure consistency
 * across different connection implementations.
 */
export const CSRF_CONFIG = {
  /**
   * Number of retry attempts for CSRF token fetch
   * Default: 3 attempts (total of 4 requests: initial + 3 retries)
   */
  RETRY_COUNT: 3,

  /**
   * Delay between retry attempts (milliseconds)
   * Default: 1000ms (1 second)
   */
  RETRY_DELAY: 1000,

  /**
   * CSRF token endpoint path
   * Standard SAP ADT discovery endpoint for CSRF token
   */
  ENDPOINT: '/sap/bc/adt/discovery',

  /**
   * Required headers for CSRF token fetch
   */
  REQUIRED_HEADERS: {
    'x-csrf-token': 'fetch',
    'Accept': 'application/atomsvc+xml'
  }
} as const;

/**
 * CSRF token error messages
 * Standardized error messages for consistent error reporting
 */
export const CSRF_ERROR_MESSAGES = {
  FETCH_FAILED: (attempts: number, cause: string) =>
    `Failed to fetch CSRF token after ${attempts} attempts: ${cause}`,
  
  NOT_IN_HEADERS: 'No CSRF token in response headers',
  
  REQUIRED_FOR_MUTATION: 'CSRF token is required for POST/PUT requests but could not be fetched'
} as const;
```

### 2. Export from `@mcp-abap-adt/connection` package

Add to `src/index.ts`:

```typescript
// CSRF configuration
export { CSRF_CONFIG, CSRF_ERROR_MESSAGES } from './connection/csrfConfig.js';
```

### 3. Update `AbstractAbapConnection.fetchCsrfToken()` to use config

```typescript
import { CSRF_CONFIG, CSRF_ERROR_MESSAGES } from './csrfConfig.js';

// In AbstractAbapConnection class:
protected async fetchCsrfToken(
  url: string,
  retryCount: number = CSRF_CONFIG.RETRY_COUNT,
  retryDelay: number = CSRF_CONFIG.RETRY_DELAY
): Promise<string> {
  // Build CSRF URL using CSRF_CONFIG.ENDPOINT
  // Use CSRF_CONFIG.REQUIRED_HEADERS
  // Use CSRF_ERROR_MESSAGES for error reporting
  // ...
}
```


## Benefits

1. **Consistency**: Single source of truth for CSRF configuration
2. **Maintainability**: Changes to retry logic or endpoints in one place
3. **Reusability**: Other projects can use the same configuration
4. **Type Safety**: TypeScript constants with `as const` for better type inference
5. **Documentation**: JSDoc comments explain each parameter
6. **Loose Coupling**: Only exports constants, not implementation details - allows flexibility for future changes

## Migration Path for cloud-llm-hub

After mcp-abap-connection exports `CSRF_CONFIG`:

1. Remove `srv/connections/csrfConfig.ts` from cloud-llm-hub
2. Update imports in `CloudSdkAbapConnection.ts`:
   ```typescript
   import { CSRF_CONFIG, CSRF_ERROR_MESSAGES } from '@mcp-abap-adt/connection';
   ```
3. Update `CloudSdkAbapConnection` to use exported constants:
   ```typescript
   // Use CSRF_CONFIG.RETRY_COUNT, CSRF_CONFIG.RETRY_DELAY, etc.
   // Use CSRF_CONFIG.ENDPOINT for CSRF token URL
   // Use CSRF_CONFIG.REQUIRED_HEADERS for request headers
   // Use CSRF_ERROR_MESSAGES for consistent error messages
   ```
4. No breaking changes - same API, just different import source

## Backward Compatibility

✅ **Fully backward compatible**:
- `fetchCsrfToken()` is a **protected method** in `AbstractAbapConnection`, not part of the public `AbapConnection` interface
- No changes to public API (`AbapConnection` interface remains unchanged)
- Default parameters in `fetchCsrfToken()` remain the same (internal implementation detail)
- Existing code continues to work
- New exports are additive (doesn't break existing code)

### Important Notes

**Why only export constants, not AbstractAbapConnection:**

1. **Loose Coupling**: Exporting only constants avoids creating tight dependencies on internal implementation details
2. **Future Flexibility**: Changes to `AbstractAbapConnection` won't break external implementations
3. **Independence**: Each project can implement CSRF logic using the constants without being tied to axios-based implementation
4. **Versioning**: Constants are stable, while class internals may evolve

**CSRF_CONFIG export:**
- `fetchCsrfToken()` is a **protected method** in `AbstractAbapConnection`, not part of the public `AbapConnection` interface
- This PR exports **constants** (`CSRF_CONFIG`), not the method itself
- The goal is to synchronize the **constants** used across implementations
- Each project implements its own CSRF fetching logic using these constants

## Testing Considerations

- Verify CSRF token fetching still works with exported config
- Ensure retry logic behaves identically
- Test error messages are consistent
- Verify TypeScript types are correct

## Example: Cloud SDK Implementation

Example of how `CloudSdkAbapConnection` could use exported constants:

```typescript
import { CSRF_CONFIG, CSRF_ERROR_MESSAGES } from '@mcp-abap-adt/connection';
import { executeHttpRequest } from '@sap-cloud-sdk/http-client';

export class CloudSdkAbapConnection {
  private csrfToken: string | null = null;
  
  async fetchCsrfToken(baseUrl: string): Promise<string> {
    const csrfUrl = `${baseUrl}${CSRF_CONFIG.ENDPOINT}`;
    
    for (let attempt = 0; attempt <= CSRF_CONFIG.RETRY_COUNT; attempt++) {
      try {
        const response = await executeHttpRequest(
          { destinationName: this.destination },
          {
            method: 'GET',
            url: csrfUrl,
            headers: CSRF_CONFIG.REQUIRED_HEADERS
          }
        );
        
        const token = response.headers['x-csrf-token'];
        if (!token) {
          if (attempt < CSRF_CONFIG.RETRY_COUNT) {
            await new Promise(resolve => setTimeout(resolve, CSRF_CONFIG.RETRY_DELAY));
            continue;
          }
          throw new Error(CSRF_ERROR_MESSAGES.NOT_IN_HEADERS);
        }
        
        this.csrfToken = token;
        return token;
      } catch (error) {
        if (attempt >= CSRF_CONFIG.RETRY_COUNT) {
          throw new Error(
            CSRF_ERROR_MESSAGES.FETCH_FAILED(
              CSRF_CONFIG.RETRY_COUNT + 1,
              error instanceof Error ? error.message : String(error)
            )
          );
        }
        await new Promise(resolve => setTimeout(resolve, CSRF_CONFIG.RETRY_DELAY));
      }
    }
    
    throw new Error(CSRF_ERROR_MESSAGES.FETCH_FAILED(CSRF_CONFIG.RETRY_COUNT + 1, 'Unknown error'));
  }
}
```

**Benefits of using only constants:**
- ✅ No tight coupling to implementation details
- ✅ Freedom to implement CSRF logic as needed for Cloud SDK
- ✅ Consistent configuration values across projects
- ✅ Easy to maintain - changes to constants don't break implementations
- ✅ Future-proof - can change internal implementation without affecting external code

## Related Issues

- Addresses code duplication between `cloud-llm-hub` and `mcp-abap-adt`
- Part of Phase 3.2: Synchronize CSRF Token Logic (see `MCP_ABAP_ADT_INTEGRATION.md`)
- Provides shared constants without creating tight coupling

## Implementation Notes

### CSRF_CONFIG
- Keep default parameters in `fetchCsrfToken()` signature for backward compatibility
- Use `as const` for better TypeScript inference
- Add JSDoc comments for better IDE support
- Consider adding unit tests for config values
- Update error messages in `AbstractAbapConnection.fetchCsrfToken()` to use `CSRF_ERROR_MESSAGES`

### Why Not Export AbstractAbapConnection

**Decision**: Do not export `AbstractAbapConnection` to maintain loose coupling.

**Reasons:**
1. **Future Flexibility**: Internal implementation can change without breaking external code
2. **Independence**: Each project can implement CSRF logic using constants without being tied to axios
3. **Versioning**: Constants are stable API, class internals may evolve
4. **Coupling**: Exporting base class creates tight dependency that complicates future refactoring
5. **Different Needs**: Cloud SDK implementations may need different patterns than axios-based ones

**Trade-off**: 
- ❌ Cannot reuse protected methods from `AbstractAbapConnection`
- ✅ Can change internal implementation freely
- ✅ Each project implements CSRF logic independently using shared constants
- ✅ No breaking changes when refactoring base class

