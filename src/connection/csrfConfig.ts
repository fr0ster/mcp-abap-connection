/**
 * CSRF Token Configuration
 *
 * Centralized constants for CSRF token fetching to ensure consistency
 * across different connection implementations.
 *
 * The fetch is one request per endpoint, never repeated and never delayed: a
 * failed request is its own error. The fallback endpoint is asked only after
 * the primary answered 404 (or 501) — a system without it — and is not a retry.
 */
export const CSRF_CONFIG = {
  /**
   * CSRF token endpoint path (primary)
   * Standard SAP ADT core discovery endpoint (newer systems, returns smaller response)
   */
  ENDPOINT: '/sap/bc/adt/core/discovery',

  /**
   * CSRF token endpoint path (fallback)
   * Legacy SAP ADT discovery endpoint for older systems (e.g. BASIS < 7.52)
   * that don't have /sap/bc/adt/core/discovery
   */
  FALLBACK_ENDPOINT: '/sap/bc/adt/discovery',

  /**
   * Required headers for CSRF token fetch
   */
  REQUIRED_HEADERS: {
    'x-csrf-token': 'fetch',
    Accept: 'application/atomsvc+xml',
  },
} as const;

/**
 * CSRF token error messages
 * Standardized error messages for consistent error reporting
 */
export const CSRF_ERROR_MESSAGES = {
  FETCH_FAILED: (attempts: number, cause: string) =>
    `Failed to fetch CSRF token after ${attempts} attempts: ${cause}`,

  NOT_IN_HEADERS: 'No CSRF token in response headers',

  REQUIRED_FOR_MUTATION:
    'CSRF token is required for POST/PUT requests but could not be fetched',
} as const;
