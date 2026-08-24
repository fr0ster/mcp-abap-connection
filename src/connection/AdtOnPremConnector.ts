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
import { CredentialAbapConnection } from './CredentialAbapConnection.js';
import type { IOnPremTransport } from './IAdtTransport.js';
import type { OnPremHttpTransport } from './OnPremHttpTransport.js';

export class AdtOnPremConnector<
  TCredential extends IAuthProvider = IAuthProvider,
  /**
   * The two wires an on-prem system actually offers. Said by the caller: the
   * same ADT call travels over HTTP, or over RFC on a system where stateful
   * HTTP sessions are not usable.
   */
  TTransport extends IOnPremTransport = OnPremHttpTransport,
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
    transport: TTransport,
    logger: ILogger | null = null,
    sessionId?: string,
  ) {
    super(config, credential, transport, logger, sessionId);
  }
}
