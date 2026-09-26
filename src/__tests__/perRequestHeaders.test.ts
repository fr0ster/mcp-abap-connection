/**
 * `sap-adt-request-id` and `X-sap-adt-profiling` belong to the request, not the
 * session.
 *
 * All three headers used to be written together under `if (sessionMode ===
 * 'stateful')`, which held while every write happened inside the lock window.
 * When writes moved out of it — Eclipse holds its stateful session for `LOCK`
 * and `UNLOCK` alone — the writes silently stopped carrying two headers Eclipse
 * sends on everything. Measured on E19 from its ADT trace: the stateless source
 * `PUT`, the unit-test run and the result fetch all carry a fresh
 * `sap-adt-request-id` and `X-sap-adt-profiling: server-time`, while only the
 * two lock requests carry `x-sap-adt-sessiontype`.
 */

import type { SapConfig } from '../config/sapConfig.js';
import { onPrem } from './helpers/onPrem.js';
import { markConnectedForTest } from './helpers/session.js';

const config: SapConfig = {
  url: 'https://sap.example.com',
  authType: 'basic',
  username: 'u',
  password: 'p',
  client: '100',
};

/** Capture what the wire was handed, without sending anything. */
function capturing() {
  const connection = onPrem(config);
  markConnectedForTest(connection);
  const sent: Record<string, string>[] = [];
  const transport = connection.transport as unknown as {
    send: (r: { headers?: Record<string, string> }) => Promise<unknown>;
  };
  transport.send = jest.fn(async (request) => {
    sent.push({ ...(request.headers ?? {}) });
    return { status: 200, statusText: 'OK', headers: {}, data: '' };
  });
  return { connection, sent };
}

describe('per-request headers', () => {
  it('sends a request id on a stateless request', async () => {
    const { connection, sent } = capturing();
    await connection.makeAdtRequest({
      url: '/sap/bc/adt/x',
      method: 'GET',
      timeout: 1000,
    });

    expect(sent[0]['sap-adt-request-id']).toMatch(/^[0-9a-f]{32}$/);
    // The session type is the one that is conditional.
    expect(sent[0]['x-sap-adt-sessiontype']).toBeUndefined();
  });

  it('gives every request its own id', async () => {
    const { connection, sent } = capturing();
    await connection.makeAdtRequest({
      url: '/sap/bc/adt/x',
      method: 'GET',
      timeout: 1000,
    });
    await connection.makeAdtRequest({
      url: '/sap/bc/adt/y',
      method: 'GET',
      timeout: 1000,
    });

    expect(sent[0]['sap-adt-request-id']).not.toBe(
      sent[1]['sap-adt-request-id'],
    );
  });

  it('asks for profiling by default, and stops when told to', async () => {
    const { connection, sent } = capturing();
    await connection.makeAdtRequest({
      url: '/sap/bc/adt/x',
      method: 'GET',
      timeout: 1000,
    });
    expect(sent[0]['X-sap-adt-profiling']).toBe('server-time');

    connection.profiling = null;
    await connection.makeAdtRequest({
      url: '/sap/bc/adt/y',
      method: 'GET',
      timeout: 1000,
    });
    expect(sent[1]['X-sap-adt-profiling']).toBeUndefined();
  });

  it('carries all three while stateful, and only two after', async () => {
    const { connection, sent } = capturing();
    connection.setSessionType('stateful');
    // GET on both: the point is the headers, and a write would drag the CSRF
    // exchange in, which this stub does not answer.
    await connection.makeAdtRequest({
      url: '/sap/bc/adt/x',
      method: 'GET',
      timeout: 1000,
    });
    connection.setSessionType('stateless');
    await connection.makeAdtRequest({
      url: '/sap/bc/adt/y',
      method: 'GET',
      timeout: 1000,
    });

    expect(sent[0]['x-sap-adt-sessiontype']).toBe('stateful');
    expect(sent[1]['x-sap-adt-sessiontype']).toBeUndefined();
    // Both keep the other two, whatever the session mode.
    for (const request of sent) {
      expect(request['sap-adt-request-id']).toMatch(/^[0-9a-f]{32}$/);
      expect(request['X-sap-adt-profiling']).toBe('server-time');
    }
  });
});
