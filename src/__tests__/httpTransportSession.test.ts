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
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpTransport } from '../connection/HttpTransport.js';

const setCookie = (...entries: string[]) => ({ 'set-cookie': entries });

describe('the cookies the wire holds', () => {
  it('keeps what a response set', () => {
    const transport = new HttpTransport();

    transport.ingest(setCookie('SAP_SESSIONID_E19_100=ABC; path=/'));

    assert.ok(transport.cookies()?.includes('SAP_SESSIONID_E19_100=ABC'));
  });

  it('keeps earlier cookies a later response did not mention', () => {
    const transport = new HttpTransport();

    transport.ingest(setCookie('SAP_SESSIONID_E19_100=ABC'));
    transport.ingest(setCookie('MYSAPSSO2=TICKET'));

    assert.ok(transport.cookies()?.includes('SAP_SESSIONID_E19_100=ABC'));
    assert.ok(transport.cookies()?.includes('MYSAPSSO2=TICKET'));
  });

  it('holds nothing before a response has set anything', () => {
    assert.strictEqual(new HttpTransport().cookies(), null);
  });

  it('holds nothing when a response set no cookie', () => {
    // The client assertion applies TO the cookies a response brought; on its
    // own it would hand a wire that was issued nothing a Cookie header to send.
    const transport = new HttpTransport(undefined, null, { client: '100' });

    transport.ingest({ 'content-type': 'application/xml' });

    assert.strictEqual(transport.cookies(), null);
  });

  it('insists on the client it was configured with', () => {
    // SAP answers `sap-usercontext` with the system default, which routes later
    // requests to a client the caller never asked for — a read-only one turns
    // every write into a 403.
    const transport = new HttpTransport(undefined, null, { client: '100' });

    transport.ingest(setCookie('sap-usercontext=sap-client=000'));

    assert.ok(transport.cookies()?.includes('sap-usercontext=sap-client=100'));
  });
});

describe('the session the wire is on', () => {
  it('is fingerprinted by SAP_SESSIONID, and by nothing else', () => {
    const transport = new HttpTransport();

    transport.ingest(
      setCookie('SAP_SESSIONID_E19_100=ABC', 'sap-usercontext=sap-client=100'),
    );

    assert.deepStrictEqual(
      [...transport.sessionFingerprint()],
      [['SAP_SESSIONID_E19_100', 'ABC']],
    );
  });

  it('is empty until the server issues one', () => {
    const transport = new HttpTransport();

    transport.ingest(setCookie('sap-usercontext=sap-client=100'));

    assert.strictEqual(transport.sessionFingerprint().size, 0);
  });

  it('shows the new value when the server replaces the session', () => {
    const transport = new HttpTransport();
    transport.ingest(setCookie('SAP_SESSIONID_E19_100=FIRST'));

    transport.ingest(setCookie('SAP_SESSIONID_E19_100=SECOND'));

    assert.strictEqual(
      transport.sessionFingerprint().get('SAP_SESSIONID_E19_100'),
      'SECOND',
    );
  });
});

describe('staying on the server the session lives on', () => {
  it('asks the server to name itself', () => {
    assert.deepStrictEqual(new HttpTransport().affinityHeaders(), {
      'sap-adt-saplb': 'fetch',
    });
  });

  it('sends the name back once the server has given one', () => {
    const transport = new HttpTransport();

    transport.ingest({ 'sap-adt-saplb': 'epbyminsd0654_E19_00' });

    assert.deepStrictEqual(transport.affinityHeaders(), {
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

    assert.ok(seen[0].Cookie.includes('SAP_SESSIONID_E19_100=ABC'));
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

    assert.ok(seen[0].Cookie.includes('MYSAPSSO2=ticket'));
    assert.ok(seen[0].Cookie.includes('SAP_SESSIONID_E19_100=ABC'));
  });

  it('asks the server to name itself, and sends the name back', async () => {
    const transport = new HttpTransport();
    const seen = outgoing(transport);

    await transport.send({ method: 'GET', url: '/x' });
    transport.ingest({ 'sap-adt-saplb': 'epbyminsd0654_E19_00' });
    await transport.send({ method: 'GET', url: '/y' });

    assert.strictEqual(seen[0]['sap-adt-saplb'], 'fetch');
    assert.strictEqual(seen[1].saplb, 'epbyminsd0654_E19_00');
  });

  it('sends no Cookie header when it holds nothing', async () => {
    const transport = new HttpTransport();
    const seen = outgoing(transport);

    await transport.send({ method: 'GET', url: '/x' });

    assert.strictEqual(seen[0].Cookie, undefined);
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

    assert.strictEqual(transport.cookies(), null);
    assert.strictEqual(transport.sessionFingerprint().size, 0);
    assert.deepStrictEqual(transport.affinityHeaders(), {
      'sap-adt-saplb': 'fetch',
    });
  });
});
