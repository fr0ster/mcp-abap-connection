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
   * Standard SAP ADT core discovery endpoint (available on all systems, returns smaller response)
   */
  ENDPOINT: '/sap/bc/adt/core/discovery',

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

