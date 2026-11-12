/**
 * A stateless request keeps its answer when the SAP session was replaced
 * (fr0ster/mcp-abap-adt#354) — against a real on-premise system over HTTP.
 *
 * The instance's session is logged off from outside, with the cookies
 * `sessionCookies()` handed out (without `sap-contextid`), as an idle timeout
 * would end it; the next request then meets SAP's replacement: a new
 * `SAP_SESSIONID` on a valid answer. No object is touched and no lock taken.
 *
 * Requires an env file named by `SAP_ENV_FILE` with SAP_URL, SAP_CLIENT,
 * SAP_USERNAME and SAP_PASSWORD (Basic). Without it the block is skipped with
 * the reason in its title — not being runnable here is not a failure. Before a
 * run, check the system's `401` realm without credentials.
 *
 * Run:
 *   SAP_ENV_FILE=<file> npm run test:ci -- sessionReplaced-live
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BasicAuthProvider } from '@mcp-abap-adt/auth-providers';
import { ADT_SESSION_ERROR } from '@mcp-abap-adt/interfaces-adt-connection';
import * as dotenv from 'dotenv';
import type { SapHttpConfig } from '../config/sapConfig.js';
import {
  type CreatedConnection,
  createConnection,
} from '../connection/createConnection.js';
import {
  type HttpClientFactory,
  nodeHttpClient,
} from '../connection/HttpTransport.js';
import { assertMatchObject } from './helpers/assertions.js';

const envFile = process.env.SAP_ENV_FILE;
if (envFile !== undefined && envFile !== '') {
  dotenv.config({ path: envFile, quiet: true });
}

const DISCOVERY = '/sap/bc/adt/discovery';
const LOGOFF = '/sap/public/bc/icf/logoff';

/** A variable of the env file, or `undefined` when it is absent or empty. */
function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

/** The config the env file states, or why it cannot run here. */
function liveConfig(): SapHttpConfig | string {
  if (envFile === undefined || envFile === '') return 'SAP_ENV_FILE is not set';
  const names = ['SAP_URL', 'SAP_CLIENT', 'SAP_USERNAME', 'SAP_PASSWORD'];
  const missing = names.filter((name) => env(name) === undefined);
  if (missing.length > 0) return `the env file lacks ${missing.join(', ')}`;
  return {
    url: env('SAP_URL') ?? '',
    client: env('SAP_CLIENT') ?? '',
    authType: 'basic',
    username: env('SAP_USERNAME') ?? '',
    password: env('SAP_PASSWORD') ?? '',
  };
}

/** One request as the wire sent it: its path and the session cookie's value. */
interface Sent {
  path: string;
  session: string | undefined;
}

/** The value of the first `SAP_SESSIONID_*` pair of a `Cookie` header. */
function sessionOf(cookie: unknown): string | undefined {
  if (typeof cookie !== 'string') return undefined;
  const pair = cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('SAP_SESSIONID'));
  if (pair === undefined) return undefined;
  return pair.slice(pair.indexOf('=') + 1);
}

/** The HTTP client every consumer may hand in, recording what it sends. */
function recordingClient(sent: Sent[]): HttpClientFactory {
  return {
    create: (agents) => {
      const client = nodeHttpClient.create(agents);
      client.interceptors.request.use((config) => {
        const url = config.url ?? '';
        const path = new URL(url, 'http://placeholder').pathname;
        sent.push({ path, session: sessionOf(config.headers.get('Cookie')) });
        return config;
      });
      return client;
    },
    logoffRequest: nodeHttpClient.logoffRequest,
  };
}

