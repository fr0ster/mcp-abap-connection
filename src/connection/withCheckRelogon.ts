import {
  ADT_SESSION_ERROR,
  type IAdtWireResponse,
} from '@mcp-abap-adt/interfaces-adt-connection';
import type { AbapRequestOptions } from './AbapConnection.js';
import { carriesSessionLost } from './AbstractAbapConnection.js';
import type { CreatedConnection } from './createConnection.js';
import { refusalOf } from './IAdtTransport.js';
import { isStatefulRequest } from './statefulRequest.js';

/**
 * The syntax-check POST is a read. A 403 explicitly rejecting its CSRF token
 * means SAP did not run it. Retry on a separate session only when that same
 * response proved the original session gone.
 */
export function withCheckRelogon<TConnection extends CreatedConnection>(
  connection: TConnection,
  fresh: () => TConnection,
): TConnection {
  const send = connection.makeAdtRequest.bind(connection);
  const disconnect = connection.disconnect.bind(connection);
  const pending = new Set<() => Promise<void>>();
  let closing = false;

  connection.disconnect = async () => {
    closing = true;
    await Promise.all([disconnect(), ...Array.from(pending, (stop) => stop())]);
  };

  connection.makeAdtRequest = async <T, D>(
    request: AbapRequestOptions,
  ): Promise<IAdtWireResponse<T, D>> => {
    const eligible =
      request.method.toUpperCase() === 'POST' &&
      request.url.split('?', 1)[0] === '/sap/bc/adt/checkruns' &&
      typeof request.data === 'string' &&
      connection.getSessionMode() === 'stateless' &&
      !connection.isInCriticalSection() &&
      !isStatefulRequest({
        url: request.url,
        method: request.method,
        headers: request.headers,
      });
    try {
      return await send<T, D>(request);
    } catch (error) {
      if (!eligible || closing || !carriesSessionLost(error)) throw error;
      const refusal = refusalOf(error);
      if (
        refusal?.status !== 403 ||
        typeof refusal.data !== 'string' ||
        !refusal.data.includes('CSRF token validation failed')
      )
        throw error;

      const replacement = fresh();
      let stopped: Promise<void> | undefined;
      const stop = () => (stopped ??= replacement.disconnect());
      pending.add(stop);
      try {
        await replacement.connect();
        if (closing) throw error;
        const result = await replacement.makeAdtRequest<T, D>(request);
        return { ...result, sessionLost: ADT_SESSION_ERROR.SESSION_REPLACED };
      } finally {
        // Disconnect waits until the logoff is written, as for any session.
        // A caller closing during recovery shares this same disconnect.
        try {
          await stop();
        } finally {
          pending.delete(stop);
        }
      }
    }
  };
  return connection;
}
