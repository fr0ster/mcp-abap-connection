/**
 * An on-prem ABAP system.
 *
 * The session arrives with the establishing call — the logon *is* that call —
 * and the platform's `/sap/public/bc/icf/logoff` is how it is given back. That
 * is what on-prem has always used here, and it does not change.
 *
 * **Taking this class is the consumer stating which system it is dialling.**
 * Nothing is probed and nothing is inferred: `/sap/bc/adt/core/http/sessions` answers on on-prem too —
 * measured on S/4HANA, publishing both the session resource and the ICF logoff
 * in one document — so asking the server tells you an endpoint exists, not
 * which kind of system you reached.
 *
 * The credential is passed in and decides none of this. A bearer token against
 * an on-prem system is ordinary, and it gets this mechanism because the caller
 * asked for this connector — not because of what is in the header, and not
 * because anything worked out where it was pointing.
 */

import type { IAuthProvider } from '@mcp-abap-adt/interfaces';
import type { SapConfig } from '../config/sapConfig.js';
import type { ILogger } from '../logger.js';
import { IcfSessionStrategy } from '../session/IcfSessionStrategy.js';
import type { SessionStrategy } from '../session/SessionStrategy.js';
import { CredentialAbapConnection } from './CredentialAbapConnection.js';
import type { HttpTransport } from './HttpTransport.js';
import type { IAdtTransport } from './IAdtTransport.js';

export class AdtOnPremConnector<
  TCredential extends IAuthProvider = IAuthProvider,
  TTransport extends IAdtTransport = HttpTransport,
> extends CredentialAbapConnection<TCredential> {
  /**
   * The transport this was built with, in the type.
   *
   * `declare` because the base already assigns it — this only narrows what the
   * caller gets back, which is the whole point of the parameter: a signature
   * can ask for `AdtOnPremConnector<IAuthProvider, RfcTransport>` instead of
   * taking any connection and casting.
   */
  declare readonly transport: TTransport;

  constructor(
    config: SapConfig,
    credential: TCredential,
    logger: ILogger | null = null,
    sessionId?: string,
    /**
     * `transport` is the second axis, and on-prem is where it is a real
     * choice: the same ADT call travels over HTTP, or over RFC on a system
     * where stateful HTTP sessions are not usable. Omitted means HTTP — the
     * documented default, not something worked out from the config.
     */
    options?: { skipSessionType?: boolean; transport?: TTransport },
  ) {
    super(config, credential, logger, sessionId, options);
  }

  protected override createSessionStrategy(): SessionStrategy {
    return new IcfSessionStrategy(this.logger);
  }
}
