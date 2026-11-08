/**
 * Establishing the wire: what each transport has to do before it can carry a
 * mutation.
 *
 * Over HTTP that is the CSRF exchange — a GET that asks for a token and comes
 * back with one, and with the cookies that name the session. Over RFC there is
 * nothing to do: the conversation was opened before this, it IS the session,
 * and `SADT_REST_RFC_ENDPOINT` returns neither a token nor a cookie however it
 * is asked. Measured on E19.
 *
 * That difference is why this belongs to the transport. Asked of the
 * connection, it was one implementation for both wires, and the RFC one could
 * not succeed: four attempts, four ABAP dumps, and a `connect()` that refused.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { WireLogonError } from '../connection/authErrors.js';
import { HttpTransport } from '../connection/HttpTransport.js';
import type {
  IAdtTransportRequest,
  IAdtTransportResponse,
} from '../connection/IAdtTransport.js';
import { OnPremHttpTransport } from '../connection/OnPremHttpTransport.js';
import {
  type IRfcConversation,
  RfcTransport,
} from '../connection/RfcTransport.js';
import { assertMatchObject, instanceOf } from './helpers/assertions.js';
import { type SapStub, startSapStub } from './helpers/sapStub.js';

/** The server every HTTP wire here is built for. */
const BASE = 'https://sap.example.com';

/** A bare HTTP wire, addressed at `BASE`. */
const http = () => new HttpTransport(undefined, null, { baseUrl: BASE });

const context = (over: Partial<Record<string, unknown>> = {}) => ({
  authorize: async (headers: Record<string, string>) => {
    headers.Authorization = 'Basic dTpw';
  },
  logon: async () => {},
  observe: () => {},
  ...over,
});

/** Replaces the wire, so what `establish()` sends can be read. */
function intercept(
  transport: HttpTransport,
  answer: (request: IAdtTransportRequest) => Promise<IAdtTransportResponse>,
) {
  const sent: IAdtTransportRequest[] = [];
  transport.send = async (request) => {
    sent.push(request);
    return answer(request);
  };
  return sent;
}

/** The URI an RFC call's request line carries, or `undefined`. */
function requestUri(params: Record<string, unknown>): unknown {
  const request = params.REQUEST;
  if (typeof request !== 'object' || request === null) return undefined;
  if (!('REQUEST_LINE' in request)) return undefined;
  const line = request.REQUEST_LINE;
  if (typeof line !== 'object' || line === null || !('URI' in line))
    return undefined;
  return line.URI;
}

const withToken = async () => ({
  status: 200,
  headers: { 'x-csrf-token': 'TOKEN', 'set-cookie': ['SAP_SESSIONID_X=1'] },
  data: '',
});

