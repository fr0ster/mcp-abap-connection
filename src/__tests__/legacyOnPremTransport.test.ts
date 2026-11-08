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
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LegacyOnPremHttpTransport } from '../connection/LegacyOnPremHttpTransport.js';
import { OnPremHttpTransport } from '../connection/OnPremHttpTransport.js';
import { httpClientStub } from './helpers/httpClientStub.js';

/** A legacy wire over a client that answers 200 and records the headers sent. */
function wire() {
  const client = httpClientStub(async () => ({
    status: 200,
    statusText: 'OK',
    headers: {},
    data: '',
  }));
  const transport = new LegacyOnPremHttpTransport(() => ({}), null, {
    baseUrl: 'https://h',
    httpClient: client,
  });
  return {
    transport,
    get seen() {
      return client.sent.map((request) => request.headers);
    },
  };
}

describe('the legacy on-prem wire', () => {
  it('never sends the session-type header, whatever was asked for', async () => {
    const wired = wire();
    const { transport } = wired;

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
    const [sent] = wired.seen;
    assert.ok(sent);
    assert.strictEqual(sent.Accept, 'application/xml');
    assert.ok(
      !Object.keys(sent)
        .map((k) => k.toLowerCase())
        .includes('x-sap-adt-sessiontype'),
    );
  });

  it('holds a session, because this system names none and that is not a failure', () => {
    const transport = new LegacyOnPremHttpTransport(() => ({}), null, {
      baseUrl: 'https://h',
    });

    // The ordinary on-prem wire says no until the server names one; this one
    // says yes, because there is nothing to be named. Answering "no session"
    // would refuse a system that works.
    assert.strictEqual(transport.sessionEstablished(), true);
    assert.strictEqual(
      new OnPremHttpTransport(() => ({}), null, {
        baseUrl: 'https://h',
      }).sessionEstablished(),
      false,
    );
  });

  it('is still an on-prem wire, so it fits where one fits', () => {
    const transport = new LegacyOnPremHttpTransport(() => ({}), null, {
      baseUrl: 'https://h',
    });

    assert.strictEqual(transport.system, 'onprem');
    assert.strictEqual(transport.kind, 'onprem-http-legacy');
  });

  it('keeps the platform logoff it inherits', async () => {
    const wired = wire();
    const { transport } = wired;
    transport.ingest({ 'set-cookie': ['SAP_SESSIONID_X_100=abc; path=/'] });

    await transport.close({
      authorize: async () => {},
      logon: async () => {},
      observe: () => {},
    });

    // Inherited rather than reimplemented: what differs on 7.40 is the header
    // and the session naming, not how a session is given back.
    const seen = wired.seen;
    assert.strictEqual(seen.length, 1);
    assert.ok(seen[0]?.Cookie?.includes('SAP_SESSIONID_X_100'));
  });
});
