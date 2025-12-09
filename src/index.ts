// Types - re-exported from interfaces package with backward compatibility aliases
export type {
  SapConfig,
  SapAuthType,
} from "./config/sapConfig.js";
export type { AbapRequestOptions } from "./connection/AbapConnection.js";

// Interfaces - re-exported from interfaces package with backward compatibility aliases
export { type AbapConnection } from "./connection/AbapConnection.js";
export type { ILogger } from "./logger.js";

// Connection classes - only final implementations
export { BaseAbapConnection } from "./connection/BaseAbapConnection.js";
export { JwtAbapConnection } from "./connection/JwtAbapConnection.js";

// Deprecated aliases for backward compatibility
export { BaseAbapConnection as OnPremAbapConnection } from "./connection/BaseAbapConnection.js";
export { JwtAbapConnection as CloudAbapConnection } from "./connection/JwtAbapConnection.js";

// Factory
export { createAbapConnection } from "./connection/connectionFactory.js";

// Config utilities
export { sapConfigSignature } from "./config/sapConfig.js";

// Timeouts
export { getTimeout, getTimeoutConfig, type TimeoutConfig } from "./utils/timeouts.js";

// CSRF configuration
export { CSRF_CONFIG, CSRF_ERROR_MESSAGES } from "./connection/csrfConfig.js";

