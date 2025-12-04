// Import interfaces from shared package
import type { ILogger, ISessionStorage, ISessionState } from '@mcp-abap-adt/interfaces';

// Re-export for backward compatibility
export type { ILogger, ISessionStorage };
export type SessionState = ISessionState;