describe('establishing over HTTP', () => {
  it('asks the discovery endpoint for a token', async () => {
    const transport = http();
    const sent = intercept(transport, withToken);

    await transport.establish(context());

    assert.strictEqual(
      sent[0].url,
      'https://sap.example.com/sap/bc/adt/core/discovery',
    );
    assert.strictEqual(sent[0].headers?.['x-csrf-token'], 'fetch');
  });

  it('addresses the endpoint with the base url the wire was built with', async () => {
    // Over RFC the same string went into `REQUEST_LINE-URI`, where an absolute
    // URL dumped the FM with STRING_OFFSET_TOO_LARGE. Building it is the HTTP
    // wire's business precisely because only HTTP can address one — so the
    // HTTP wire holds its base URL, and the connection hands it none.
    const transport = new HttpTransport(undefined, null, {
      baseUrl: 'https://other.example.com',
    });
    const sent = intercept(transport, withToken);

    await transport.establish(context());

    assert.strictEqual(
      sent[0].url.startsWith('https://other.example.com/'),
      true,
    );
  });

  it('carries the credential the caller handed it', async () => {
    const transport = http();
    const sent = intercept(transport, withToken);

    await transport.establish(context());

    assert.strictEqual(sent[0].headers?.Authorization, 'Basic dTpw');
  });

  it('keeps the token, so a mutation can present it', async () => {
    const transport = http();
    intercept(transport, withToken);

    await transport.establish(context());

    assert.strictEqual(transport.csrfToken(), 'TOKEN');
  });

  it('keeps the cookies that came with it', async () => {
    const transport = http();
    intercept(transport, withToken);

    await transport.establish(context());

    assert.strictEqual(
      transport.sessionFingerprint().get('SAP_SESSIONID_X'),
      '1',
    );
  });

  it('hands the answer up, so the connection can fence and classify it', async () => {
    // The wire folds the response into its own state; whether a new session id
    // is an establishment or a replacement is not its question.
    const seen: unknown[] = [];
    const transport = http();
    intercept(transport, withToken);

    await transport.establish(
      context({ observe: (h: unknown) => seen.push(h) }),
    );

    assert.strictEqual(seen.length, 1);
  });

  it('falls back to the legacy endpoint when the first has none', async () => {
    // BASIS < 7.52 has no /sap/bc/adt/core/discovery.
    const transport = http();
    const sent = intercept(transport, async (request) => {
      if (request.url.includes('/core/discovery')) {
        // What a system without the endpoint answers. A refused connection is
        // NOT this, and asking the same dead host for another path only
        // doubles the wait.
        throw Object.assign(new Error('not found'), {
          response: { status: 404, headers: {} },
        });
      }
      return withToken();
    });

    await transport.establish(context());

    assert.strictEqual(
      sent.at(-1)?.url,
      'https://sap.example.com/sap/bc/adt/discovery',
    );
    assert.strictEqual(transport.csrfToken(), 'TOKEN');
  });

  it('does not ask a second path of a host that is not answering', async () => {
    const transport = http();
    const sent = intercept(transport, async () => {
      throw new Error('connect ECONNREFUSED');
    });

    await assert.rejects(transport.establish(context({ retries: 0 })));
    assert.strictEqual(sent.length, 1);
  });

  it('refuses when the server answers without a token', async () => {
    const transport = http();
    intercept(transport, async () => ({ status: 200, headers: {}, data: '' }));

    await assert.rejects(transport.establish(context({ retries: 0 })));
  });

  it('is a no-op once the wire already holds a token', async () => {
    // Asked again before a mutation, this must not spend a round trip — and
    // must not re-open the session the token is bound to.
    const transport = http();
    const sent = intercept(transport, withToken);
    await transport.establish(context());

    await transport.establish(context());

    assert.strictEqual(sent.length, 1);
  });

  it('forgets the token when the session it was bound to is gone', async () => {
    const transport = http();
    intercept(transport, withToken);
    await transport.establish(context());

    transport.forgetSession();

    assert.strictEqual(transport.csrfToken(), null);
  });
});

describe('addressing the wire', () => {
  it('resolves a path against the server the HTTP wire was given', async () => {
    // The connection hands over a PATH. Turning it into an address is the
    // wire's job: HTTP puts a server in front of it, RFC writes it into
    // `REQUEST_LINE-URI` as it stands — and handed an absolute URL there,
    // SADT_REST_RFC_ENDPOINT dumps with STRING_OFFSET_TOO_LARGE.
    const server = await startSapStub();
    try {
      const transport = new HttpTransport(undefined, null, {
        baseUrl: server.baseUrl,
      });

      await transport.send({ method: 'GET', url: '/sap/bc/adt/discovery' });

      assert.deepStrictEqual(
        server.requests.map((request) => request.path),
        ['/sap/bc/adt/discovery'],
      );
    } finally {
      await server.close();
    }
  });

  it('leaves an address that is already absolute alone', async () => {
    const own = await startSapStub();
    const other = await startSapStub();
    try {
      const transport = new HttpTransport(undefined, null, {
        baseUrl: own.baseUrl,
      });

      await transport.send({
        method: 'GET',
        url: `${other.baseUrl}/sap/bc/adt/discovery`,
      });

      assert.deepStrictEqual(own.requests, []);
      assert.deepStrictEqual(
        other.requests.map((request) => request.path),
        ['/sap/bc/adt/discovery'],
      );
    } finally {
      await own.close();
      await other.close();
    }
  });

  it('writes the path into the RFC request line as it stands', async () => {
    let uri = '';
    const transport = new RfcTransport(
      (): IRfcConversation => ({
        alive: true,
        open: async () => {},
        close: async () => {},
        call: async (_fm: string, params: Record<string, unknown>) => {
          uri = String(requestUri(params));
          return {
            RESPONSE: {
              STATUS_LINE: { STATUS_CODE: 200, REASON_PHRASE: 'OK' },
              HEADER_FIELDS: [],
              MESSAGE_BODY: Buffer.alloc(0),
            },
          };
        },
      }),
    );
    await transport.open();

    await transport.send({ method: 'GET', url: '/sap/bc/adt/discovery' });

    assert.strictEqual(uri, '/sap/bc/adt/discovery');
  });
});

