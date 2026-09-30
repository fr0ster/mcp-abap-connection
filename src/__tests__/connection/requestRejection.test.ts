/**
 * A request: authorized per attempt; a 401 that survives the wire's own
 * recovery goes to the provider's `rejected()`, and Ok buys one more attempt.
 *
 * A real `OnPremHttpTransport` against a local SAP that enforces CSRF, with a
 * stub provider that records every call. The provider's header is
 * `Stub <n>`, `n` the Ok answers `rejected` has given — so a request that
 * carries `Stub 1` carried the renewed credential.
 *
 * A GET 401 is first retried by the wire itself while it holds the session's
 * cookies, so a 401 reaches the provider only when it comes twice.
 */
import type {
  AuthOutcome,
  IAuthRejection,
} from '@mcp-abap-adt/interfaces-auth';
import type { SapConfig } from '../../config/sapConfig.js';
import { AdtOnPremConnector } from '../../connection/AdtOnPremConnector.js';
import {
  AuthRefusedError,
  REFUSED_AGAIN,
} from '../../connection/authErrors.js';
import { OnPremHttpTransport } from '../../connection/OnPremHttpTransport.js';
import { type SapStub, startSapStub } from '../helpers/sapStub.js';
import { type StubScript, stubProvider } from '../helpers/stubProvider.js';

const WORK = '/sap/bc/adt/work';
const DISCOVERY = '/sap/bc/adt/core/discovery';
const OK: AuthOutcome = { ok: true };
const NO: AuthOutcome = {
  ok: false,
  refusal: { reason: 'the stub says no', hint: 'ask it nicely' },
};

let stub: SapStub;

beforeEach(async () => {
  stub = await startSapStub();
});

afterEach(async () => {
  await stub.close();
});

async function connected(script: StubScript = {}) {
  const config: SapConfig = {
    url: stub.baseUrl,
    client: '100',
    authType: 'basic',
  } as SapConfig;
  const provider = stubProvider(script);
  const transport = new OnPremHttpTransport(() => ({}), null, {
    client: '100',
    baseUrl: stub.baseUrl,
  });
  const conn = new AdtOnPremConnector(config, provider, transport, null);
  await conn.connect();
  const rejections = () =>
    provider.calls
      .filter((call) => call.method === 'rejected')
      .map((call) => call.argument as IAuthRejection);
  return { conn, provider, transport, rejections };
}

const get = (conn: AdtOnPremConnector, url = WORK) =>
  conn.makeAdtRequest({ url, method: 'GET', timeout: 5000 });

const post = (conn: AdtOnPremConnector, url = WORK) =>
  conn.makeAdtRequest({ url, method: 'POST', timeout: 5000, data: '<x/>' });

const statusOf = (error: unknown) =>
  (error as { response?: { status?: number } } | undefined)?.response?.status;

describe('a 401 that survives the wire', () => {
  it('asks rejected once, at request, and the resend carries the renewed credential', async () => {
    const { conn, rejections } = await connected();
    stub.work(WORK, [401, 401]);

    const response = await get(conn);

    expect(response.status).toBe(200);
    expect(rejections()).toHaveLength(1);
    expect(rejections()[0]).toMatchObject({ at: 'request', status: 401 });
    const sent = stub.sentTo(WORK);
    expect(sent).toHaveLength(3);
    expect(sent[2].headers.authorization).toBe('Stub 1');
  });

  it('an Oops is an AuthRefusedError at request in the provider words, the 401 as cause', async () => {
    const { conn } = await connected({ rejected: [NO] });
    stub.work(WORK, [401, 401]);

    const error = await get(conn).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthRefusedError);
    expect((error as AuthRefusedError).at).toBe('request');
    expect((error as AuthRefusedError).refusal).toBe(
      (NO as { refusal: unknown }).refusal,
    );
    expect(statusOf((error as AuthRefusedError).cause)).toBe(401);
    expect(stub.sentTo(WORK)).toHaveLength(2);
  });

  it('refused again after Ok is the verdict, and rejected is asked once', async () => {
    const { conn, rejections } = await connected();
    stub.work(WORK, [401, 401, 401]);

    const error = await get(conn).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthRefusedError);
    expect((error as AuthRefusedError).refusal).toBe(REFUSED_AGAIN);
    expect(statusOf((error as AuthRefusedError).cause)).toBe(401);
    expect(rejections()).toHaveLength(1);
  });

  it('a 403 is thrown unchanged, and rejected is never asked', async () => {
    const { conn, rejections } = await connected();
    stub.work(WORK, [{ status: 403, body: 'no authorization for S_DEVELOP' }]);

    const error = await get(conn).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(AuthRefusedError);
    expect(statusOf(error)).toBe(403);
    expect(rejections()).toHaveLength(0);
  });
});

