// Types
export type {
  SapConfig,
  SapAuthType,
} from "./config/sapConfig.js";
export type { AbapRequestOptions } from "./connection/AbapConnection.js";

// Interfaces
export { type AbapConnection } from "./connection/AbapConnection.js";
export type { ILogger, SessionState, ISessionStorage } from "./logger.js";

// Session storage implementations
export { FileSessionStorage, type FileSessionStorageOptions } from "./utils/FileSessionStorage.js";

// Connection classes - only final implementations
export { BaseAbapConnection } from "./connection/BaseAbapConnection.js";
export { JwtAbapConnection } from "./connection/JwtAbapConnection.js";

// Deprecated aliases for backward compatibility
export { BaseAbapConnection as OnPremAbapConnection } from "./connection/BaseAbapConnection.js";
export { JwtAbapConnection as CloudAbapConnection } from "./connection/JwtAbapConnection.js";

// Factory
export { createAbapConnection } from "./connection/connectionFactory.js";

// Config utilities
export { sapConfigSignature, getConfigFromEnv } from "./config/sapConfig.js";

// Timeouts
export { getTimeout, getTimeoutConfig, type TimeoutConfig } from "./utils/timeouts.js";

