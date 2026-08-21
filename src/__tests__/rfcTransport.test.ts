/**
 * RFC as a transport: the same ADT REST call, over a different wire.
 *
 * What travels is an ADT request either way — `SADT_REST_RFC_ENDPOINT` is the
 * FM Eclipse ADT itself uses through JCo, and what it carries is a request
 * line, header fields and a body. So the translation is the whole of the
 * transport's job.
 *
 * Everything ABOVE the seam stays where it was: cookies, the CSRF token, the
 * `x-sap-adt-sessiontype` header and the session lifecycle belong to the
 * connection and are already in `request.headers` by the time this is called.
 * A transport that also captured cookies would be doing that work twice, and
 * the two copies would disagree.
 */
import type { IAdtTransport } from '../connection/IAdtTransport.js';
import { RfcTransport } from '../connection/RfcTransport.js';

type Call = { fm: string; params: Record<string, any> };

/** A stand-in for the native client, which needs the SAP NW RFC SDK to exist. */
function fakeClient(response: Record<string, unknown>) {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      alive: true,
      open: jest.fn(async () => {}),
      close: jest.fn(async () => {}),
      call: jest.fn(async (fm: string, params: Record<string, any>) => {
        calls.push({ fm, params });
        return response;
      }),
    },
  };
}

const okResponse = {
  RESPONSE: {
    STATUS_LINE: { STATUS_CODE: 200, REASON_PHRASE: 'OK' },
    HEADER_FIELDS: [{ NAME: 'X-CSRF-Token', VALUE: 'TOKEN' }],
    MESSAGE_BODY: Buffer.from('<service/>', 'utf-8'),
  },
};

function transportWith(response: Record<string, unknown>) {
  const { client, calls } = fakeClient(response);
  const transport = new RfcTransport(() => client as never, null);
  return {
    transport: transport as IAdtTransport & RfcTransport,
    calls,
    client,
  };
}

describe('RfcTransport', () => {
  it('names itself rfc', () => {
    const { transport } = transportWith(okResponse);

    expect(transport.kind).toBe('rfc');
  });

  it('carries the request as a request line, header fields and a body', async () => {
    const { transport, calls } = transportWith(okResponse);
    await transport.open();

    await transport.send({
      method: 'POST',
      url: '/sap/bc/adt/oo/classes/ZCL_X',
      headers: { 'x-csrf-token': 'TOKEN' },
      data: 'source',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].fm).toBe('SADT_REST_RFC_ENDPOINT');
    expect(calls[0].params.REQUEST.REQUEST_LINE).toEqual({
      METHOD: 'POST',
      URI: '/sap/bc/adt/oo/classes/ZCL_X',
      VERSION: 'HTTP/1.1',
    });
    expect(calls[0].params.REQUEST.HEADER_FIELDS).toContainEqual({
      NAME: 'x-csrf-token',
      VALUE: 'TOKEN',
    });
    expect(calls[0].params.REQUEST.MESSAGE_BODY.toString('utf-8')).toBe(
      'source',
    );
  });

  it('reads the answer back into a status, headers and a body', async () => {
    const { transport } = transportWith(okResponse);
    await transport.open();

    const response = await transport.send({
      method: 'GET',
      url: '/sap/bc/adt/discovery',
    });

    expect(response.status).toBe(200);
    expect(response.statusText).toBe('OK');
    expect(response.headers).toEqual({ 'x-csrf-token': 'TOKEN' });
    expect(response.data).toBe('<service/>');
  });

  it('throws with the response attached, as the classification above expects', async () => {
    const { transport } = transportWith({
      RESPONSE: {
        STATUS_LINE: { STATUS_CODE: 401, REASON_PHRASE: 'Unauthorized' },
        HEADER_FIELDS: [],
        MESSAGE_BODY: Buffer.alloc(0),
      },
    });
    await transport.open();

    await expect(
      transport.send({ method: 'GET', url: '/sap/bc/adt/discovery' }),
    ).rejects.toMatchObject({ response: { status: 401 } });
  });

  it('reads a status out of ADT exception XML when STATUS_LINE is empty', async () => {
    // BASIS < 7.50 answers without populating STATUS_LINE, so a failure would
    // otherwise read as 200 with an error document in the body.
    const { transport } = transportWith({
      RESPONSE: {
        STATUS_LINE: {},
        HEADER_FIELDS: [],
        MESSAGE_BODY: Buffer.from(
          '<exc:exception><exc:type>ExceptionResourceNotFound</exc:type></exc:exception>',
          'utf-8',
        ),
      },
    });
    await transport.open();

    await expect(
      transport.send({ method: 'GET', url: '/sap/bc/adt/oo/classes/ZCL_NOPE' }),
    ).rejects.toMatchObject({ response: { status: 404 } });
  });

  it('refuses to send before it is open', async () => {
    const { transport } = transportWith(okResponse);

    await expect(
      transport.send({ method: 'GET', url: '/sap/bc/adt/discovery' }),
    ).rejects.toThrow(/not open/i);
  });

  it('closes the conversation, and a repeat close is a no-op', async () => {
    const { transport, client } = transportWith(okResponse);
    await transport.open();

    await transport.close();
    await transport.close();

    expect(client.close).toHaveBeenCalledTimes(1);
  });
});

describe('query parameters', () => {
  // axios serialises `params` into the query string for HTTP. RFC has no such
  // step, so a transport that ignored them would send the request without its
  // query — silently, and only over RFC. The class this replaced encoded them
  // by hand for exactly this reason.
  it('are encoded into the URI, which is the only place RFC can carry them', async () => {
    const { transport, calls } = transportWith(okResponse);
    await transport.open();

    await transport.send({
      method: 'GET',
      url: '/sap/bc/adt/repository/informationsystem/search',
      params: { operation: 'quickSearch', query: 'CL_ABAP*', maxResults: 3 },
    });

    expect(calls[0].params.REQUEST.REQUEST_LINE.URI).toBe(
      '/sap/bc/adt/repository/informationsystem/search' +
        // URLSearchParams leaves `*` alone — it is legal in a query, and this is
        // byte for byte what the class this replaced produced.
        '?operation=quickSearch&query=CL_ABAP*&maxResults=3',
    );
  });

  it('join a URI that already carries some', async () => {
    const { transport, calls } = transportWith(okResponse);
    await transport.open();

    await transport.send({
      method: 'GET',
      url: '/sap/bc/adt/x?already=1',
      params: { more: '2' },
    });

    expect(calls[0].params.REQUEST.REQUEST_LINE.URI).toBe(
      '/sap/bc/adt/x?already=1&more=2',
    );
  });

  it('are left out when there are none, rather than adding a bare "?"', async () => {
    const { transport, calls } = transportWith(okResponse);
    await transport.open();

    await transport.send({ method: 'GET', url: '/sap/bc/adt/discovery' });

    expect(calls[0].params.REQUEST.REQUEST_LINE.URI).toBe(
      '/sap/bc/adt/discovery',
    );
  });
});
