/**
 * Build a connection: the connector for the system, and the wire it travels
 * over — both stated by the caller.
 *
 * Choosing the wire is the part consumers get wrong, so the four combinations
 * that exist are named here once. Nothing is inferred: not from the config,
 * not from the host name, not from `SapConfig.connectionType`. Taking a
 * system and a transport is the caller stating which system it is dialling
 * and what it travels over — the rule the connectors themselves follow.
 *
 * **Each wire takes its own config shape.** The HTTP wires take an
 * `ISapHttpConfig` (its URL is their base URL), RFC an `ISapRfcConfig` (its
 * stated address, no URL); the compiler refuses the other one.
 *
 * **A new instance on every call.** One connection instance is one SAP
 * session: after its `disconnect()` (or a logoff of its own) it is spent, and
 * a new session is a new call to this.
 *
 * **Or an existing session.** `session` — the cookies an earlier instance's
 * `sessionCookies()` returned — builds the instance on that session instead:
 * `connect()` does not log on, and SAP's answer to its one request says
 * whether the session is alive. HTTP wires only; over RFC it is refused here.
 *
 * Every transport option is passed through as the caller gives it; what is
 * not given takes the constructor's own default, nothing more.
 */
import type { AgentOptions } from 'node:https';
import type { IAuthProvider } from '@mcp-abap-adt/interfaces-auth';
import type {
  ISapHttpConfig,
  ISapRfcConfig,
} from '@mcp-abap-adt/interfaces-auth-sap';
import type { ILogger } from '../logger.js';
import { AdtCloudConnector } from './AdtCloudConnector.js';
import { AdtOnPremConnector } from './AdtOnPremConnector.js';
import { CloudHttpTransport } from './CloudHttpTransport.js';
import { LegacyOnPremHttpTransport } from './LegacyOnPremHttpTransport.js';
import { OnPremHttpTransport } from './OnPremHttpTransport.js';
import { type IRfcTransportOptions, RfcTransport } from './RfcTransport.js';
import { rfcConversationFrom } from './rfcConversation.js';

/** What every combination takes; each states the shape of its `config`. */
interface ConnectionSpecBase<TCredential extends IAuthProvider> {
  /** The credential, handed to the connector as it is. */
  credential: TCredential;
  /** The connection's logger. Absent: none. */
  logger?: ILogger | null | undefined;
  /**
   * The wire's own logger — what it logs about carrying requests. Absent:
   * none, as the transport constructors default. Separate from `logger` so a
   * caller can keep the wire quiet, or route it elsewhere.
   */
  wireLogger?: ILogger | null | undefined;
  /** The client-side conversation id. Absent: a generated one. */
  sessionId?: string | undefined;
}

/** What the HTTP wires take besides. */
interface HttpWireOptions {
  /** The system: its URL and client. An HTTP config, never an RFC one. */
  config: ISapHttpConfig;
  /**
   * The HTTPS agent's options — `ca`, `rejectUnauthorized` and the like, not
   * the credential (its TLS material arrives at logon). Absent: none.
   */
  agentOptions?: (() => AgentOptions) | undefined;
  /**
   * An existing session to build the instance on, instead of logging on: the
   * string an instance's `sessionCookies()` returned. `connect()` then sends
   * no logon; it asks SAP, without the credential, whether that session is
   * alive, and rejects with SAP's answer when it is not. Absent: `connect()`
   * logs on and opens a new session.
   */
  session?: string | undefined;
}

export interface CloudHttpSpec<
  TCredential extends IAuthProvider = IAuthProvider,
> extends ConnectionSpecBase<TCredential>,
    HttpWireOptions {
  system: 'cloud';
  transport: 'http';
}

export interface OnPremHttpSpec<
  TCredential extends IAuthProvider = IAuthProvider,
> extends ConnectionSpecBase<TCredential>,
    HttpWireOptions {
  system: 'onprem';
  /** `legacy-http`: BASIS 7.40, where the stateful header must not be sent. */
  transport: 'http' | 'legacy-http';
}

export interface OnPremRfcSpec<
  TCredential extends IAuthProvider = IAuthProvider,
