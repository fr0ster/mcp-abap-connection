/**
 * HTTP as a thing rather than as an `if`.
 *
 * The axis had one real value: RFC was an object, HTTP was a branch inside
 * `getAxiosInstance()`. That asymmetry is what stopped the axis being named in
 * a type — a default type parameter has nothing to point at when one of the two
 * values is a code path.
 *
 * The TLS material is the one place the two axes touch: it comes from the
 * CREDENTIAL (`transportMaterial()`) and configures the TRANSPORT. So it is
 * passed as a thunk, read when the client is first built — which is when the
 * credential has had its `prepare()` and knows what it holds.
 */
import { HttpTransport } from '../connection/HttpTransport.js';
import type { IAdtTransport } from '../connection/IAdtTransport.js';

describe('HttpTransport', () => {
  it('names itself http', () => {
    const transport: IAdtTransport = new HttpTransport();

    expect(transport.kind).toBe('http');
  });

  it('owns no wire to open or close', () => {
    const transport: IAdtTransport = new HttpTransport();

    // A request opens its own socket; there is no conversation to establish.
    // The optional members exist for transports that DO own one.
    expect(transport.open).toBeUndefined();
    expect(transport.close).toBeUndefined();
  });

  it('reads its TLS material when it builds the client, not before', () => {
    let asked = 0;
    const transport = new HttpTransport(() => {
      asked++;
      return { cert: 'PEM' };
    });

    expect(asked).toBe(0);

    // Building the client is what asks — by which time the credential has been
    // prepared. Asking in the constructor would read material that is not
    // loaded yet.
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
        url: 'https://h/sap/bc/adt/discovery',
        // The caller's headers, plus what the wire adds of its own accord —
        // today the affinity ask, and the cookies once it holds any.
        headers: expect.objectContaining({
          Accept: 'application/xml',
          'sap-adt-saplb': 'fetch',
        }),
        params: { q: '1' },
        timeout: 1234,
      }),
    );
    expect(response).toEqual(
      expect.objectContaining({ status: 200, data: 'ok' }),
    );
  });
});
