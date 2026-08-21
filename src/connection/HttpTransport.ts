/**
 * An ADT request carried over HTTP.
 *
 * The obvious one, and until now the one that did not exist as a thing: RFC was
 * an object while HTTP was a branch inside `getAxiosInstance()`. An axis with a
 * code path on one end cannot be named in a type — a default type parameter has
 * nothing to point at — so this is what makes the two ends symmetrical.
 *
 * No `open()` or `close()`. A request opens its own socket and there is no
 * conversation to establish or give back; those members exist for a transport
 * that owns a wire, which is RFC.
 *
 * **Where the two axes touch.** TLS client-certificate material comes from the
 * CREDENTIAL — a certificate authenticates through the transport rather than
 * through a header — and configures this. It is taken as a thunk rather than a
 * value so it is read when the client is first built, by which time the
 * credential has been prepared and knows what it holds. Read in a constructor,
 * it would be whatever was loaded before the connection started, which for a
 * certificate is nothing.
 */

import { Agent, type AgentOptions } from 'node:https';
import axios, { type AxiosInstance } from 'axios';
import type { ILogger } from '../logger.js';
import type {
  IAdtTransport,
  IAdtTransportRequest,
  IAdtTransportResponse,
} from './IAdtTransport.js';

export class HttpTransport implements IAdtTransport {
  readonly kind = 'http';

  private instance: AxiosInstance | null = null;

  constructor(
    private readonly agentOptions: () => AgentOptions = () => ({}),
    private readonly logger: ILogger | null = null,
  ) {}

  private client(): AxiosInstance {
    if (!this.instance) {
      // Kept as it was: an explicit opt-IN, so a misread env var cannot quietly
      // turn verification off.
      const rejectUnauthorized =
        process.env.NODE_TLS_REJECT_UNAUTHORIZED === '1' ||
        (process.env.TLS_REJECT_UNAUTHORIZED === '1' &&
          process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0');

      this.logger?.debug(
        `TLS configuration: rejectUnauthorized=${rejectUnauthorized}`,
      );

      this.instance = axios.create({
        httpsAgent: new Agent({
          rejectUnauthorized,
          ...this.agentOptions(),
        }),
      });
    }
    return this.instance;
  }

  /**
   * Throws for a status the request does not admit — by doing nothing, because
   * that is already what axios does, and `AxiosError` already carries
   * `response`. The contract was written to describe this behaviour rather than
   * to add it.
   */
  async send(request: IAdtTransportRequest): Promise<IAdtTransportResponse> {
    const response = await this.client()({
      method: request.method,
      url: request.url,
      headers: request.headers,
      ...(request.data !== undefined ? { data: request.data } : {}),
      ...(request.params !== undefined ? { params: request.params } : {}),
      ...(request.timeout !== undefined ? { timeout: request.timeout } : {}),
      ...(request.validateStatus !== undefined
        ? { validateStatus: request.validateStatus }
        : {}),
    });

    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      data: response.data,
    };
  }
}
