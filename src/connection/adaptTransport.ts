/**
 * An {@link IAdtTransport} in the shape the request path already calls.
 *
 * The six send sites above this were written against an axios instance — a
 * callable taking a config, and a throw carrying `response` for any status
 * outside 2xx, which is what the retry and 401 classification read. Rather
 * than rewrite all six and risk changing that classification silently, a
 * non-HTTP transport is dressed in the same shape.
 *
 * The HTTP transport is not dressed in anything: it IS the axios instance, so
 * the default path is byte for byte what it was.
 */

import { AxiosError, type AxiosInstance } from 'axios';
import type { IAdtTransport, IAdtTransportRequest } from './IAdtTransport.js';

/** Axios's own default: 2xx resolves, everything else throws. */
const defaultValidateStatus = (status: number) => status >= 200 && status < 300;

export function adaptTransport(transport: IAdtTransport): AxiosInstance {
  const call = async (config: Record<string, unknown>) => {
    const request: IAdtTransportRequest = {
      method: String(config.method ?? 'GET').toUpperCase(),
      url: String(config.url ?? ''),
      headers: (config.headers as Record<string, string> | undefined) ?? {},
      data: config.data,
      params: config.params as Record<string, unknown> | undefined,
      timeout: config.timeout as number | undefined,
      validateStatus: config.validateStatus as
        | ((status: number) => boolean)
        | undefined,
    };

    const response = await transport.send(request);

    const admits =
      (config.validateStatus as ((s: number) => boolean) | undefined) ??
      defaultValidateStatus;
    if (!admits(response.status)) {
      // The shape the classification above reads: `error.response.status` and
      // `error.response.headers`. A transport that resolved here would turn a
      // 401 into a success with a logon page in the body.
      const error = new AxiosError(
        `Request failed with status code ${response.status}`,
        String(response.status),
        undefined,
        undefined,
        response as never,
      );
      throw error;
    }

    return response;
  };

  // `discardSession()` clears interceptors on the instance it holds. Nothing is
  // ever registered on a transport, so clearing is a no-op — but it must exist,
  // or a teardown throws on a connection that never used axios.
  const noop = { clear: () => undefined, use: () => 0, eject: () => undefined };
  (call as unknown as { interceptors: unknown }).interceptors = {
    request: noop,
    response: noop,
  };

  return call as unknown as AxiosInstance;
}
