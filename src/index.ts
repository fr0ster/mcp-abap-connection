// Types - re-exported from interfaces package with backward compatibility aliases

export type {
  IWebSocketCloseInfo,
  IWebSocketConnectOptions,
  IWebSocketMessageEnvelope,
  IWebSocketMessageHandler,
  IWebSocketTransport,
} from '@mcp-abap-adt/interfaces';
export { FileCertificateMaterialLoader } from './auth/FileCertificateMaterialLoader.js';
// IAuthProvider and ICredentialTransport are deliberately NOT re-exported.
// They live in @mcp-abap-adt/interfaces and a consumer imports them from
// there — the same rule the session-lifecycle vocabulary follows below, and
// for the same reason: two names for one contract let the two drift.
export {
  BasicAuthProvider,
  CertificateAuthProvider,
  SamlAuthProvider,
  TokenAuthProvider,
} from './auth/providers.js';
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
export { AdtCloudConnector } from './connection/AdtCloudConnector.js';
export { AdtOnPremConnector } from './connection/AdtOnPremConnector.js';
// The session lifecycle vocabulary — ISessionLifecycleAware, ADT_SESSION_ERROR —
// is deliberately NOT exported here. It lives in @mcp-abap-adt/interfaces, and a
// consumer imports it from there: re-exporting a contract type gives it two
// names and lets the two drift.
// Connection classes - only final implementations
// Deprecated aliases for backward compatibility
// CSRF configuration
export { CSRF_CONFIG, CSRF_ERROR_MESSAGES } from './connection/csrfConfig.js';
export {
  GenericWebSocketTransport,
  type IWebSocketFactory,
  type IWebSocketLike,
} from './connection/GenericWebSocketTransport.js';
// The transport axis. Both ends are objects, so a caller can name either.
export { HttpTransport } from './connection/HttpTransport.js';
export type {
  IAdtEstablishContext,
  IAdtTransport,
  IAdtTransportRequest,
  IAdtTransportResponse,
} from './connection/IAdtTransport.js';
export {
  type IRfcConversation,
  RfcTransport,
} from './connection/RfcTransport.js';
// The front door to the RFC wire: the derivation a consumer would otherwise
// copy, and the SDK loaded only when a conversation is opened.
export {
  type RfcConnectionParams,
  rfcConversationFrom,
  rfcParamsFrom,
} from './connection/rfcConversation.js';
export type { ILogger } from './logger.js';
// Timeouts
export {
  getTimeout,
  getTimeoutConfig,
  type TimeoutConfig,
} from './utils/timeouts.js';
