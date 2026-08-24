/**
 * An ABAP Cloud system.
 *
 * A session there is a **resource**: asked for at
 * `/sap/bc/adt/core/http/sessions` with `x-sap-security-session: create` and
 * `sap-adt-purpose: preflight_logon`, and given back by `DELETE` on the address
 * the server publishes in the answer. Reproduced from Eclipse ADT 3.60 and
 * measured against a BTP trial: without that request the same connection gets
 * `sap-usercontext` and `sap-XSRF_*` and no session for a lock to be bound to,
 * which is how "cloud issues no SAP_SESSIONID" came to be believed.
 *
 * **Taking this class is the consumer stating which system it is dialling**, and
 * it is the only thing that states it: a communication user against ABAP Cloud
 * gets this mechanism because the caller asked for this connector. Nothing is
 * inferred — not from the credential, not from the host name, not from what the
 * server answers.
 */

import type { IAuthProvider } from '@mcp-abap-adt/interfaces';
import type { SapConfig } from '../config/sapConfig.js';
import type { ILogger } from '../logger.js';
import type { CloudHttpTransport } from './CloudHttpTransport.js';
import { CredentialAbapConnection } from './CredentialAbapConnection.js';
import type { ICloudTransport } from './IAdtTransport.js';

export class AdtCloudConnector<
  TCredential extends IAuthProvider = IAuthProvider,
  /**
   * Constrained to the cloud wire, so "cloud over RFC" does not compile.
   * There is no such deployment, and a connector that accepted the transport
   * would be offering a combination that cannot exist.
   */
  TTransport extends ICloudTransport = CloudHttpTransport,
> extends CredentialAbapConnection<TCredential> {
  declare readonly transport: TTransport;

  constructor(
    config: SapConfig,
    credential: TCredential,
    transport: TTransport,
    logger: ILogger | null = null,
    sessionId?: string,
  ) {
    super(config, credential, transport, logger, sessionId);
  }
}
