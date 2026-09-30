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
import { WireLogonError } from '../connection/authErrors.js';
import { HttpTransport } from '../connection/HttpTransport.js';
import { OnPremHttpTransport } from '../connection/OnPremHttpTransport.js';
import { RfcTransport } from '../connection/RfcTransport.js';
import { type SapStub, startSapStub } from './helpers/sapStub.js';

const context = (over: Partial<Record<string, unknown>> = {}) => ({
  baseUrl: 'https://sap.example.com',
  authHeaders: async () => ({ Authorization: 'Basic dTpw' }),
  observe: () => {},
  ...over,
});

/** Replaces the wire, so what `establish()` sends can be read. */
function intercept(
  transport: HttpTransport,
  answer: (request: {
    url: string;
    headers?: Record<string, string>;
  }) => Promise<unknown>,
) {
  const sent: Array<{ url: string; headers?: Record<string, string> }> = [];
  (transport as unknown as { send: unknown }).send = async (request: {
    url: string;
    headers?: Record<string, string>;
  }) => {
    sent.push(request);
    return answer(request);
  };
  return sent;
}

const withToken = async () => ({
  status: 200,
  headers: { 'x-csrf-token': 'TOKEN', 'set-cookie': ['SAP_SESSIONID_X=1'] },
  data: '',
});

describe('establishing over HTTP', () => {
  it('asks the discovery endpoint for a token', async () => {
    const transport = new HttpTransport();
    const sent = intercept(transport, withToken);

    await transport.establish(context());

    expect(sent[0].url).toBe(
      'https://sap.example.com/sap/bc/adt/core/discovery',
    );
    expect(sent[0].headers?.['x-csrf-token']).toBe('fetch');
  });

  it('addresses the endpoint with the base url the caller named', async () => {
    // Over RFC the same string went into `REQUEST_LINE-URI`, where an absolute
    // URL dumped the FM with STRING_OFFSET_TOO_LARGE. Building it is the HTTP
    // wire's business precisely because only HTTP can address one.
    const transport = new HttpTransport();
    const sent = intercept(transport, withToken);

    await transport.establish(
      context({ baseUrl: 'https://other.example.com' }),
    );

    expect(sent[0].url.startsWith('https://other.example.com/')).toBe(true);
  });

  it('carries the credential the caller handed it', async () => {
    const transport = new HttpTransport();
    const sent = intercept(transport, withToken);

    await transport.establish(context());

    expect(sent[0].headers?.Authorization).toBe('Basic dTpw');
  });

  it('keeps the token, so a mutation can present it', async () => {
    const transport = new HttpTransport();
    intercept(transport, withToken);

    await transport.establish(context());

    expect(transport.csrfToken()).toBe('TOKEN');
  });

  it('keeps the cookies that came with it', async () => {
    const transport = new HttpTransport();
    intercept(transport, withToken);

    await transport.establish(context());

    expect(transport.sessionFingerprint().get('SAP_SESSIONID_X')).toBe('1');
  });

  it('hands the answer up, so the connection can fence and classify it', async () => {
    // The wire folds the response into its own state; whether a new session id
    // is an establishment or a replacement is not its question.
    const seen: unknown[] = [];
    const transport = new HttpTransport();
    intercept(transport, withToken);

    await transport.establish(
      context({ observe: (h: unknown) => seen.push(h) }),
    );

    expect(seen).toHaveLength(1);
  });

  it('falls back to the legacy endpoint when the first has none', async () => {
    // BASIS < 7.52 has no /sap/bc/adt/core/discovery.
    const transport = new HttpTransport();
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

    expect(sent.at(-1)?.url).toBe(
      'https://sap.example.com/sap/bc/adt/discovery',
    );
    expect(transport.csrfToken()).toBe('TOKEN');
  });

  it('does not ask a second path of a host that is not answering', async () => {
    const transport = new HttpTransport();
    const sent = intercept(transport, async () => {
      throw new Error('connect ECONNREFUSED');
    });

    await expect(
      transport.establish(context({ retries: 0 })),
    ).rejects.toThrow();
    expect(sent).toHaveLength(1);
  });

  it('refuses when the server answers without a token', async () => {
    const transport = new HttpTransport();
    intercept(transport, async () => ({ status: 200, headers: {}, data: '' }));

    await expect(
      transport.establish(context({ retries: 0 })),
    ).rejects.toThrow();
  });

  it('is a no-op once the wire already holds a token', async () => {
    // Asked again before a mutation, this must not spend a round trip — and
    // must not re-open the session the token is bound to.
    const transport = new HttpTransport();
    const sent = intercept(transport, withToken);
    await transport.establish(context());

    await transport.establish(context());

    expect(sent).toHaveLength(1);
  });

  it('forgets the token when the session it was bound to is gone', async () => {
    const transport = new HttpTransport();
    intercept(transport, withToken);
    await transport.establish(context());

    transport.forgetSession();

    expect(transport.csrfToken()).toBeNull();
  });
});

