// Types - re-exported from interfaces package with backward compatibility aliases

export type {
  IWebSocketCloseInfo,
  IWebSocketConnectOptions,
  IWebSocketMessageEnvelope,
  IWebSocketMessageHandler,
  IWebSocketTransport,
} from '@mcp-abap-adt/interfaces';
export { FileCertificateMaterialLoader } from './auth/FileCertificateMaterialLoader.js';
export type {
  SapAuthType,
  SapConfig,
  SapConnectionType,
} from './config/sapConfig.js';
// Config utilities
export { sapConfigSignature } from './config/sapConfig.js';
// Interfaces - re-exported from interfaces package with backward compatibility aliases
export type {
  AbapConnection,
  AbapRequestOptions,
} from './connection/AbapConnection.js';
// Session lifecycle vocabulary — see also ADT_SESSION_ERROR below. disconnect()
// returns a TeardownReport and the session errors carry a code, so a consumer
// that cannot name either is left typing `any` and comparing raw strings, which
// is how a renamed code becomes a silent behaviour change downstream.
export type { TeardownReport } from './connection/AbstractAbapConnection.js';
// Connection classes - only final implementations
// Deprecated aliases for backward compatibility
export {
  BaseAbapConnection,
  BaseAbapConnection as OnPremAbapConnection,
} from './connection/BaseAbapConnection.js';
export { CertificateAbapConnection } from './connection/CertificateAbapConnection.js';
// Factory
export { createAbapConnection } from './connection/connectionFactory.js';
// CSRF configuration
export { CSRF_CONFIG, CSRF_ERROR_MESSAGES } from './connection/csrfConfig.js';
export {
  GenericWebSocketTransport,
  type IWebSocketFactory,
  type IWebSocketLike,
} from './connection/GenericWebSocketTransport.js';
export {
  JwtAbapConnection,
  JwtAbapConnection as CloudAbapConnection,
} from './connection/JwtAbapConnection.js';
export { KerberosAbapConnection } from './connection/KerberosAbapConnection.js';
export { RfcAbapConnection } from './connection/RfcAbapConnection.js';
export { SamlAbapConnection } from './connection/SamlAbapConnection.js';
export type { ILogger } from './logger.js';
export {
  ADT_SESSION_ERROR,
  type AdtSessionErrorCode,
  type WindowToken,
} from './session/SessionLifecycle.js';
// Timeouts
export {
  getTimeout,
  getTimeoutConfig,
  type TimeoutConfig,
} from './utils/timeouts.js';
