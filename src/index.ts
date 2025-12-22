// Types - re-exported from interfaces package with backward compatibility aliases
export type {
  SapAuthType,
  SapConfig,
} from './config/sapConfig.js';
// Config utilities
export { sapConfigSignature } from './config/sapConfig.js';
// Interfaces - re-exported from interfaces package with backward compatibility aliases
export type {
  AbapConnection,
  AbapRequestOptions,
} from './connection/AbapConnection.js';
// Connection classes - only final implementations
// Deprecated aliases for backward compatibility
export {
  BaseAbapConnection,
  BaseAbapConnection as OnPremAbapConnection,
} from './connection/BaseAbapConnection.js';
// Factory
export { createAbapConnection } from './connection/connectionFactory.js';
// CSRF configuration
export { CSRF_CONFIG, CSRF_ERROR_MESSAGES } from './connection/csrfConfig.js';
export {
  JwtAbapConnection,
  JwtAbapConnection as CloudAbapConnection,
} from './connection/JwtAbapConnection.js';
export type { ILogger } from './logger.js';
// Timeouts
export {
  getTimeout,
  getTimeoutConfig,
  type TimeoutConfig,
} from './utils/timeouts.js';