> extends ConnectionSpecBase<TCredential> {
  system: 'onprem';
  transport: 'rfc';
  /**
   * The system: its stated RFC address, client and language. An RFC config,
   * which has no URL.
   */
  config: ISapRfcConfig;
  /** The RFC wire's own options (`logWire`, `maxLoggedBodyChars`). */
  rfc?: IRfcTransportOptions | undefined;
  /**
   * Not over RFC: its session is a conversation, which cannot be taken over.
   * Refused at construction.
   */
  session?: undefined;
}

export type ConnectionSpec<TCredential extends IAuthProvider = IAuthProvider> =
  | CloudHttpSpec<TCredential>
  | OnPremHttpSpec<TCredential>
  | OnPremRfcSpec<TCredential>;

/** Whatever a caller passed, read as the two words that pick the wire. */
function stated(spec: unknown): { system: unknown; transport: unknown } {
  const record = (spec ?? {}) as { system?: unknown; transport?: unknown };
  return { system: record.system, transport: record.transport };
}

/**
 * What `createConnection` returns: one of the four connections that exist. A
 * caller that needs the exact wire in the type narrows it (`instanceof`), or
 * builds the connection with the constructors, which keep both in the type.
 */
export type CreatedConnection<
  TCredential extends IAuthProvider = IAuthProvider,
> =
  | AdtCloudConnector<TCredential, CloudHttpTransport>
  | AdtOnPremConnector<
      TCredential,
      OnPremHttpTransport | LegacyOnPremHttpTransport | RfcTransport
    >;

/** What an HTTP wire addresses: the config's client and its URL. */
function httpAddress(spec: { config: ISapHttpConfig }): {
  client?: string;
  baseUrl: string;
} {
  return { client: spec.config.client, baseUrl: spec.config.url };
}

export function createConnection<TCredential extends IAuthProvider>(
  spec: ConnectionSpec<TCredential>,
): CreatedConnection<TCredential> {
  const { system, transport } = stated(spec);
  // Fixed words, before anything is built.
  if (
    transport === 'rfc' &&
    (spec as { session?: unknown }).session !== undefined
  ) {
    throw new TypeError(
      "createConnection: an RFC session cannot be taken over — it is a conversation, not something a cookie names. 'session' is for the HTTP wires; over RFC, connect() opens a new session.",
    );
  }
  const logger = spec.logger ?? null;
  const wireLogger = spec.wireLogger ?? null;

  if (system === 'cloud' && transport === 'http') {
    const http = spec as CloudHttpSpec<TCredential>;
    return new AdtCloudConnector(
      http.config,
      spec.credential,
      new CloudHttpTransport(http.agentOptions, wireLogger, httpAddress(http)),
      logger,
      spec.sessionId,
      http.session,
    );
  }
  if (system === 'onprem' && transport === 'http') {
    const http = spec as OnPremHttpSpec<TCredential>;
    return new AdtOnPremConnector(
      http.config,
      spec.credential,
      new OnPremHttpTransport(http.agentOptions, wireLogger, httpAddress(http)),
      logger,
      spec.sessionId,
      http.session,
    );
  }
  if (system === 'onprem' && transport === 'legacy-http') {
    const http = spec as OnPremHttpSpec<TCredential>;
    return new AdtOnPremConnector(
      http.config,
      spec.credential,
      new LegacyOnPremHttpTransport(
        http.agentOptions,
        wireLogger,
        httpAddress(http),
      ),
      logger,
      spec.sessionId,
      http.session,
    );
  }
  if (system === 'onprem' && transport === 'rfc') {
    const rfc = spec as OnPremRfcSpec<TCredential>;
    return new AdtOnPremConnector(
      rfc.config,
      spec.credential,
      new RfcTransport(rfcConversationFrom(rfc.config), wireLogger, rfc.rfc),
      logger,
      spec.sessionId,
    );
  }
  // Fixed words: nothing the caller passed is echoed back.
  throw new TypeError(
    "createConnection: no such combination of system and transport. ABAP Cloud has one wire, 'http'; on-prem takes 'http', 'legacy-http' or 'rfc'. Both are stated by the caller, never inferred.",
  );
}
