/**
 * A 401 mid-request, and what it does NOT do: open a second session.
 *
 * C — a login-form 401 on a mutation while a CSRF token is cached. Until
 *     16.0.0 the connector discarded the session and fetched a new one; one
 *     instance is one session now, so the 401 reaches the caller as SAP gave
 *     it (through the provider, which the auth contract asks).
 * D — a 401 on a GET: nothing is resent before the provider is asked; the
 *     401 reaches the caller as SAP gave it, in the same session.
 */

import { createServer, type Server } from 'node:http';
import type { SapConfig } from '../../config/sapConfig.js';
import { onPrem } from '../helpers/onPrem.js';

interface Stub {
  baseUrl: string;
  /** Status for the next work request; 401 drives both recovery paths. */
  nextWorkStatus: number;
  /** Body for that response — the login-form shape drives path C. */
  nextWorkBody: string;
  /** How many sessions the discovery endpoint has issued. */
  readonly issued: number;
  /** How many work requests arrived. */
  readonly works: number;
  close(): Promise<void>;
}

async function startStub(): Promise<Stub> {
  const state = { nextWorkStatus: 200, nextWorkBody: '', issued: 0, works: 0 };
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url.includes('/discovery')) {
      state.issued += 1;
      res.writeHead(200, {
        'content-type': 'application/atomsvc+xml',
        'x-csrf-token': `TOKEN-${state.issued}`,
        'set-cookie': [`SAP_SESSIONID_STUB_100=S${state.issued}; Path=/`],
      });
      res.end('<service/>');
      return;
    }
    state.works += 1;
    const status = state.nextWorkStatus;
    const body = state.nextWorkBody;
    state.nextWorkStatus = 200;
    state.nextWorkBody = '';
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get nextWorkStatus() {
      return state.nextWorkStatus;
    },
    set nextWorkStatus(v: number) {
      state.nextWorkStatus = v;
    },
    get nextWorkBody() {
      return state.nextWorkBody;
    },
    get issued() {
      return state.issued;
    },
    get works() {
      return state.works;
    },
    set nextWorkBody(v: string) {
      state.nextWorkBody = v;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}

const configFor = (baseUrl: string): SapConfig => ({
  url: baseUrl,
  client: '100',
  authType: 'basic',
  username: 'STUB',
  password: 'STUB',
});

describe('path C — a login-form 401 on a mutation', () => {
  let stub: Stub;

  beforeEach(async () => {
    stub = await startStub();
  });

  afterEach(async () => {
    await stub.close();
  });

  it('opens no second session: the 401 reaches the caller, the session stays S1', async () => {
    const conn = onPrem(configFor(stub.baseUrl), null);
    await conn.connect();
    expect(conn.getSessionIdentity()).toBe('SAP_SESSIONID_STUB_100=S1');

    stub.nextWorkStatus = 401;
    await expect(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/work',
        method: 'PUT',
        timeout: 5000,
        data: 'x',
      }),
    ).rejects.toMatchObject({
      name: 'AuthRefusedError',
      cause: { response: { status: 401 } },
    });

    // No discovery after the connect's: nothing was re-established.
    expect(stub.issued).toBe(1);
    expect(conn.getSessionIdentity()).toBe('SAP_SESSIONID_STUB_100=S1');
    expect(conn.isConnected()).toBe(true);
  });
});

describe('path D — a 401 on a GET', () => {
  let stub: Stub;

  beforeEach(async () => {
    stub = await startStub();
  });

  afterEach(async () => {
    await stub.close();
  });

  it('resends nothing before the provider: the 401 reaches the caller, the session stays S1', async () => {
    const conn = onPrem(configFor(stub.baseUrl), null);
    await conn.connect();

    stub.nextWorkStatus = 401;
    await expect(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/work',
        method: 'GET',
        timeout: 5000,
      }),
    ).rejects.toMatchObject({
      name: 'AuthRefusedError',
      cause: { response: { status: 401 } },
    });

    // One GET: the Basic provider answers no, so nothing is resent.
    expect(stub.works).toBe(1);
    expect(stub.issued).toBe(1);
    expect(conn.getSessionIdentity()).toBe('SAP_SESSIONID_STUB_100=S1');
    expect(conn.isConnected()).toBe(true);
  });
});