describe("the wire's own recovery", () => {
  it('cures a stale CSRF 403 on a POST without asking rejected', async () => {
    const { conn, transport, rejections } = await connected();
    transport.adoptCsrfToken('STALE');

    const response = await post(conn);

    expect(response.status).toBe(200);
    expect(rejections()).toHaveLength(0);
    expect(stub.sentTo(WORK).map((request) => request.status)).toEqual([
      403, 200,
    ]);
  });

  it('re-authorizes its resend (path a): the resend carries a new header', async () => {
    let attempt = 0;
    const { conn, transport } = await connected({
      authorize: [
        (request) => {
          attempt += 1;
          request.header('X-Attempt', String(attempt));
          return OK;
        },
      ],
    });
    transport.adoptCsrfToken('STALE');

    await post(conn);

    const [first, resend] = stub.sentTo(WORK);
    expect(resend.headers['x-attempt']).toBeDefined();
    expect(resend.headers['x-attempt']).not.toBe(first.headers['x-attempt']);
  });

  it('a token fetch refused with 401 goes to rejected at logon, not the 403; Ok → fetch again, POST with the new token', async () => {
    const { conn, transport, rejections } = await connected();
    transport.adoptCsrfToken('STALE');
    stub.discovery.push(401);

    const response = await post(conn);

    expect(response.status).toBe(200);
    expect(rejections()).toHaveLength(1);
    expect(rejections()[0]).toMatchObject({ at: 'logon', status: 401 });
    expect(statusOf(rejections()[0].error)).toBe(401);
    const sent = stub.sentTo(WORK);
    expect(sent[sent.length - 1].headers['x-csrf-token']).toBe(
      stub.tokens[stub.tokens.length - 1],
    );
    expect(sent[sent.length - 1].status).toBe(200);
  });

  it('a token fetch refused twice is refused again, rejected asked once', async () => {
    const { conn, transport, rejections } = await connected();
    transport.adoptCsrfToken('STALE');
    stub.discovery.push(401, 401);

    const error = await post(conn).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthRefusedError);
    expect((error as AuthRefusedError).refusal).toBe(REFUSED_AGAIN);
    expect((error as AuthRefusedError).at).toBe('logon');
    expect(rejections()).toHaveLength(1);
  });

  it('a CSRF resend that meets a 401 goes to rejected at request, not the 403', async () => {
    const { conn, transport, rejections } = await connected();
    transport.adoptCsrfToken('STALE');
    stub.work(WORK, [401]);

    const response = await post(conn);

    expect(response.status).toBe(200);
    expect(rejections()).toHaveLength(1);
    expect(rejections()[0]).toMatchObject({ at: 'request', status: 401 });
  });

  it('a CSRF resend the provider refuses to authorize is its AuthRefusedError, not the 403', async () => {
    // The provider says no once the wire has a new token — which is when the
    // resend is re-authorized.
    const { conn, transport } = await connected({
      authorize: [() => (stub.tokens.length >= 2 ? NO : OK)],
    });
    transport.adoptCsrfToken('STALE');

    const error = await post(conn).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthRefusedError);
    expect((error as AuthRefusedError).refusal).toBe(
      (NO as { refusal: unknown }).refusal,
    );
    expect(stub.sentTo(WORK)).toHaveLength(1);
  });

  it('a GET whose path-(b) token fetch meets a 401 goes to rejected, not the original error', async () => {
    const { conn, rejections } = await connected();
    // A wire that holds nothing: path (b) has no cookies to resend with and
    // fetches a token to get some.
    (conn as unknown as { invalidateSession(): void }).invalidateSession();
    stub.work(WORK, [401]);
    stub.discovery.push(401);

    const response = await get(conn);

    expect(response.status).toBe(200);
    expect(rejections()).toHaveLength(1);
    expect(rejections()[0]).toMatchObject({ at: 'logon', status: 401 });
  });
});

