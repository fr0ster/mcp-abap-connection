/**
 * The HTTP wire's own state: cookies, the client it insists on, and the
 * application server it is bound to.
 *
 * All of it used to live in `AbstractAbapConnection`, the class every connector
 * shares — which is why a connection over RFC inherited a cookie jar it can
 * never fill and a session fingerprint scanned out of it. None of that is
 * common to all connectors; it is what HTTP is, so it belongs to HTTP.
 *
 * What stays above: the generation fence that decides whether a response may
 * be folded in at all, and what a changed fingerprint MEANS. Those are session
 * lifecycle, not wire state.
 */
import { HttpTransport } from '../connection/HttpTransport.js';

const setCookie = (...entries: string[]) => ({ 'set-cookie': entries });

describe('the cookies the wire holds', () => {
  it('keeps what a response set', () => {
    const transport = new HttpTransport();

    transport.ingest(setCookie('SAP_SESSIONID_E19_100=ABC; path=/'));

    expect(transport.cookies()).toContain('SAP_SESSIONID_E19_100=ABC');
  });

  it('keeps earlier cookies a later response did not mention', () => {
    const transport = new HttpTransport();

    transport.ingest(setCookie('SAP_SESSIONID_E19_100=ABC'));
    transport.ingest(setCookie('MYSAPSSO2=TICKET'));

    expect(transport.cookies()).toContain('SAP_SESSIONID_E19_100=ABC');
    expect(transport.cookies()).toContain('MYSAPSSO2=TICKET');
  });

  it('holds nothing before a response has set anything', () => {
    expect(new HttpTransport().cookies()).toBeNull();
  });

  it('holds nothing when a response set no cookie', () => {
    // The client assertion applies TO the cookies a response brought; on its
    // own it would hand a wire that was issued nothing a Cookie header to send.
    const transport = new HttpTransport(undefined, null, { client: '100' });

    transport.ingest({ 'content-type': 'application/xml' });

    expect(transport.cookies()).toBeNull();
  });

  it('insists on the client it was configured with', () => {
    // SAP answers `sap-usercontext` with the system default, which routes later
    // requests to a client the caller never asked for — a read-only one turns
    // every write into a 403.
    const transport = new HttpTransport(undefined, null, { client: '100' });

    transport.ingest(setCookie('sap-usercontext=sap-client=000'));

    expect(transport.cookies()).toContain('sap-usercontext=sap-client=100');
  });
});

describe('the session the wire is on', () => {
  it('is fingerprinted by SAP_SESSIONID, and by nothing else', () => {
    const transport = new HttpTransport();

    transport.ingest(
      setCookie('SAP_SESSIONID_E19_100=ABC', 'sap-usercontext=sap-client=100'),
    );

    expect([...transport.sessionFingerprint()]).toEqual([
      ['SAP_SESSIONID_E19_100', 'ABC'],
    ]);
  });

  it('is empty until the server issues one', () => {
    const transport = new HttpTransport();

    transport.ingest(setCookie('sap-usercontext=sap-client=100'));

    expect(transport.sessionFingerprint().size).toBe(0);
  });

  it('shows the new value when the server replaces the session', () => {
    const transport = new HttpTransport();
    transport.ingest(setCookie('SAP_SESSIONID_E19_100=FIRST'));

    transport.ingest(setCookie('SAP_SESSIONID_E19_100=SECOND'));

    expect(transport.sessionFingerprint().get('SAP_SESSIONID_E19_100')).toBe(
      'SECOND',
    );
  });
});

describe('staying on the server the session lives on', () => {
  it('asks the server to name itself', () => {
    expect(new HttpTransport().affinityHeaders()).toEqual({
      'sap-adt-saplb': 'fetch',
    });
  });

  it('sends the name back once the server has given one', () => {
    const transport = new HttpTransport();

    transport.ingest({ 'sap-adt-saplb': 'epbyminsd0654_E19_00' });

    expect(transport.affinityHeaders()).toEqual({
      'sap-adt-saplb': 'fetch',
      saplb: 'epbyminsd0654_E19_00',
      'saplb-options': 'REDISPATCH_ON_SHUTDOWN',
    });
  });
});

describe('what the wire puts on its own requests', () => {
  /** Replaces axios, so the outgoing headers can be read. */
  function outgoing(transport: HttpTransport) {
    const seen: Array<Record<string, string>> = [];
    (transport as unknown as { client: unknown }).client =
      () => async (cfg: { headers?: Record<string, string> }) => {
        seen.push(cfg.headers ?? {});
        return { status: 200, statusText: 'OK', headers: {}, data: '' };
      };
    return seen;
  }

  it('sends the cookies it holds', async () => {
    const transport = new HttpTransport();
    const seen = outgoing(transport);
    transport.ingest(setCookie('SAP_SESSIONID_E19_100=ABC'));

    await transport.send({ method: 'GET', url: '/x' });

    expect(seen[0].Cookie).toContain('SAP_SESSIONID_E19_100=ABC');
  });

  it('merges with a Cookie the caller set, rather than replacing it', async () => {
    // A SAML session IS the credential's cookie. Replacing it would send the
    // request out unauthenticated while looking like it carried a session.
    const transport = new HttpTransport();
    const seen = outgoing(transport);
    transport.ingest(setCookie('SAP_SESSIONID_E19_100=ABC'));

    await transport.send({
      method: 'GET',
      url: '/x',
      headers: { Cookie: 'MYSAPSSO2=ticket' },
    });

    expect(seen[0].Cookie).toContain('MYSAPSSO2=ticket');
    expect(seen[0].Cookie).toContain('SAP_SESSIONID_E19_100=ABC');
  });

  it('asks the server to name itself, and sends the name back', async () => {
    const transport = new HttpTransport();
    const seen = outgoing(transport);

    await transport.send({ method: 'GET', url: '/x' });
    transport.ingest({ 'sap-adt-saplb': 'epbyminsd0654_E19_00' });
    await transport.send({ method: 'GET', url: '/y' });

    expect(seen[0]['sap-adt-saplb']).toBe('fetch');
    expect(seen[1].saplb).toBe('epbyminsd0654_E19_00');
  });

  it('sends no Cookie header when it holds nothing', async () => {
    const transport = new HttpTransport();
    const seen = outgoing(transport);

    await transport.send({ method: 'GET', url: '/x' });

    expect(seen[0].Cookie).toBeUndefined();
  });
});

describe('giving the wire state back', () => {
  it('forgets the cookies, the fingerprint and the server', () => {
    const transport = new HttpTransport();
    transport.ingest({
      ...setCookie('SAP_SESSIONID_E19_100=ABC'),
      'sap-adt-saplb': 'epbyminsd0654_E19_00',
    });

    transport.forgetSession();

    expect(transport.cookies()).toBeNull();
    expect(transport.sessionFingerprint().size).toBe(0);
    expect(transport.affinityHeaders()).toEqual({ 'sap-adt-saplb': 'fetch' });
  });
});
