/**
 * What carries an ADT request is a strategy, not a hard-wired axios.
 *
 * On-prem is the system where this is a real choice: the same ADT REST call
 * travels over HTTP or, on a system where stateful HTTP sessions are not
 * usable, over RFC to SADT_REST_RFC_ENDPOINT — the same FM Eclipse ADT uses.
 * Cloud has no such choice, which is why the axis belongs to the on-prem
 * connector rather than to the base class's constructor.
 *
 * Until now the request path called a private `getAxiosInstance()` at six
 * sites, so the only way to put anything else underneath it was to reach in
 * and redefine the private field — which every test in this suite does today,
 * down to faking an `interceptors` object the production code never asked the
 * stub to have. A seam the tests already need is a seam.
 */

import { BasicAuthProvider } from '../auth/providers.js';
import type { SapConfig } from '../config/sapConfig.js';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import type { IAdtTransport } from '../connection/IAdtTransport.js';

const config: SapConfig = {
  url: 'https://sap.example.com',
  authType: 'basic',
  username: 'u',
  password: 'p',
  client: '100',
};

/** A transport that answers everything and records what it was asked. */
function recordingTransport() {
  const seen: Array<{ method?: string; url?: string }> = [];
  const transport: IAdtTransport = {
    kind: 'test',
    send: async (request) => {
      seen.push({ method: request.method, url: request.url });
      return {
        status: 200,
        statusText: 'OK',
        headers: {
          'x-csrf-token': 'TOKEN',
          // A session cookie, because a connection with no SAP_SESSIONID is
          // one nothing can be locked over, and connect() says so rather than
          // pretending. The transport under test is not the subject of that.
          'set-cookie': ['SAP_SESSIONID_STUB_100=abc%3d; path=/'],
        },
        data: '<service/>',
      };
    },
  };
  return { transport, seen };
}

describe('the transport a connection sends through', () => {
  it('is the one it was given', async () => {
    const { transport, seen } = recordingTransport();
    const conn = new AdtOnPremConnector(
      config,
      new BasicAuthProvider('u', 'p'),
      null,
      undefined,
      { transport },
    );

    await conn.connect();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((r) => String(r.url).includes('/sap/bc/adt/'))).toBe(true);
  });

  it('carries the request the caller made', async () => {
    const { transport, seen } = recordingTransport();
    const conn = new AdtOnPremConnector(
      config,
      new BasicAuthProvider('u', 'p'),
      null,
      undefined,
      { transport },
    );
    await conn.connect();
    seen.length = 0;

    await conn.makeAdtRequest({
      url: '/sap/bc/adt/repository/nodestructure',
      method: 'GET',
      timeout: 30000,
    });

    expect(seen).toContainEqual(
      expect.objectContaining({
        method: 'GET',
        url: expect.stringContaining('/sap/bc/adt/repository/nodestructure'),
      }),
    );
  });

  it('names itself, so which one ran is never inferred from behaviour', () => {
    const { transport } = recordingTransport();

    expect(transport.kind).toBe('test');
  });
});