/** The instance's session ended from outside, as an idle timeout ends it. */
async function logOffFromOutside(
  config: SapHttpConfig,
  conn: CreatedConnection,
): Promise<string> {
  const cookies = conn.sessionCookies();
  assert.ok(cookies, 'the instance holds a session');
  const kept = cookies
    .split(';')
    .map((part) => part.trim())
    .filter((part) => !part.startsWith('sap-contextid='))
    .join('; ');
  const answer = await fetch(new URL(LOGOFF, config.url), {
    headers: { Cookie: kept },
  });
  assert.strictEqual(answer.status, 200, 'the outside logoff answered 200');
  const old = sessionOf(kept);
  assert.ok(old, 'the handed cookies name a SAP_SESSIONID');
  return old;
}

const config = liveConfig();

if (typeof config === 'string') {
  describe(`a replaced session on onprem over HTTP — skipped: ${config}`, () => {
    it('needs a live system', { skip: config }, () => {});
  });
} else {
  // Narrowed once, here: the closures below see the config itself.
  const live: SapHttpConfig = config;
  describe('a replaced session on onprem over HTTP', () => {
    function instance(sent: Sent[]): CreatedConnection {
      return createConnection({
        system: 'onprem',
        transport: 'http',
        config: live,
        credential: new BasicAuthProvider(
          live.username ?? '',
          live.password ?? '',
        ),
        httpClient: recordingClient(sent),
      });
    }

    const discovery = (conn: CreatedConnection) =>
      conn.makeAdtRequest<string>({
        url: DISCOVERY,
        method: 'GET',
        timeout: 0,
        headers: { Accept: 'application/atomsvc+xml' },
      });

    it('a stateless GET keeps its answer, marked; the instance is spent; the replacing session is logged off', async () => {
      const sent: Sent[] = [];
      const conn = instance(sent);
      try {
        await conn.connect();
        const old = await logOffFromOutside(live, conn);

        const response = await discovery(conn);

        assert.strictEqual(response.status, 200);
        assert.strictEqual(
          response.sessionLost,
          ADT_SESSION_ERROR.SESSION_REPLACED,
        );
        assert.ok(String(response.headers['content-type']).includes('atomsvc'));
        assert.ok(String(response.data).includes('<app:service'));
        assert.strictEqual(conn.isConnected(), false);
        assert.strictEqual(conn.sessionCookies(), null);

        const before = sent.filter((request) => request.path !== LOGOFF).length;
        await assert.rejects(discovery(conn), (e: unknown) => {
          assertMatchObject(e, { code: ADT_SESSION_ERROR.NOT_CONNECTED });
          return true;
        });
        assert.strictEqual(
          sent.filter((request) => request.path !== LOGOFF).length,
          before,
          'nothing was sent for the request after the loss',
        );

        await conn.flushGoodbye();
        const replacingLogoffs = sent.filter(
          (request) =>
            request.path === LOGOFF &&
            request.session !== undefined &&
            request.session !== old,
        );
        assert.strictEqual(replacingLogoffs.length, 1);
      } finally {
        await conn.disconnect().catch(() => undefined);
        await conn.flushGoodbye().catch(() => undefined);
      }
    });

    it('a stateful request rejects ADT_SESSION_REPLACED', async () => {
      const sent: Sent[] = [];
      const conn = instance(sent);
      try {
        await conn.connect();
        const old = await logOffFromOutside(live, conn);

        conn.setSessionType('stateful');
        await assert.rejects(discovery(conn), (e: unknown) => {
          assertMatchObject(e, { code: ADT_SESSION_ERROR.SESSION_REPLACED });
          assert.strictEqual(
            Object.getOwnPropertyDescriptor(e, 'sessionLost'),
            undefined,
          );
          return true;
        });
        assert.strictEqual(conn.isConnected(), false);

        await conn.flushGoodbye();
        const replacingLogoffs = sent.filter(
          (request) =>
            request.path === LOGOFF &&
            request.session !== undefined &&
            request.session !== old,
        );
        assert.strictEqual(replacingLogoffs.length, 1);
      } finally {
        await conn.disconnect().catch(() => undefined);
        await conn.flushGoodbye().catch(() => undefined);
      }
    });
  });
}
