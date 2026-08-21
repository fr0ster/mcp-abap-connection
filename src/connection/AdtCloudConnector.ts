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
import { CloudSecuritySessionStrategy } from '../session/CloudSecuritySessionStrategy.js';
import type { SessionStrategy } from '../session/SessionStrategy.js';
import { CredentialAbapConnection } from './CredentialAbapConnection.js';

export class AdtCloudConnector extends CredentialAbapConnection {
  constructor(
    config: SapConfig,
    credential: IAuthProvider,
    logger: ILogger | null = null,
    sessionId?: string,
    /**
     * No `transport`. ABAP Cloud has one, so offering the choice would be
     * offering something that does not exist — and the first caller to take it
     * would find that out at runtime instead of here.
     */
    options?: { skipSessionType?: boolean },
  ) {
    super(config, credential, logger, sessionId, options);
  }

  protected override createSessionStrategy(): SessionStrategy {
    return new CloudSecuritySessionStrategy(this.logger);
  }
}
