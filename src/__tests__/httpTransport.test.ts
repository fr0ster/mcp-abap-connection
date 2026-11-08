/**
 * HTTP as a thing rather than as an `if`.
 *
 * The axis had one real value: RFC was an object, HTTP was a branch inside
 * `getAxiosInstance()`. That asymmetry is what stopped the axis being named in
 * a type — a default type parameter has nothing to point at when one of the two
 * values is a code path.
 *
 * The TLS material is the one place the two axes touch: the CREDENTIAL offers
 * it at logon (`ILogonTarget.tlsMaterial`) and the TRANSPORT builds its client
 * from it. The constructor's `agentOptions` thunk carries only what is not the
 * credential (`ca`, `rejectUnauthorized`), and is read when the client is
 * first built.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CloudHttpTransport } from '../connection/CloudHttpTransport.js';
import { HttpTransport } from '../connection/HttpTransport.js';
import type { IAdtTransport } from '../connection/IAdtTransport.js';
import { OnPremHttpTransport } from '../connection/OnPremHttpTransport.js';
import { assertMatchObject } from './helpers/assertions.js';
import { type SapStub, startSapStub } from './helpers/sapStub.js';

/** A bare HTTP wire, addressed at a server no test here reaches. */
const http = () => new HttpTransport(undefined, null, { baseUrl: 'https://h' });

describe('HttpTransport', () => {
  it('names itself http', () => {
    const transport: IAdtTransport = http();

    assert.strictEqual(transport.kind, 'http');
  });

  it('offers its logon on open and has nothing to give back', async () => {
    const transport: IAdtTransport = http();
    const context = {
      authorize: async () => {},
      logon: async () => {},
      observe: () => {},
    };

    // The members exist — they are the contract, so the connection calls them
    // rather than asking whether they are there. A bare HTTP wire offers the
    // credential its logon on open and nothing else: a request opens its own
    // socket, and there is no session resource to give back.
    assert.strictEqual(await transport.open(context), undefined);
    assert.strictEqual(await transport.close(context), undefined);
  });

  it('reads its agentOptions when it builds the client, not before', () => {
    let asked = 0;
    const transport = new HttpTransport(
      () => {
        asked++;
        return { ca: 'PEM' };
      },
      null,
      { baseUrl: 'https://h' },
    );

    assert.strictEqual(asked, 0);

    // Building the client is what asks. Asking in the constructor would read
    // options the caller may not have loaded yet; the credential's material
    // is not among them — the provider offers it at logon.
    (transport as any).client();
    assert.strictEqual(asked, 1);
  });

  it('builds the client once and keeps it', () => {
    const transport = http();

    const first = (transport as any).client();
    const second = (transport as any).client();

    assert.strictEqual(second, first);
  });

  it('carries the request through to the client', async () => {
    const transport = http();
    const seen: Array<Record<string, unknown>> = [];
    (transport as any).instance = async (config: Record<string, unknown>) => {
      seen.push(config);
      return { status: 200, statusText: 'OK', headers: {}, data: 'ok' };
    };

    const response = await transport.send({
      method: 'GET',
      url: 'https://h/sap/bc/adt/discovery',
      headers: { Accept: 'application/xml' },
      params: { q: '1' },
      timeout: 1234,
    });

    assertMatchObject(seen[0], {
      method: 'GET',
      // The params serialised into the URL, once, by axios — what the client
      // guard checks is what goes out.
      url: 'https://h/sap/bc/adt/discovery?q=1',
      // The caller's headers, plus what the wire adds of its own accord —
      // today the affinity ask, and the cookies once it holds any.
      headers: {
        Accept: 'application/xml',
        'sap-adt-saplb': 'fetch',
      },
      timeout: 1234,
    });
    assert.ok(!('params' in seen[0]));
    assertMatchObject(response, { status: 200, data: 'ok' });
  });
});

describe('the requests the HTTP wire originates go to its own base URL', () => {
  // The wire was handed a base URL at construction; the connection hands it
  // a session context and no address. A request the wire makes on its own —
  // the CSRF fetch, the cloud preflight, the logoff — goes there.
  let own: SapStub;
  before(async () => {
    own = await startSapStub();
  });
  after(async () => {
    await own.close();
  });

  const context = () => ({
    authorize: async () => {},
    logon: async () => {},
    observe: () => {},
  });

  it('the CSRF fetch', async () => {
    own.requests.length = 0;
    const transport = new HttpTransport(undefined, null, {
      baseUrl: own.baseUrl,
    });

    await transport.establish(context());

    assert.deepStrictEqual(
      own.requests.map((request) => request.path),
      ['/sap/bc/adt/core/discovery'],
    );
  });

  it('the cloud preflight', async () => {
    own.requests.length = 0;
    const transport = new CloudHttpTransport(undefined, null, {
      baseUrl: own.baseUrl,
    });

    await transport.open(context());

    assert.deepStrictEqual(
      own.requests.map((request) => request.path),
      ['/sap/bc/adt/core/http/sessions'],
    );
  });

  it('the logoff', async () => {
    own.requests.length = 0;
    const transport = new OnPremHttpTransport(undefined, null, {
      baseUrl: own.baseUrl,
    });
    transport.ingest({ 'set-cookie': ['SAP_SESSIONID_STUB_100=S1; Path=/'] });

    await transport.close(context());

    assert.deepStrictEqual(
      own.requests.map((request) => request.path),
      ['/sap/public/bc/icf/logoff'],
    );
  });
});
