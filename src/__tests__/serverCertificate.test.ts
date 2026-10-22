/**
 * The HTTP wire verifies the server certificate unless told, explicitly, not to.
 *
 * Verification is Node's default and this wire keeps it. It is turned off only
 * by `TLS_REJECT_UNAUTHORIZED=0`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, or
 * `agentOptions: { rejectUnauthorized: false }` — and `agentOptions` wins over
 * the environment, being the caller's own code. Anything else (unset, `1`, a
 * typo) verifies. A self-signed system is trusted with `agentOptions: { ca }`.
 *
 * The real transport against a real local HTTPS server: whether a handshake is
 * refused is not something a stub under the client can show. The server's
 * certificate is a committed throwaway fixture that nothing trusts (see
 * `fixtures/tls/README.md`).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AgentOptions } from 'node:https';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  mock,
} from 'node:test';
import { CloudHttpTransport } from '../connection/CloudHttpTransport.js';
import { HttpTransport } from '../connection/HttpTransport.js';
import { assertMatchObject } from './helpers/assertions.js';

const fixtures = join(__dirname, 'fixtures', 'tls');
const cert = readFileSync(join(fixtures, 'server.crt'), 'utf8');
const key = readFileSync(join(fixtures, 'server.key'), 'utf8');

const ENV_KEYS = ['TLS_REJECT_UNAUTHORIZED', 'NODE_TLS_REJECT_UNAUTHORIZED'];

describe('the server certificate', () => {
  let server: Server;
  let baseUrl: string;
  const saved: Record<string, string | undefined> = {};

  before(async () => {
    server = createServer({ cert, key }, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('reached');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    baseUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    for (const name of ENV_KEYS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of ENV_KEYS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  function wire(agentOptions: AgentOptions = {}): HttpTransport {
    return new HttpTransport(() => agentOptions, null, { baseUrl });
  }

  function get(transport: HttpTransport) {
    return transport.send({ method: 'GET', url: '/', headers: {} });
  }

  async function refusal(transport: HttpTransport): Promise<unknown> {
    try {
      const response = await get(transport);
      return { reached: response.data };
    } catch (error) {
      return error;
    }
  }

  it('is verified by default: an untrusted one is refused before any response', async () => {
    const error = await refusal(wire());

    assertMatchObject(error, { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    assert.strictEqual((error as { response?: unknown }).response, undefined);
  });

  it('is verified on the cloud wire too', async () => {
    const transport = new CloudHttpTransport(() => ({}), null, { baseUrl });

    await assert.rejects(get(transport), (e: unknown) => {
      assertMatchObject(e, {
        code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      });
      return true;
    });
  });

  it('is trusted through agentOptions.ca, with verification on', async () => {
    const response = await get(wire({ ca: cert }));

    assert.strictEqual(response.data, 'reached');
  });

  it('is not verified with TLS_REJECT_UNAUTHORIZED=0', async () => {
    process.env.TLS_REJECT_UNAUTHORIZED = '0';

    assertMatchObject(await get(wire()), { data: 'reached' });
  });

  it('is not verified with NODE_TLS_REJECT_UNAUTHORIZED=0', async () => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    assertMatchObject(await get(wire()), { data: 'reached' });
  });

  it('is not verified with agentOptions.rejectUnauthorized false', async () => {
    assertMatchObject(await get(wire({ rejectUnauthorized: false })), {
      data: 'reached',
    });
  });

  it('agentOptions wins over the environment: rejectUnauthorized true verifies under an env opt-out', async () => {
    process.env.TLS_REJECT_UNAUTHORIZED = '0';
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    await assert.rejects(
      get(wire({ rejectUnauthorized: true })),
      (e: unknown) => {
        assertMatchObject(e, { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
        return true;
      },
    );
  });

  for (const value of ['1', 'false', 'no', '', ' 0']) {
    it(`is verified when TLS_REJECT_UNAUTHORIZED is ${JSON.stringify(value)}`, async () => {
      process.env.TLS_REJECT_UNAUTHORIZED = value;

      await assert.rejects(get(wire()), (e: unknown) => {
        assertMatchObject(e, {
          code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
        });
        return true;
      });
    });
  }

  for (const value of ['1', 'false', 'no']) {
    it(`is verified when NODE_TLS_REJECT_UNAUTHORIZED is ${JSON.stringify(value)}`, async () => {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = value;

      await assert.rejects(get(wire()), (e: unknown) => {
        assertMatchObject(e, {
          code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
        });
        return true;
      });
    });
  }

  it('says once, in fixed words, that verification is off', async () => {
    process.env.TLS_REJECT_UNAUTHORIZED = '0';
    const debug = mock.fn();
    const logger = { info() {}, warn() {}, error() {}, debug };
    const transport = new HttpTransport(() => ({}), logger, { baseUrl });

    await get(transport);
    // A logon offering different TLS material drops the client; the next
    // request builds a new one. Saying it again there would be noise.
    (transport as any).instance = null;
    await get(transport);

    const off = debug.mock.calls
      .filter(({ arguments: [message] }) =>
        String(message).includes('not verified'),
      )
      .map((call) => call.arguments);
    assert.deepStrictEqual(off, [
      ['TLS: the server certificate is not verified (explicit opt-out)'],
    ]);
  });

  it('says nothing about an opt-out when verification is on', async () => {
    const debug = mock.fn();
    const logger = { info() {}, warn() {}, error() {}, debug };
    const transport = new HttpTransport(() => ({ ca: cert }), logger, {
      baseUrl,
    });

    await get(transport);

    assert.strictEqual(
      debug.mock.calls.some(({ arguments: [message] }) =>
        String(message).includes('not verified'),
      ),
      false,
    );
  });
});
