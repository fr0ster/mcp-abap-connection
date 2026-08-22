/**
 * The on-prem connector when the transport it was given is RFC.
 *
 * Measured against E19 while verifying #41: `SADT_REST_RFC_ENDPOINT` answers
 * with exactly two header fields — `~server_protocol` and `content-type`. No
 * `set-cookie`, and no `x-csrf-token`, on a stateless GET, on a GET that asks
 * for a token with `x-csrf-token: fetch`, and on a stateful POST alike.
 *
 * That is not a quirk of one system. An RFC conversation makes its ABAP session
 * inside the system — there is no ICM in the path, so there is no ICF session
 * to cookie and no cross-site request to forge a token against. The machinery
 * above the seam is therefore managing state that never arrives:
 *
 *   - the CSRF fetch cannot succeed, and after its retries throws
 *     `NOT_IN_HEADERS`, so `connect()` fails outright;
 *   - the cookie jar stays empty, so the ICF logoff `disconnect()` performs has
 *     no session to give back.
 *
 * These say what the connector should do instead. They are about the transport
 * axis only — the cloud connector has one transport and is not touched.
 */

import type { IAuthProvider } from '@mcp-abap-adt/interfaces';
import { BasicAuthProvider } from '../auth/providers.js';
import type { SapConfig } from '../config/sapConfig.js';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import type {
  IAdtTransport,
  IAdtTransportRequest,
  IAdtTransportResponse,
  IOnPremTransport,
} from '../connection/IAdtTransport.js';
import { onPremHttpTransport } from './helpers/onPrem.js';
import { holdsNoSession } from './helpers/transportStub.js';

const config: SapConfig = {
  url: 'http://saphost:8000',
  authType: 'basic',
  username: 'USER',
  password: 'PASS',
  client: '100',
};

const credential: IAuthProvider = new BasicAuthProvider('USER', 'PASS');

/**
 * A transport that answers the way the real FM does: 200, a body, and the two
 * header fields it actually returns. Nothing else — that absence is the point.
 */
function rfcTransport(): {
  transport: IOnPremTransport;
  sent: IAdtTransportRequest[];
} {
  const sent: IAdtTransportRequest[] = [];
  const transport: IOnPremTransport = {
    kind: 'rfc',
    // A stub is a wire like any other, and says which system it is for.
    system: 'onprem',
    ...holdsNoSession,
    // The conversation IS the session, so this wire is never on none — which is
    // what `RfcTransport` reports, and what the fingerprint check reads.
    sessionFingerprint: () => new Map([['rfc-conversation', 'C1']]),
    open: async () => {},
    close: async () => {},
    send: async (
      request: IAdtTransportRequest,
    ): Promise<IAdtTransportResponse> => {
      sent.push(request);
      return {
        status: 200,
        statusText: 'OK',
        headers: {
          '~server_protocol': 'HTTP/1.1',
          'content-type': 'application/atomsvc+xml',
        },
        data: '<service/>',
      };
    },
  };
  return { transport, sent };
}

const onPremOverRfc = () => {
  const { transport, sent } = rfcTransport();
  const conn = new AdtOnPremConnector(config, credential, transport, null);
  return { conn, sent };
};

describe('connect() over an RFC transport', () => {
  it('establishes without a CSRF token, because the wire never returns one', async () => {
    const { conn } = onPremOverRfc();

    await expect(conn.connect()).resolves.toBeUndefined();
  });

  it('does not spend requests fetching a token that cannot arrive', async () => {
    const { conn, sent } = onPremOverRfc();

    await conn.connect();

    const csrfAttempts = sent.filter(
      (request) =>
        String(
          (request.headers as Record<string, string> | undefined)?.[
            'x-csrf-token'
          ] ?? '',
        ) === 'fetch',
    );
    expect(csrfAttempts).toHaveLength(0);
  });

  it('addresses the wire with a path, never an absolute URL', async () => {
    // The CSRF fetch built `${baseUrl}${ENDPOINT}`; handed that URI,
    // SADT_REST_RFC_ENDPOINT dumped with STRING_OFFSET_TOO_LARGE on E19.
    const { conn, sent } = onPremOverRfc();

    await conn.connect();

    for (const request of sent) {
      expect(request.url.startsWith('/')).toBe(true);
    }
  });
});

describe('disconnect() over an RFC transport', () => {
  it('gives the conversation back instead of asking ICF to log off', async () => {
    const { conn, sent } = onPremOverRfc();
    await conn.connect();
    sent.length = 0;

    await conn.disconnect();

    const logoffs = sent.filter((request) =>
      request.url.includes('/sap/public/bc/icf/logoff'),
    );
    expect(logoffs).toHaveLength(0);
  });

  it('closes the transport it was given', async () => {
    const { transport, sent } = rfcTransport();
    const closed = jest.fn(async () => {});
    transport.close = closed;
    const conn = new AdtOnPremConnector(config, credential, transport, null);
    await conn.connect();
    sent.length = 0;

    await conn.disconnect();

    expect(closed).toHaveBeenCalled();
  });
});

describe('a mutation over an RFC transport', () => {
  it('is not held up asking for a token the wire cannot have', async () => {
    // Before a mutation the connection makes sure the wire is ready. Over HTTP
    // that means a CSRF token; over RFC there is none to hold, and demanding
    // one raised `No CSRF token in response headers` on every write — swallowed,
    // but logged as an error and asked again on the next one.
    const { conn, sent } = onPremOverRfc();
    await conn.connect();
    const errors: string[] = [];
    (conn as any).logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (m: string) => errors.push(m),
    };
    sent.length = 0;

    await conn.makeAdtRequest({
      url: '/sap/bc/adt/oo/classes/zcl_x',
      method: 'POST',
      timeout: 30000,
      data: '<x/>',
    });

    expect(errors.filter((m) => /csrf/i.test(m))).toEqual([]);
  });
});