describe('addressing the wire', () => {
  it('resolves a path against the server the HTTP wire was given', async () => {
    // The connection hands over a PATH. Turning it into an address is the
    // wire's job: HTTP puts a server in front of it, RFC writes it into
    // `REQUEST_LINE-URI` as it stands — and handed an absolute URL there,
    // SADT_REST_RFC_ENDPOINT dumps with STRING_OFFSET_TOO_LARGE.
    const transport = new HttpTransport(undefined, null, {
      baseUrl: 'https://sap.example.com',
    });
    const seen: string[] = [];
    (transport as unknown as { client: unknown }).client =
      () => async (cfg: { url: string }) => {
        seen.push(cfg.url);
        return { status: 200, statusText: 'OK', headers: {}, data: '' };
      };

    await transport.send({ method: 'GET', url: '/sap/bc/adt/discovery' });

    expect(seen[0]).toBe('https://sap.example.com/sap/bc/adt/discovery');
  });

  it('leaves an address that is already absolute alone', async () => {
    const transport = new HttpTransport(undefined, null, {
      baseUrl: 'https://sap.example.com',
    });
    const seen: string[] = [];
    (transport as unknown as { client: unknown }).client =
      () => async (cfg: { url: string }) => {
        seen.push(cfg.url);
        return { status: 200, statusText: 'OK', headers: {}, data: '' };
      };

    await transport.send({
      method: 'GET',
      url: 'https://other.example.com/sap/bc/adt/discovery',
    });

    expect(seen[0]).toBe('https://other.example.com/sap/bc/adt/discovery');
  });

  it('writes the path into the RFC request line as it stands', async () => {
    let uri = '';
    const transport = new RfcTransport(
      () =>
        ({
          alive: true,
          open: async () => {},
          close: async () => {},
          call: async (_fm: string, params: any) => {
            uri = params.REQUEST.REQUEST_LINE.URI;
            return {
              RESPONSE: {
                STATUS_LINE: { STATUS_CODE: 200, REASON_PHRASE: 'OK' },
                HEADER_FIELDS: [],
                MESSAGE_BODY: Buffer.alloc(0),
              },
            };
          },
        }) as never,
    );
    await transport.open();

    await transport.send({ method: 'GET', url: '/sap/bc/adt/discovery' });

    expect(uri).toBe('/sap/bc/adt/discovery');
  });
});

describe('establishing over RFC', () => {
  it('sends nothing, because the conversation is already the session', async () => {
    const calls: string[] = [];
    const transport = new RfcTransport(
      () =>
        ({
          alive: true,
          open: async () => {},
          close: async () => {},
          call: async (fm: string) => {
            calls.push(fm);
            return {};
          },
        }) as never,
    );
    await transport.open();

    await transport.establish(context());

    expect(calls).toEqual([]);
  });

  it('holds no token, because the wire never returns one', async () => {
    const transport = new RfcTransport(
      () =>
        ({
          alive: true,
          open: async () => {},
          close: async () => {},
          call: async () => ({}),
        }) as never,
    );
    await transport.open();

    await transport.establish(context());

    expect(transport.csrfToken()).toBeNull();
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
        baseUrl: stub.baseUrl,
        authHeaders: async () => ({}),
        observe: (headers) => observed.push(headers),
        retries: 3,
        retryDelayMs: 0,
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WireLogonError);
    expect((error as WireLogonError).status).toBe(401);
    expect(
      ((error as WireLogonError).cause as { response?: { status?: number } })
        .response?.status,
    ).toBe(401);
    expect(transport.cookies()).toContain('sap-login-XSRF_STUB=L1');
    expect(observed).toHaveLength(1);
    // Not retried: asking again with the credential just refused tells the
    // system nothing new.
    expect(stub.sentTo('/sap/bc/adt/core/discovery')).toHaveLength(1);
  });

  it('still retries a 500', async () => {
    stub.discovery.push(500);
    const transport = wire();

    await transport.establish({
      baseUrl: stub.baseUrl,
      authHeaders: async () => ({}),
      observe: () => {},
      retries: 3,
      retryDelayMs: 0,
    });

    expect(transport.csrfToken()).toBe('TOKEN-1');
    expect(stub.sentTo('/sap/bc/adt/core/discovery')).toHaveLength(2);
  });
});
