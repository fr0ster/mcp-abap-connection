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
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { after, before, describe, it } from 'node:test';
import axios from 'axios';
import { CloudHttpTransport } from '../connection/CloudHttpTransport.js';
import {
  type HttpClientAgents,
  type HttpClientFactory,
  HttpTransport,
  nodeHttpClient,
} from '../connection/HttpTransport.js';
import type { IAdtTransport } from '../connection/IAdtTransport.js';
import { OnPremHttpTransport } from '../connection/OnPremHttpTransport.js';
import { assertMatchObject } from './helpers/assertions.js';
import { httpClientStub } from './helpers/httpClientStub.js';
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

  it('reads its agentOptions when it builds the client, not before', async () => {
    let asked = 0;
    const client = httpClientStub();
    const transport = new HttpTransport(
      () => {
        asked++;
        return { ca: 'PEM' };
      },
      null,
      { baseUrl: 'https://h', httpClient: client },
    );

    assert.strictEqual(asked, 0);

    // Building the client is what asks — at the first request. Asking in the
    // constructor would read options the caller may not have loaded yet; the
    // credential's material is not among them — the provider offers it at
    // logon.
    await transport.send({ method: 'GET', url: '/x' });
    assert.strictEqual(asked, 1);
    assert.strictEqual(client.built[0]?.httpsAgent.options.ca, 'PEM');
  });

  it('builds the client once and keeps it', async () => {
    const client = httpClientStub();
    const transport = new HttpTransport(undefined, null, {
      baseUrl: 'https://h',
      httpClient: client,
    });

    await transport.send({ method: 'GET', url: '/x' });
    await transport.send({ method: 'GET', url: '/y' });

    assert.strictEqual(client.built.length, 1);
    assert.strictEqual(client.sent.length, 2);
  });

  it('carries the request through to the client', async () => {
    const client = httpClientStub(async () => ({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: 'ok',
    }));
    const transport = new HttpTransport(undefined, null, {
      baseUrl: 'https://h',
      httpClient: client,
    });
    const seen = client.sent;

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

describe('the requests the HTTP wire originates go to the origin of its base URL', () => {
  // A configured URL may carry a path. The wire's own requests — the CSRF
  // fetch, the cloud preflight, the logoff — go to the system's origin, as
  // they always have; only a path a caller sends is put on the whole URL.
  let own: SapStub;
  before(async () => {
    own = await startSapStub();
  });
  after(async () => {
    await own.close();
  });

  const withPath = () => `${own.baseUrl}/some/path`;
  const context = () => ({
    authorize: async () => {},
    logon: async () => {},
    observe: () => {},
  });

  it('the CSRF fetch', async () => {
    own.requests.length = 0;
    const transport = new HttpTransport(undefined, null, {
      baseUrl: withPath(),
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
      baseUrl: withPath(),
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
      baseUrl: withPath(),
    });
    transport.ingest({ 'set-cookie': ['SAP_SESSIONID_STUB_100=S1; Path=/'] });

    await transport.close(context());

    assert.deepStrictEqual(
      own.requests.map((request) => request.path),
      ['/sap/public/bc/icf/logoff'],
    );
  });

  it('a path the caller sends is still put on the whole URL', async () => {
    own.requests.length = 0;
    const transport = new HttpTransport(undefined, null, {
      baseUrl: withPath(),
    });

    await transport.send({ method: 'GET', url: '/sap/bc/adt/x', headers: {} });

    assert.deepStrictEqual(
      own.requests.map((request) => request.path),
      ['/some/path/sap/bc/adt/x'],
    );
  });
});

describe('the HTTP client the wire is built with', () => {
  let stand: SapStub;
  before(async () => {
    stand = await startSapStub();
  });
  after(async () => {
    await stand.close();
  });

  it('is built by the injected factory, from the wire’s own agents', async () => {
    const built: HttpClientAgents[] = [];
    const seen: string[] = [];
    const httpClient: HttpClientFactory = {
      ...nodeHttpClient,
      create: (agents) => {
        built.push(agents);
        return axios.create({
          ...agents,
          adapter: async (config) => {
            seen.push(config.url ?? '');
            return {
              status: 200,
              statusText: 'OK',
              headers: {},
              data: 'ok',
              config,
            };
          },
        });
      },
    };
    const transport = new HttpTransport(undefined, null, {
      baseUrl: 'https://h',
      httpClient,
    });

    const response = await transport.send({ method: 'GET', url: '/x' });
    await transport.send({ method: 'GET', url: '/y' });

    assert.strictEqual(built.length, 1);
    assert.ok(built[0]?.httpsAgent instanceof HttpsAgent);
    assert.ok(built[0]?.httpAgent instanceof HttpAgent);
    assert.deepStrictEqual(seen, ['https://h/x', 'https://h/y']);
    assertMatchObject(response, { status: 200, data: 'ok' });
  });

  it('opens the logoff request through the injected factory', async () => {
    const opened: string[] = [];
    const httpClient: HttpClientFactory = {
      ...nodeHttpClient,
      logoffRequest: (options, onResponse) => {
        opened.push(String(options.path));
        return nodeHttpClient.logoffRequest(options, onResponse);
      },
    };
    const transport = new OnPremHttpTransport(undefined, null, {
      baseUrl: stand.baseUrl,
      httpClient,
    });
    transport.ingest({ 'set-cookie': ['SAP_SESSIONID_STUB_100=S1; Path=/'] });
    stand.requests.length = 0;

    let written = 0;
    await transport.close(
      {
        authorize: async () => {},
        logon: async () => {},
        observe: () => {},
      },
      () => {
        written += 1;
      },
    );

    assert.deepStrictEqual(opened, ['/sap/public/bc/icf/logoff']);
    assert.strictEqual(written, 1);
    assert.deepStrictEqual(
      stand.requests.map((request) => request.path),
      ['/sap/public/bc/icf/logoff'],
    );
  });

  it('is the shipped one when none is given: requests reach the network', async () => {
    stand.requests.length = 0;
    const transport = new HttpTransport(undefined, null, {
      baseUrl: stand.baseUrl,
    });

    await transport.send({ method: 'GET', url: '/sap/bc/adt/x' });

    assert.deepStrictEqual(
      stand.requests.map((request) => request.path),
      ['/sap/bc/adt/x'],
    );
  });
});
