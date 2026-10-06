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
import { HttpTransport } from '../connection/HttpTransport.js';
import type { IAdtTransport } from '../connection/IAdtTransport.js';

describe('HttpTransport', () => {
  it('names itself http', () => {
    const transport: IAdtTransport = new HttpTransport();

    expect(transport.kind).toBe('http');
  });

  it('offers its logon on open and has nothing to give back', async () => {
    const transport: IAdtTransport = new HttpTransport();
    const context = {
      baseUrl: 'https://h',
      authorize: async () => {},
      logon: async () => {},
      observe: () => {},
    };

    // The members exist — they are the contract, so the connection calls them
    // rather than asking whether they are there. A bare HTTP wire offers the
    // credential its logon on open and nothing else: a request opens its own
    // socket, and there is no session resource to give back.
    await expect(transport.open(context)).resolves.toBeUndefined();
    await expect(transport.close(context)).resolves.toBeUndefined();
  });

  it('reads its agentOptions when it builds the client, not before', () => {
    let asked = 0;
    const transport = new HttpTransport(() => {
      asked++;
      return { ca: 'PEM' };
    });

    expect(asked).toBe(0);

    // Building the client is what asks. Asking in the constructor would read
    // options the caller may not have loaded yet; the credential's material
    // is not among them — the provider offers it at logon.
    (transport as any).client();
    expect(asked).toBe(1);
  });

  it('builds the client once and keeps it', () => {
    const transport = new HttpTransport();

    const first = (transport as any).client();
    const second = (transport as any).client();

    expect(second).toBe(first);
  });

  it('carries the request through to the client', async () => {
    const transport = new HttpTransport();
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

    expect(seen[0]).toEqual(
      expect.objectContaining({
        method: 'GET',
        // The params serialised into the URL, once, by axios — what the client
        // guard checks is what goes out.
        url: 'https://h/sap/bc/adt/discovery?q=1',
        // The caller's headers, plus what the wire adds of its own accord —
        // today the affinity ask, and the cookies once it holds any.
        headers: expect.objectContaining({
          Accept: 'application/xml',
          'sap-adt-saplb': 'fetch',
        }),
        timeout: 1234,
      }),
    );
    expect(seen[0]).not.toHaveProperty('params');
    expect(response).toEqual(
      expect.objectContaining({ status: 200, data: 'ok' }),
    );
  });
});
