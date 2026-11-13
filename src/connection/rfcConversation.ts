/**
 * An RFC conversation, from the config a consumer already holds.
 *
 * `RfcTransport` takes a factory rather than connection parameters, and that is
 * deliberate: `@mcp-abap-adt/sap-rfc-lite` needs the SAP NW RFC SDK on the
 * machine, and a transport that reached for it in its constructor could not be
 * built at all where it is absent. But a factory is a poor front door — without
 * this, reaching the RFC wire means every consumer writing the `require` and
 * mapping the config to the SDK's parameters for themselves.
 *
 * So the mapping lives here, once, and the SDK is still only touched when a
 * conversation is actually opened.
 */

import type { ISapRfcConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import type {
  IRfcConversation,
  RfcConversationFactory,
} from './RfcTransport.js';

/**
 * Where the native client dials: one application server. What it logs on with
 * is not here: the provider writes that at each logon (`user`/`passwd`, or the
 * SNC keys), and the factory spreads it over these.
 */
export interface RfcConnectionParams {
  ashost: string;
  sysnr: string;
  client: string;
  lang: string;
  saprouter?: string;
}

/**
 * Where the native client dials: a message server, which picks an application
 * server of the logon group (load-balanced logon). The keys are the SAP NW RFC
 * SDK's own; `msserv`, `sysid` or both name the message server's service.
 */
export type RfcMessageServerParams = {
  mshost: string;
  group: string;
  client: string;
  lang: string;
  saprouter?: string;
} & ({ msserv: string; sysid?: string } | { msserv?: string; sysid: string });

/** One application server, or a message server and a logon group. */
export type RfcAddress = RfcConnectionParams | RfcMessageServerParams;

/**
 * The address the config states, in the SDK's terms — read as given, never
 * asked of the server.
 *
 * Nothing is derived and nothing is added: no default client, language or
 * logon group, no host or system number taken from a URL, nothing read from
 * the environment, no value trimmed. `language` is the SDK's `lang`;
 * `msserv`, `sysid` and `saprouter` are there exactly when the config states
 * them. It refuses nothing: the config's type proves the address complete,
 * and data from outside the type system is checked where it is read.
 *
 * The address only: no username or password is read from the config.
 */
export function rfcParamsFrom(config: ISapRfcConfig): RfcAddress {
  const router =
    config.saprouter === undefined ? {} : { saprouter: config.saprouter };
  const logon = { client: config.client, lang: config.language, ...router };

  if (config.mshost === undefined) {
    return { ashost: config.ashost, sysnr: config.sysnr, ...logon };
  }

  const service =
    config.msserv === undefined
      ? { sysid: config.sysid }
      : {
          msserv: config.msserv,
          ...(config.sysid === undefined ? {} : { sysid: config.sysid }),
        };
  return { mshost: config.mshost, group: config.group, ...service, ...logon };
}

/**
 * The factory `RfcTransport` asks for: the logon parameters the provider wrote
 * for this open go in, spread over the address the config states; nothing
 * else is added.
 *
 * It states its logon language (`language`, the config's), so `RfcTransport`
 * can tell a request that names another `sap-language` apart.
 *
 * The SDK is loaded when a conversation is opened, not when this is called, so
 * a consumer can build the transport on a machine that has no SDK and find out
 * at `connect()` rather than at construction — with a message that says what to
 * install.
 */
export function rfcConversationFrom(
  config: ISapRfcConfig,
): RfcConversationFactory & { readonly language: string } {
  const params = rfcParamsFrom(config);

  const open = (logon: Readonly<Record<string, string>>): IRfcConversation => {
    let Client: new (
      params: RfcAddress & Readonly<Record<string, string>>,
    ) => IRfcConversation;
    try {
      // Dynamic, because the SDK is an optional peer: it needs the SAP NW RFC
      // SDK installed on the machine, and most consumers travel over HTTP.
      Client = require('@mcp-abap-adt/sap-rfc-lite').Client;
    } catch {
      // The loader's words are not quoted: they name paths on this machine.
      throw new Error(
        '@mcp-abap-adt/sap-rfc-lite is not available. To take the RFC wire, ' +
          'install the SAP NW RFC SDK and run: npm install @mcp-abap-adt/sap-rfc-lite.',
      );
    }
    return new Client({ ...params, ...logon });
  };
  // The language every conversation it opens logs on in, unless the logon
  // names another: what `RfcTransport` tells a request's `sap-language` apart
  // from.
  return Object.assign(open, { language: params.lang });
}
