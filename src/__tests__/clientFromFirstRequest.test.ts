/**
 * The SAP client (mandant) is addressed from the FIRST request on.
 *
 * ICF takes the client from the `sap-client` header or query parameter, or from
 * the `sap-usercontext` cookie — never from `X-SAP-Client`, which it ignores.
 * The client used to reach the system only through the cookie, and the wire
 * holds that cookie only once a response has set it: the first request — the
 * one that opens the session and earns the CSRF token — landed in the system's
 * DEFAULT client, and a wrong client failed one request late.
 *
 * A local server that picks the client the way ICF does, for each HTTP wire.
 */
import { createServer, type Server } from 'node:http';
import { BasicAuthProvider } from '@mcp-abap-adt/auth-providers';
import type { SapConfig } from '../config/sapConfig.js';
import { AdtCloudConnector } from '../connection/AdtCloudConnector.js';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import { CloudHttpTransport } from '../connection/CloudHttpTransport.js';
import { LegacyOnPremHttpTransport } from '../connection/LegacyOnPremHttpTransport.js';
import { OnPremHttpTransport } from '../connection/OnPremHttpTransport.js';

const DEFAULT_CLIENT = '100';
const CLIENTS = new Set(['100', '200']);
const SESSIONS = '/sap/bc/adt/core/http/sessions';
const SECURITY_SESSION_REL =
  'http://www.sap.com/adt/categories/core/http/sessions/securitysession';

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  /** The client this request landed in, as ICF would pick it. */
  client: string;
}

/** `sap-client` header, then the `sap-usercontext` cookie, then the default. */
function clientOf(headers: Record<string, string>): string {
  if (headers['sap-client']) return headers['sap-client'];
  const context = (headers.cookie ?? '')
    .split(/;\s*/)
    .find((pair) => pair.startsWith('sap-usercontext='));
  const named = context?.match(/sap-client=(\d{3})/)?.[1];
  return named ?? DEFAULT_CLIENT;
}

async function startIcf(): Promise<{
  baseUrl: string;
  seen: Seen[];
  close(): Promise<void>;
}> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers[name] = value;
      }
      const path = (req.url ?? '').split('?')[0];
      const client = clientOf(headers);
      seen.push({ method: req.method ?? 'GET', path, headers, client });

      // A client the system does not have refuses the logon — as SAP does.
      if (!CLIENTS.has(client)) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('Logon failed');
        return;
      }
      // SAP answers with the client the request landed in.
      const cookies = [
        `SAP_SESSIONID_STUB_${client}=S1; Path=/`,
        `sap-usercontext=sap-client=${client}; Path=/`,
      ];
      if (path === SESSIONS) {
        res.writeHead(200, {
          'content-type': 'application/xml',
          'set-cookie': cookies,
        });
        res.end(
          `<session><link rel="${SECURITY_SESSION_REL}" href="${SESSIONS}/1"/></session>`,
        );
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/xml',
        'x-csrf-token': 'TOKEN',
        'set-cookie': cookies,
      });
      res.end('<service/>');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    seen,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

type Wire = 'onprem' | 'legacy-onprem' | 'cloud';

function connectorFor(wire: Wire, baseUrl: string, client: string) {
  const config = { url: baseUrl, client, authType: 'basic' } as SapConfig;
  const credential = new BasicAuthProvider('USER', 'PASS');
  const options = { client, baseUrl };
  if (wire === 'cloud') {
    return new AdtCloudConnector(
      config,
      credential,
      new CloudHttpTransport(() => ({}), null, options),
      null,
    );
  }
  const transport =
    wire === 'legacy-onprem'
      ? new LegacyOnPremHttpTransport(() => ({}), null, options)
      : new OnPremHttpTransport(() => ({}), null, options);
  return new AdtOnPremConnector(config, credential, transport, null);
}

let icf: Awaited<ReturnType<typeof startIcf>>;

beforeEach(async () => {
  icf = await startIcf();
});

afterEach(async () => {
  await icf.close();
});

describe.each<Wire>(['onprem', 'legacy-onprem', 'cloud'])(
  'the %s wire addresses its client',
  (wire) => {
    it('on the very first request, with the sap-client header and the sap-usercontext cookie', async () => {
      const conn = connectorFor(wire, icf.baseUrl, '200');

      await conn.connect();

      const first = icf.seen[0];
      expect(first).toBeDefined();
      // The cloud wire's first request is its session preflight; on-prem's is
      // the discovery that earns the token. Either way it is the first.
      expect(first.path).toBe(
        wire === 'cloud' ? SESSIONS : '/sap/bc/adt/core/discovery',
      );
      expect(first.headers['sap-client']).toBe('200');
      expect(first.headers.cookie).toContain('sap-usercontext=sap-client=200');
      expect(first.headers['x-sap-client']).toBeUndefined();
      // Every request landed in the client that was asked for.
      expect(icf.seen.map((request) => request.client)).toEqual(
        icf.seen.map(() => '200'),
      );

      await conn.disconnect();
      await conn.flushGoodbye();

      // The goodbye is sent detached, not dressed — and says the client too.
      const goodbye = icf.seen[icf.seen.length - 1];
      expect(goodbye.path).toBe(
        wire === 'cloud' ? `${SESSIONS}/1` : '/sap/public/bc/icf/logoff',
      );
      expect(goodbye.headers['sap-client']).toBe('200');
      expect(goodbye.client).toBe('200');
    });

    it('a client the system does not have fails the first request, and nothing follows it', async () => {
      const conn = connectorFor(wire, icf.baseUrl, '999');

      if (wire === 'cloud') {
        // The preflight is not fatal by design; the establishment after it is.
        await expect(conn.connect()).rejects.toBeDefined();
        expect(icf.seen.every((request) => request.client === '999')).toBe(
          true,
        );
        expect(icf.seen[0].path).toBe(SESSIONS);
      } else {
        await expect(conn.connect()).rejects.toBeDefined();
        expect(icf.seen).toHaveLength(1);
        expect(icf.seen[0].client).toBe('999');
      }
      // Never the default client: nothing reached a session there.
      expect(
        icf.seen.some((request) => request.client === DEFAULT_CLIENT),
      ).toBe(false);
    });
  },
);

