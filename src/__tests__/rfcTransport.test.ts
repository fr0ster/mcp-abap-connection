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

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import type { IAdtTransport } from '../connection/IAdtTransport.js';
import type { IRfcTransportOptions } from '../connection/RfcTransport.js';
import { RfcTransport } from '../connection/RfcTransport.js';
import type { ILogger } from '../logger.js';
import { assertMatchObject } from './helpers/assertions.js';

type Call = { fm: string; params: Record<string, any> };

/** A stand-in for the native client, which needs the SAP NW RFC SDK to exist. */
function fakeClient(response: Record<string, unknown>) {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      alive: true,
      open: mock.fn(async () => {}),
      close: mock.fn(async () => {}),
      call: mock.fn(async (fm: string, params: Record<string, any>) => {
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

    assert.strictEqual(transport.kind, 'rfc');
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

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].fm, 'SADT_REST_RFC_ENDPOINT');
    assert.deepStrictEqual(calls[0].params.REQUEST.REQUEST_LINE, {
      METHOD: 'POST',
      URI: '/sap/bc/adt/oo/classes/ZCL_X',
      VERSION: 'HTTP/1.1',
    });
    assert.ok(
      calls[0].params.REQUEST.HEADER_FIELDS.some((item: unknown) =>
        isDeepStrictEqual(item, {
          NAME: 'x-csrf-token',
          VALUE: 'TOKEN',
        }),
      ),
    );
    assert.strictEqual(
      calls[0].params.REQUEST.MESSAGE_BODY.toString('utf-8'),
      'source',
    );
  });

  it('supplies an Accept when the caller named none', async () => {
    // Measured against E19: without one, ADT answers 400
    // `ExceptionResourceBadRequest: Accept header missing`. Over HTTP axios
    // supplies the default and nobody notices; `SADT_REST_RFC_ENDPOINT`
    // forwards only what it is handed, so the same call dies on this wire.
    const { transport, calls } = transportWith(okResponse);
    await transport.open();

    await transport.send({
      method: 'GET',
      url: '/sap/bc/adt/core/discovery',
    });

    assert.ok(
      calls[0].params.REQUEST.HEADER_FIELDS.some((item: unknown) =>
        isDeepStrictEqual(item, {
          NAME: 'Accept',
          VALUE: '*/*',
        }),
      ),
    );
  });

  it('leaves an Accept the caller named alone', async () => {
    const { transport, calls } = transportWith(okResponse);
    await transport.open();

    await transport.send({
      method: 'GET',
      url: '/sap/bc/adt/core/discovery',
      headers: { Accept: 'application/atomsvc+xml' },
    });

    const accepts = calls[0].params.REQUEST.HEADER_FIELDS.filter(
      (h: { NAME: string }) => h.NAME.toLowerCase() === 'accept',
    );
    assert.deepStrictEqual(accepts, [
      { NAME: 'Accept', VALUE: 'application/atomsvc+xml' },
    ]);
  });

  it('reads the answer back into a status, headers and a body', async () => {
    const { transport } = transportWith(okResponse);
    await transport.open();

    const response = await transport.send({
      method: 'GET',
      url: '/sap/bc/adt/discovery',
    });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.statusText, 'OK');
    assert.deepStrictEqual(response.headers, { 'x-csrf-token': 'TOKEN' });
    assert.strictEqual(response.data, '<service/>');
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

    await assert.rejects(
      transport.send({ method: 'GET', url: '/sap/bc/adt/discovery' }),
      (e: unknown) => {
        assertMatchObject(e, { response: { status: 401 } });
        return true;
      },
    );
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

    await assert.rejects(
      transport.send({ method: 'GET', url: '/sap/bc/adt/oo/classes/ZCL_NOPE' }),
      (e: unknown) => {
        assertMatchObject(e, { response: { status: 404 } });
        return true;
      },
    );
  });

  it('refuses to send before it is open', async () => {
    const { transport } = transportWith(okResponse);

    await assert.rejects(
      transport.send({ method: 'GET', url: '/sap/bc/adt/discovery' }),
      (e: unknown) => /not open/i.test((e as Error).message),
    );
  });

  it('closes the conversation, and a repeat close is a no-op', async () => {
    const { transport, client } = transportWith(okResponse);
    await transport.open();

    await transport.close();
    await transport.close();

    assert.strictEqual(client.close.mock.callCount(), 1);
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

    assert.strictEqual(
      calls[0].params.REQUEST.REQUEST_LINE.URI,
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

    assert.strictEqual(
      calls[0].params.REQUEST.REQUEST_LINE.URI,
      '/sap/bc/adt/x?already=1&more=2',
    );
  });

  it('are left out when there are none, rather than adding a bare "?"', async () => {
    const { transport, calls } = transportWith(okResponse);
    await transport.open();

    await transport.send({ method: 'GET', url: '/sap/bc/adt/discovery' });

    assert.strictEqual(
      calls[0].params.REQUEST.REQUEST_LINE.URI,
      '/sap/bc/adt/discovery',
    );
  });
});

/**
 * What the debug channel carries, and what it must never carry.
 *
 * `request.headers` reaches this wire verbatim from the caller, so what ends
 * up in HEADER_FIELDS is not a list this transport can enumerate — a consumer
 * is free to send a `Cookie` or an API key of its own. The log line is
 * advertised as safe to paste into an issue, and nothing but these tests holds
 * the redaction in place: drop it and every other test here still passes.
 */
