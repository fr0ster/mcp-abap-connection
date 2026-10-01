/**
 * BASIS 7.40 as a wire, not as a flag.
 *
 * Two things are true of that system and of no other: the stateful header makes
 * the server keep locks in ABAP session memory rather than the enqueue table —
 * so the next `PUT` over such a lock comes back `423` — and it names no HTTP
 * session, so a connection insisting on a `SAP_SESSIONID` would refuse a system
 * that is working fine.
 *
 * Both were one option on the connection, `skipSessionType`, carried in the
 * class every wire shares. A deployment is a transport, so this is one.
 */
import { LegacyOnPremHttpTransport } from '../connection/LegacyOnPremHttpTransport.js';
import { OnPremHttpTransport } from '../connection/OnPremHttpTransport.js';

function wire<T extends OnPremHttpTransport>(transport: T) {
  const seen: Array<Record<string, string>> = [];
  (transport as unknown as { instance: unknown }).instance = async (config: {
    headers?: Record<string, string>;
  }) => {
    seen.push(config.headers ?? {});
    return { status: 200, statusText: 'OK', headers: {}, data: '' };
  };
  return { transport, seen };
}

describe('the legacy on-prem wire', () => {
  it('never sends the session-type header, whatever was asked for', async () => {
    const { transport, seen } = wire(
      new LegacyOnPremHttpTransport(() => ({}), null, {
        baseUrl: 'https://h',
      }),
    );

    await transport.send({
      method: 'GET',
      url: '/sap/bc/adt/discovery',
      headers: {
        'x-sap-adt-sessiontype': 'stateful',
        Accept: 'application/xml',
      },
    });

    // The caller's other headers are untouched; only the one that would move a
    // lock somewhere it cannot be released is dropped.
    expect(seen[0].Accept).toBe('application/xml');
    expect(Object.keys(seen[0]).map((k) => k.toLowerCase())).not.toContain(
      'x-sap-adt-sessiontype',
    );
  });

  it('holds a session, because this system names none and that is not a failure', () => {
    const transport = new LegacyOnPremHttpTransport(() => ({}), null, {
      baseUrl: 'https://h',
    });

    // The ordinary on-prem wire says no until the server names one; this one
    // says yes, because there is nothing to be named. Answering "no session"
    // would refuse a system that works.
    expect(transport.sessionEstablished()).toBe(true);
    expect(new OnPremHttpTransport().sessionEstablished()).toBe(false);
  });

  it('asks for its token where this system has one, and only there', async () => {
    // BASIS 7.40 answers /sap/bc/adt/core/discovery with `200 text/html`, an
    // empty body and no token — not the 404 the ordinary wire falls back on —
    // and hands the token over on /sap/bc/adt/discovery (E77, 2026-09-29).
    const transport = new LegacyOnPremHttpTransport(() => ({}), null, {
      baseUrl: 'https://h',
    });
    const asked: string[] = [];
    (transport as unknown as { send: unknown }).send = async (request: {
      url: string;
    }) => {
      asked.push(request.url);
      return {
        status: 200,
        headers: request.url.endsWith('/sap/bc/adt/discovery')
          ? { 'x-csrf-token': 'TOKEN' }
          : { 'content-type': 'text/html' },
        data: '',
      };
    };

    await transport.establish({
      baseUrl: 'https://h',
      authHeaders: async () => ({}),
      observe: () => {},
      retries: 0,
    });

    expect(asked).toEqual(['https://h/sap/bc/adt/discovery']);
    expect(transport.csrfToken()).toBe('TOKEN');
  });

  it('leaves the ordinary wire asking core/discovery first', async () => {
    const transport = new OnPremHttpTransport(() => ({}), null, {
      baseUrl: 'https://h',
    });
    const asked: string[] = [];
    (transport as unknown as { send: unknown }).send = async (request: {
      url: string;
    }) => {
      asked.push(request.url);
      return { status: 200, headers: { 'x-csrf-token': 'TOKEN' }, data: '' };
    };

    await transport.establish({
      baseUrl: 'https://h',
      authHeaders: async () => ({}),
      observe: () => {},
    });

    expect(asked).toEqual(['https://h/sap/bc/adt/core/discovery']);
  });

  it('is still an on-prem wire, so it fits where one fits', () => {
    const transport = new LegacyOnPremHttpTransport();

    expect(transport.system).toBe('onprem');
    expect(transport.kind).toBe('onprem-http-legacy');
  });

  it('keeps the platform logoff it inherits', async () => {
    const transport = new LegacyOnPremHttpTransport(() => ({}), null, {
      baseUrl: 'https://h',
    });
    const { seen } = wire(transport);
    transport.ingest({ 'set-cookie': ['SAP_SESSIONID_X_100=abc; path=/'] });
    (transport as unknown as { established: boolean }).established = true;

    await transport.close({
      baseUrl: 'https://h',
      authHeaders: async () => ({}),
      observe: () => {},
    });

    // Inherited rather than reimplemented: what differs on 7.40 is the header
    // and the session naming, not how a session is given back.
    expect(seen).toHaveLength(1);
    expect(seen[0].Cookie).toContain('SAP_SESSIONID_X_100');
  });
});
