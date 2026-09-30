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
 * Where the native client dials. What it logs on with is not here: the
 * provider writes that at each logon (`user`/`passwd`, or the SNC keys), and
 * the factory spreads it over these.
 */
export interface RfcConnectionParams {
  ashost: string;
  sysnr: string;
  client: string;
  lang: string;
}

/**
 * Read out of the config, never asked of the server.
 *
 * The system number comes off the HTTP port by the SAP convention that 80XX is
 * the ICM port for system XX — the convention the port itself follows, not a
 * guess about the deployment. `SAP_SYSNR` overrides it for a port that follows
 * no convention, which is the case on a system reached through 50400.
 *
 * The address only: no username or password is read from the config.
 */
export function rfcParamsFrom(config: SapConfig): RfcConnectionParams {
  if (!config.url) {
    throw new Error('An RFC conversation needs a url to take its host from');
  }

  const parsed = new URL(config.url);
  const port = Number.parseInt(parsed.port || '8000', 10);
  const derived = String(port - 8000).padStart(2, '0');

  return {
    ashost: parsed.hostname,
    sysnr: process.env.SAP_SYSNR?.trim() || derived,
    client: config.client || '000',
    lang: 'EN',
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
      params: RfcConnectionParams & Readonly<Record<string, string>>,
    ) => IRfcConversation;
    try {
      // Dynamic, because the SDK is an optional peer: it needs the SAP NW RFC
      // SDK installed on the machine, and most consumers travel over HTTP.
      // biome-ignore lint/correctness/noNodejsModules: optional by design
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