describe('establishing over RFC', () => {
  it('sends nothing, because the conversation is already the session', async () => {
    const calls: string[] = [];
    const transport = new RfcTransport(
      (): IRfcConversation => ({
        alive: true,
        open: async () => {},
        close: async () => {},
        call: async (fm: string) => {
          calls.push(fm);
          return {};
        },
      }),
    );
    await transport.open();

    await transport.establish(context());

    assert.deepStrictEqual(calls, []);
  });

  it('holds no token, because the wire never returns one', async () => {
    const transport = new RfcTransport(
      (): IRfcConversation => ({
        alive: true,
        open: async () => {},
        close: async () => {},
        call: async () => ({}),
      }),
    );
    await transport.open();

    await transport.establish(context());

    assert.strictEqual(transport.csrfToken(), null);
  });
});

/**
 * A refused logon, named by the wire that saw it.
 *
 * A 401 from the establishing request is the credential refused at logon, and
 * the wire says so with `WireLogonError`; what to do about it is not the
 * wire's to decide. Anything else that fails the exchange is retried as before.
 */
describe('a refused logon over HTTP', () => {
  let stub: SapStub;

  beforeEach(async () => {
    stub = await startSapStub();
  });

  afterEach(async () => {
    await stub.close();
  });

  const wire = () =>
    new OnPremHttpTransport(() => ({}), null, {
      client: '100',
      baseUrl: stub.baseUrl,
    });

  it('surfaces a 401 as WireLogonError, after folding in its cookies', async () => {
    stub.discovery.push({
      status: 401,
      headers: { 'set-cookie': ['sap-login-XSRF_STUB=L1; Path=/'] },
    });
    const transport = wire();
    const observed: unknown[] = [];

    const error = await transport
      .establish({
        authorize: async () => {},
        logon: async () => {},
        observe: (headers) => observed.push(headers),
        retries: 3,
        retryDelayMs: 0,
      })
      .catch((e: unknown) => e);

    assert.ok(error instanceof WireLogonError);
    assert.strictEqual(instanceOf(error, WireLogonError).status, 401);
    assertMatchObject(instanceOf(error, WireLogonError).cause, {
      response: { status: 401 },
    });
    assert.ok(transport.cookies()?.includes('sap-login-XSRF_STUB=L1'));
    assert.strictEqual(observed.length, 1);
    // Not retried: asking again with the credential just refused tells the
    // system nothing new.
    assert.strictEqual(stub.sentTo('/sap/bc/adt/core/discovery').length, 1);
  });

  it('still retries a 500', async () => {
    stub.discovery.push(500);
    const transport = wire();

    await transport.establish({
      authorize: async () => {},
      logon: async () => {},
      observe: () => {},
      retries: 3,
      retryDelayMs: 0,
    });

    assert.strictEqual(transport.csrfToken(), 'TOKEN-1');
    assert.strictEqual(stub.sentTo('/sap/bc/adt/core/discovery').length, 2);
  });
});