describe('the upfront token fetch before a mutation', () => {
  // Each starts with the wire holding no token, so the POST fetches one first.

  it('a provider that says no while the fetch is authorized ends the request before anything is sent', async () => {
    // Refuses once, the fetch's authorization: a request that went on anyway
    // would be authorized and sent.
    let refusals = 0;
    const { conn, transport } = await connected({
      authorize: [() => (refusals-- > 0 ? NO : OK)],
    });
    transport.adoptCsrfToken(null);
    refusals = 1;

    const error = await post(conn).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthRefusedError);
    expect((error as AuthRefusedError).refusal).toBe(
      (NO as { refusal: unknown }).refusal,
    );
    expect(stub.sentTo(WORK)).toHaveLength(0);
  });

  it('a fetch refused with 401 goes to rejected at logon; Ok → fetch once more, the POST with the new token', async () => {
    const { conn, transport, rejections } = await connected();
    transport.adoptCsrfToken(null);
    stub.discovery.push(401);

    const response = await post(conn);

    expect(response.status).toBe(200);
    expect(rejections()).toHaveLength(1);
    expect(rejections()[0]).toMatchObject({ at: 'logon', status: 401 });
    const sent = stub.sentTo(WORK);
    expect(sent).toHaveLength(1);
    expect(sent[0].headers['x-csrf-token']).toBe(
      stub.tokens[stub.tokens.length - 1],
    );
  });

  it('a fetch refused twice is refused again, and no POST is sent', async () => {
    const { conn, transport, rejections } = await connected();
    transport.adoptCsrfToken(null);
    stub.discovery.push(401, 401);

    const error = await post(conn).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthRefusedError);
    expect((error as AuthRefusedError).refusal).toBe(REFUSED_AGAIN);
    expect(rejections()).toHaveLength(1);
    expect(stub.sentTo(WORK)).toHaveLength(0);
  });

  it('spends the one retry: a POST refused after it is refused again without asking a second time', async () => {
    const { conn, transport, rejections } = await connected();
    transport.adoptCsrfToken(null);
    stub.discovery.push(401);
    stub.work(WORK, [401, 401, 401]);

    const error = await post(conn).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthRefusedError);
    expect((error as AuthRefusedError).refusal).toBe(REFUSED_AGAIN);
    // Asked once, about the fetch — the POST's 401s spent nothing more.
    expect(rejections()).toHaveLength(1);
    expect(rejections()[0]).toMatchObject({ at: 'logon', status: 401 });
  });

  it('a fetch that fails any other way is swallowed, and the mutation goes on as today', async () => {
    const { conn, transport, rejections } = await connected();
    transport.adoptCsrfToken(null);
    // The upfront fetch's first try and its three retries.
    stub.discovery.push(500, 500, 500, 500);

    const response = await post(conn);

    expect(response.status).toBe(200);
    expect(rejections()).toHaveLength(0);
    expect(stub.sentTo(WORK).map((request) => request.status)).toEqual([
      403, 200,
    ]);
  }, 20000);
});

describe('many requests, and a critical section', () => {
  it('two concurrent requests meeting two 401s each ask rejected once and both end 200', async () => {
    const { conn, rejections } = await connected();
    stub.work('/sap/bc/adt/a', [401, 401]);
    stub.work('/sap/bc/adt/b', [401, 401]);

    const [a, b] = await Promise.all([
      get(conn, '/sap/bc/adt/a'),
      get(conn, '/sap/bc/adt/b'),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(rejections()).toHaveLength(2);
    expect(stub.sentTo('/sap/bc/adt/a')).toHaveLength(3);
    expect(stub.sentTo('/sap/bc/adt/b')).toHaveLength(3);
  });

  it('inside a critical section, a surviving 401 is resent on the same session', async () => {
    const { conn, rejections } = await connected();
    const identity = conn.getSessionIdentity();
    stub.work(WORK, [401, 401]);

    conn.beginCriticalSection();
    try {
      const response = await get(conn);
      expect(response.status).toBe(200);
    } finally {
      conn.endCriticalSection();
    }

    expect(rejections()).toHaveLength(1);
    expect(conn.getSessionIdentity()).toBe(identity);
    expect(conn.isConnected()).toBe(true);
    expect(stub.sentTo(DISCOVERY)).toHaveLength(1);
  });
});
