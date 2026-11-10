/**
 * The CSRF token fetch of a logon is one request, never a retry loop.
 *
 * A failed request is its own error. Asked again, a host that refused the
 * connection or answered 500 tells nothing new, and every repeat added its own
 * delay: a logon against a closed port made four requests about a second apart
 * before the caller heard anything. So the fetch asks once and the failure
 * reaches the caller at once, with no timer of the package's choosing.
 *
 * The one second request is not a retry: the fallback endpoint, asked only
 * after the first answered 404 — BASIS < 7.52 has no
 * `/sap/bc/adt/core/discovery`.
 *
 * Read on a real local socket (the stub SAP, a port nobody listens on) and with
 * every timer API watched (`helpers/packageTimers.ts`), so a delay put back is
 * caught however short it is and whichever API arms it.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { BasicAuthProvider } from '@mcp-abap-adt/auth-providers';
import type { SapHttpConfig } from '../config/sapConfig.js';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import {
  type IAdtEstablishContext,
  type IAdtTransportRequest,
  refusalOf,
} from '../connection/IAdtTransport.js';
import { OnPremHttpTransport } from '../connection/OnPremHttpTransport.js';
import { watchTimers } from './helpers/packageTimers.js';
import { type SapStub, startSapStub } from './helpers/sapStub.js';

const CORE = '/sap/bc/adt/core/discovery';
const FALLBACK = '/sap/bc/adt/discovery';

/** A local port that was bound and released: nothing listens on it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

const config = (url: string): SapHttpConfig => ({
  url,
  authType: 'basic',
  username: 'u',
  password: 'p',
  client: '100',
});

const wireAt = (baseUrl: string) =>
  new OnPremHttpTransport(() => ({}), null, { client: '100', baseUrl });

const context = (): IAdtEstablishContext => ({
  authorize: async () => {},
  logon: async () => {},
  observe: () => {},
});

/** Records each request the wire sends, and still sends it. */
function recordSends(transport: OnPremHttpTransport): IAdtTransportRequest[] {
  const sent: IAdtTransportRequest[] = [];
  const send = transport.send.bind(transport);
  transport.send = (request) => {
    sent.push(request);
    return send(request);
  };
  return sent;
}

/** A Node system error's `code`, or `undefined`. */
function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

/** An on-prem connection over `transport`, with a password credential. */
const connectorOver = (url: string, transport: OnPremHttpTransport) =>
  new AdtOnPremConnector(
    config(url),
    new BasicAuthProvider('u', 'p'),
    transport,
    null,
  );

describe('the CSRF fetch asks once', () => {
  let stub: SapStub;

  beforeEach(async () => {
    stub = await startSapStub();
  });

  afterEach(async () => {
    mock.restoreAll();
    await stub.close();
  });

  it('a closed port: one request, the refusal at once, no timer', async () => {
    const port = await closedPort();
    const transport = wireAt(`http://127.0.0.1:${port}`);
    const sent = recordSends(transport);
    const timers = watchTimers();

    await assert.rejects(transport.establish(context()), (error: unknown) => {
      assert.strictEqual(codeOf(error), 'ECONNREFUSED');
      return true;
    });

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0]?.url, `http://127.0.0.1:${port}${CORE}`);
    assert.strictEqual(timers.ours(), 0);
  });

  it('a refusing endpoint (500): one request, SAP’s answer as it came, no timer', async () => {
    stub.discovery.push(500);
    const transport = wireAt(stub.baseUrl);
    const timers = watchTimers();

    await assert.rejects(transport.establish(context()), (error: unknown) => {
      assert.strictEqual(refusalOf(error)?.status, 500);
      return true;
    });

    assert.strictEqual(stub.requests.length, 1);
    assert.strictEqual(stub.requests[0]?.path, CORE);
    assert.strictEqual(timers.ours(), 0);
    // The next one would have been answered: nothing asked it.
    assert.strictEqual(transport.csrfToken(), null);
  });

  it('connect() against a closed port: one request, rejected at once, no timer', async () => {
    const port = await closedPort();
    const url = `http://127.0.0.1:${port}`;
    const transport = wireAt(url);
    const sent = recordSends(transport);
    const conn = connectorOver(url, transport);
    const timers = watchTimers();
    const started = Date.now();

    await assert.rejects(conn.connect(), (error: unknown) => {
      assert.strictEqual(codeOf(error), 'ECONNREFUSED');
      return true;
    });

    assert.deepStrictEqual(
      sent.map((request) => request.url),
      [`${url}${CORE}`],
    );
    assert.strictEqual(timers.ours(), 0);
    // Four requests a second apart took three seconds; a local refusal takes
    // milliseconds. The bound is loose: the timer count above is the proof.
    assert.ok(Date.now() - started < 2000);
  });

  it('connect() against a refusing endpoint: one request to the endpoint', async () => {
    stub.discovery.push(500, 500, 500, 500);
    const conn = connectorOver(stub.baseUrl, wireAt(stub.baseUrl));
    const timers = watchTimers();

    await assert.rejects(conn.connect());

    assert.deepStrictEqual(
      stub.requests.map((request) => request.path),
      [CORE],
    );
    assert.strictEqual(timers.ours(), 0);
  });

  it('a 404 on the first endpoint: the fallback is asked once, and its token kept', async () => {
    stub.discovery.push(404);
    const transport = wireAt(stub.baseUrl);
    const timers = watchTimers();

    await transport.establish(context());

    assert.deepStrictEqual(
      stub.requests.map((request) => request.path),
      [CORE, FALLBACK],
    );
    assert.strictEqual(transport.csrfToken(), 'TOKEN-1');
    assert.strictEqual(timers.ours(), 0);
  });

  it('a 404 on both endpoints: two requests, the fallback’s answer is the error', async () => {
    stub.discovery.push(404, 404, 404, 404);
    const transport = wireAt(stub.baseUrl);
    const timers = watchTimers();

    await assert.rejects(transport.establish(context()), (error: unknown) => {
      assert.strictEqual(refusalOf(error)?.status, 404);
      return true;
    });

    assert.deepStrictEqual(
      stub.requests.map((request) => request.path),
      [CORE, FALLBACK],
    );
    assert.strictEqual(timers.ours(), 0);
  });

  it('a 500 on the first endpoint: the fallback is not asked', async () => {
    stub.discovery.push(500);
    const transport = wireAt(stub.baseUrl);

    await assert.rejects(transport.establish(context()));

    assert.deepStrictEqual(
      stub.requests.map((request) => request.path),
      [CORE],
    );
  });
});