/**
 * The client belongs to the connection. Another client is another logon — its
 * own user, password, session and CSRF token — so a caller's `sap-client` that
 * names a different one is refused before anything is sent, rather than
 * landing a request in one client with the session and credential of another.
 */
describe.each<Wire>(['onprem', 'legacy-onprem', 'cloud'])(
  'the %s wire keeps the client its connection was given',
  (wire) => {
    const CALLER_ADDRESSED: ReadonlyArray<
      [
        string,
        {
          headers?: Record<string, string>;
          url?: string;
          params?: Record<string, unknown>;
        },
      ]
    > = [
      ['a sap-client params entry', { params: { 'sap-client': '100' } }],
      [
        'an SAP-CLIENT params list with another client in it',
        { params: { 'SAP-CLIENT': ['200', '100'] } },
      ],
      ['a sap-client header', { headers: { 'sap-client': '100' } }],
      ['a SAP-Client header', { headers: { 'SAP-Client': '100' } }],
      ['a sap-client query parameter', { url: '/sap/bc/adt/x?sap-client=100' }],
      [
        'an SAP-CLIENT query parameter',
        { url: '/sap/bc/adt/x?SAP-CLIENT=100' },
      ],
    ];

    it.each(CALLER_ADDRESSED)(
      'refuses %s naming another client, and sends nothing',
      async (_label, request) => {
        const conn = connectorFor(wire, icf.baseUrl, '200');
        await conn.connect();
        const before = icf.seen.length;

        await expect(
          conn.makeAdtRequest({
            url: request.url ?? '/sap/bc/adt/x',
            method: 'GET',
            timeout: 5000,
            ...(request.headers ? { headers: request.headers } : {}),
            ...(request.params ? { params: request.params } : {}),
          }),
        ).rejects.toThrow(/client 100.*connection.*client 200/);
        expect(icf.seen.length).toBe(before);
        expect(icf.seen.some((seen) => seen.client === '100')).toBe(false);

        await conn.disconnect();
      },
    );

    it('lets a caller name the same client, and sends it once', async () => {
      const conn = connectorFor(wire, icf.baseUrl, '200');
      await conn.connect();

      await conn.makeAdtRequest({
        url: '/sap/bc/adt/x?sap-client=200',
        method: 'GET',
        timeout: 5000,
        headers: { 'SAP-Client': '200' },
        params: { 'Sap-Client': '200' },
      });

      const last = icf.seen[icf.seen.length - 1];
      expect(last.client).toBe('200');
      expect(last.headers['sap-client']).toBe('200');

      await conn.disconnect();
    });
  },
);

describe('a wire given no client', () => {
  it('refuses a caller that names one: the client is the connection’s', async () => {
    const config = { url: icf.baseUrl, authType: 'basic' } as SapConfig;
    const conn = new AdtOnPremConnector(
      config,
      new BasicAuthProvider('USER', 'PASS'),
      new OnPremHttpTransport(() => ({}), null, { baseUrl: icf.baseUrl }),
      null,
    );
    await conn.connect();
    const before = icf.seen.length;

    await expect(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/x',
        method: 'GET',
        timeout: 5000,
        headers: { 'sap-client': '200' },
      }),
    ).rejects.toThrow(/client 200.*connection.*no client/);
    await expect(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/x',
        method: 'GET',
        timeout: 5000,
        params: { 'sap-client': '200' },
      }),
    ).rejects.toThrow(/client 200.*connection.*no client/);
    expect(icf.seen.length).toBe(before);

    await conn.disconnect();
  });

  it('says none, and the system picks its default', async () => {
    const config = { url: icf.baseUrl, authType: 'basic' } as SapConfig;
    const conn = new AdtOnPremConnector(
      config,
      new BasicAuthProvider('USER', 'PASS'),
      new OnPremHttpTransport(() => ({}), null, { baseUrl: icf.baseUrl }),
      null,
    );

    await conn.connect();

    const first = icf.seen[0];
    expect(first.headers['sap-client']).toBeUndefined();
    expect(first.headers.cookie).toBeUndefined();
    expect(first.client).toBe(DEFAULT_CLIENT);

    await conn.disconnect();
  });
});
