/**
 * An RFC conversation, from the config a consumer already holds.
 *
 * `RfcTransport` takes a factory rather than connection parameters, and that is
 * deliberate: `@mcp-abap-adt/sap-rfc-lite` needs the SAP NW RFC SDK on the
 * machine, and a transport that reached for it in its constructor could not be
 * built at all where it is absent. But a factory is a poor front door — without
 * this, reaching the RFC wire means every consumer writing the `require` and
 * deriving `ashost` and `sysnr` for themselves, which is the derivation the
 * per-transport connection class used to do for them.
 *
 * So the derivation lives here, once, and the SDK is still only touched when a
 * conversation is actually opened.
 */

import type { SapConfig } from '../config/sapConfig.js';
import type { IRfcConversation } from './RfcTransport.js';

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
 * SDK's own; one of `msserv` and `sysid` names the message server's service.
 */
export interface RfcMessageServerParams {
  mshost: string;
  msserv?: string;
  sysid?: string;
  group: string;
  client: string;
  lang: string;
  saprouter?: string;
}

/** One application server, or a message server and a logon group. */
export type RfcAddress = RfcConnectionParams | RfcMessageServerParams;

/**
 * Read out of the config, never asked of the server.
 *
 * **A message server**, when the config states `mshost`: the SDK needs the
 * message server's service, so `msserv` or `sysid` must be there too, and the
 * logon group is `group` or SAP's default `PUBLIC`. `url` then gives no host
 * and no system number — the message server chooses the application server.
 *
 * **One application server** otherwise: the host comes off `url`, and the
 * system number off the HTTP port by the SAP convention that 80XX is the ICM
 * port for system XX — the convention the port itself follows, not a guess
 * about the deployment. `SAP_SYSNR` overrides it for a port that follows no
 * convention, which is the case on a system reached through 50400.
 *
 * `saprouter` goes with either. The address only: no username or password is
 * read from the config.
 */
export function rfcParamsFrom(config: SapConfig): RfcAddress {
  const client = config.client || '000';
  const router = config.saprouter ? { saprouter: config.saprouter } : {};

  if (config.mshost) {
    if (!config.msserv && !config.sysid) {
      throw new Error(
        'An RFC conversation through a message server needs msserv or sysid beside mshost',
      );
    }
    return {
      mshost: config.mshost,
      ...(config.msserv ? { msserv: config.msserv } : {}),
      ...(config.sysid ? { sysid: config.sysid } : {}),
      group: config.group || 'PUBLIC',
      client,
      lang: 'EN',
      ...router,
    };
  }

  if (!config.url) {
    throw new Error(
      'An RFC conversation needs a url to take its host from, or mshost for a message server',
    );
  }

  const parsed = new URL(config.url);
  const port = Number.parseInt(parsed.port || '8000', 10);
  const derived = String(port - 8000).padStart(2, '0');

  return {
    ashost: parsed.hostname,
    sysnr: process.env.SAP_SYSNR?.trim() || derived,
    client,
    lang: 'EN',
    ...router,
  };
}

/**
 * The factory `RfcTransport` asks for: the logon parameters the provider wrote
 * for this open go in, spread over the address from the config.
 *
 * The SDK is loaded when a conversation is opened, not when this is called, so
 * a consumer can build the transport on a machine that has no SDK and find out
 * at `connect()` rather than at construction — with a message that says what to
 * install.
 */
export function rfcConversationFrom(
  config: SapConfig,
): (logon: Readonly<Record<string, string>>) => IRfcConversation {
  const params = rfcParamsFrom(config);

  return (logon) => {
    let Client: new (
      params: RfcAddress & Readonly<Record<string, string>>,
    ) => IRfcConversation;
    try {
      // Dynamic, because the SDK is an optional peer: it needs the SAP NW RFC
      // SDK installed on the machine, and most consumers travel over HTTP.
      Client = require('@mcp-abap-adt/sap-rfc-lite').Client;
    } catch (error) {
      throw new Error(
        '@mcp-abap-adt/sap-rfc-lite is not available. To take the RFC wire, ' +
          'install the SAP NW RFC SDK and run: npm install @mcp-abap-adt/sap-rfc-lite. ' +
          `Details: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return new Client({ ...params, ...logon });
  };
}