describe('the RFC wire log', () => {
  function recordingLogger() {
    const lines: string[] = [];
    const logger: ILogger = {
      info: mock.fn(),
      error: mock.fn(),
      warn: mock.fn(),
      debug: mock.fn((message: string) => {
        lines.push(message);
      }),
    };
    return { lines, logger };
  }

  function loggingTransport(
    options?: IRfcTransportOptions,
    response: Record<string, unknown> = okResponse,
  ) {
    const { client } = fakeClient(response);
    const { lines, logger } = recordingLogger();
    const transport = new RfcTransport(() => client as never, logger, options);
    return { transport: transport as IAdtTransport & RfcTransport, lines };
  }

  const lineStartingWith = (lines: string[], prefix: string) =>
    lines.find((line) => line.startsWith(prefix));

  it('replaces a credential value whatever the header is called', async () => {
    const { transport, lines } = loggingTransport({ logWire: true });
    await transport.open();

    await transport.send({
      method: 'POST',
      url: '/sap/bc/adt/oo/classes/ZCL_X',
      headers: {
        Authorization: 'Basic ZGV2ZWxvcGVyOnNlY3JldA==',
        Cookie: 'SAP_SESSIONID_E19_100=abc; MYSAPSSO2=def',
        'x-csrf-token': 'TOKEN-VALUE',
        'X-Api-Key': 'KEY-VALUE',
        Accept: 'application/xml',
      },
      data: 'source',
    });

    const headers = lineStartingWith(lines, 'RFC HEADERS:');
    assert.notStrictEqual(headers, undefined);
    if (headers === undefined) return;
    assert.ok(!headers.includes('ZGV2ZWxvcGVyOnNlY3JldA=='));
    assert.ok(!headers.includes('SAP_SESSIONID_E19_100'));
    assert.ok(!headers.includes('TOKEN-VALUE'));
    assert.ok(!headers.includes('KEY-VALUE'));
    // The name survives: that the header was sent at all is half of what the
    // line is read for.
    assert.ok(headers.includes('Authorization'));
    assert.ok(headers.includes('x-csrf-token'));
    // And a header that is not a credential is left alone, or the line says
    // nothing.
    assert.ok(headers.includes('application/xml'));
  });

  it('says nothing about the wire unless the caller asked for it', async () => {
    const { transport, lines } = loggingTransport();
    await transport.open();

    await transport.send({
      method: 'POST',
      url: '/sap/bc/adt/oo/classes/ZCL_X',
      headers: { Authorization: 'Basic x' },
      data: 'source',
    });

    // `ILogger` has no level predicate, so this is the only opt-in there is.
    assert.strictEqual(lineStartingWith(lines, 'RFC HEADERS:'), undefined);
    assert.strictEqual(lineStartingWith(lines, 'RFC BODY'), undefined);
    assert.strictEqual(
      lineStartingWith(lines, 'RFC RESPONSE BODY:'),
      undefined,
    );
    // What was already there stays there.
    assert.ok(lines.includes('RFC → POST /sap/bc/adt/oo/classes/ZCL_X'));
  });

  it('clips a body to the ceiling rather than emitting megabytes', async () => {
    const big = 'x'.repeat(5000);
    const { transport, lines } = loggingTransport(
      { logWire: true, maxLoggedBodyChars: 10 },
      {
        RESPONSE: {
          STATUS_LINE: { STATUS_CODE: 200, REASON_PHRASE: 'OK' },
          HEADER_FIELDS: [],
          MESSAGE_BODY: Buffer.from(big, 'utf-8'),
        },
      },
    );
    await transport.open();

    await transport.send({
      method: 'PUT',
      url: '/sap/bc/adt/oo/classes/ZCL_X/source/main',
      data: big,
    });

    // The full size is still stated; only the bytes are cut.
    assert.strictEqual(
      lineStartingWith(lines, 'RFC BODY'),
      `RFC BODY (5000 chars): ${'x'.repeat(10)}… (+4990 more chars)`,
    );
    assert.strictEqual(
      lineStartingWith(lines, 'RFC RESPONSE BODY:'),
      `RFC RESPONSE BODY: ${'x'.repeat(10)}… (+4990 more chars)`,
    );
  });

  it('falls back to the default ceiling rather than honouring a nonsense one', async () => {
    // `slice(0, -5)` drops the END of the body while the line still reports
    // what was cut as a remainder — a log that lies about what it cut is
    // worse than one that cut too much, so a negative ceiling is refused.
    const big = 'x'.repeat(2500);
    const { transport, lines } = loggingTransport({
      logWire: true,
      maxLoggedBodyChars: -5,
    });
    await transport.open();

    await transport.send({
      method: 'PUT',
      url: '/sap/bc/adt/oo/classes/ZCL_X/source/main',
      data: big,
    });

    assert.strictEqual(
      lineStartingWith(lines, 'RFC BODY'),
      `RFC BODY (2500 chars): ${'x'.repeat(2000)}… (+500 more chars)`,
    );
  });

  it('asks for the whole body when the ceiling is Infinity', async () => {
    const big = 'x'.repeat(2500);
    const { transport, lines } = loggingTransport({
      logWire: true,
      maxLoggedBodyChars: Number.POSITIVE_INFINITY,
    });
    await transport.open();

    await transport.send({
      method: 'PUT',
      url: '/sap/bc/adt/oo/classes/ZCL_X/source/main',
      data: big,
    });

    assert.strictEqual(
      lineStartingWith(lines, 'RFC BODY'),
      `RFC BODY (2500 chars): ${big}`,
    );
  });

  it('leaves out a body line for a request that has no body', async () => {
    const { transport, lines } = loggingTransport({ logWire: true });
    await transport.open();

    await transport.send({ method: 'GET', url: '/sap/bc/adt/discovery' });

    assert.strictEqual(lineStartingWith(lines, 'RFC BODY'), undefined);
    assert.notStrictEqual(lineStartingWith(lines, 'RFC HEADERS:'), undefined);
  });
});
