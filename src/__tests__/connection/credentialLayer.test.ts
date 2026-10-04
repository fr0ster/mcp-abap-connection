/**
 * Every attempt carries exactly what the provider writes for THAT attempt, on
 * top of the request's own headers.
 *
 * A provider may write a header on one attempt and only cookies on the next,
 * or rename its cookie when it renews. Whatever it wrote before must not ride
 * along on a resend: a stale `Authorization` beside a new SSO cookie is a
 * request authenticated twice, as two different things. What the wire adds —
 * its session cookie, the new CSRF token, the `sap-client` it addresses — must
 * survive.
 *
 * A real `OnPremHttpTransport` against a local SAP that enforces CSRF.
 */

import type {
  AuthOutcome,
  IAuthProvider,
  IRequestTarget,
} from '@mcp-abap-adt/interfaces-auth';
import type { SapConfig } from '../../config/sapConfig.js';
import { AdtOnPremConnector } from '../../connection/AdtOnPremConnector.js';
import { OnPremHttpTransport } from '../../connection/OnPremHttpTransport.js';
import { type SapStub, startSapStub } from '../helpers/sapStub.js';

const WORK = '/sap/bc/adt/work';
const SESSION = 'SAP_SESSIONID_STUB_100';
const OK: AuthOutcome = { ok: true };

let stub: SapStub;

beforeEach(async () => {
  stub = await startSapStub();
});

afterEach(async () => {
  await stub.close();
});

/**
 * A provider whose every authorization is `write`, handed how many times
 * `rejected` has answered Ok.
 */
function providerWriting(
  write: (request: IRequestTarget, renewals: number) => void,
): IAuthProvider {
  let renewals = 0;
  return {
    kind: 'layer',
    prepare: async () => OK,
    establish: async () => OK,
    authorize: async (request) => {
      write(request, renewals);
      return OK;
    },
    rejected: async () => {
      renewals += 1;
      return OK;
    },
  };
}

async function connected(provider: IAuthProvider) {
  const config = {
    url: stub.baseUrl,
    client: '100',
    authType: 'basic',
  } as SapConfig;
  const transport = new OnPremHttpTransport(() => ({}), null, {
    client: '100',
    baseUrl: stub.baseUrl,
  });
  const conn = new AdtOnPremConnector(config, provider, transport, null);
  await conn.connect();
  return { conn, transport };
}

const get = (conn: AdtOnPremConnector) =>
  conn.makeAdtRequest({ url: WORK, method: 'GET', timeout: 5000 });

const post = (conn: AdtOnPremConnector) =>
  conn.makeAdtRequest({
    url: WORK,
    method: 'POST',
    timeout: 5000,
    data: '<x/>',
  });

/** The last request to WORK: the resend. */
function lastSent() {
  const sent = stub.sentTo(WORK);
  if (sent.length === 0) throw new Error(`nothing was sent to ${WORK}`);
  return sent[sent.length - 1];
}

/** The cookie pairs a request carried, by name. */
function cookiesOf(headers: Record<string, string>): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const pair of (headers.cookie ?? '').split(/;\s*/)) {
    if (!pair) continue;
    const name = pair.slice(0, pair.indexOf('='));
    byName.set(name, [
      ...(byName.get(name) ?? []),
      pair.slice(name.length + 1),
    ]);
  }
  return byName;
}

describe('after rejected() → Ok', () => {
  it('a provider that switches from a header to cookies: the resend carries the cookie and no Authorization', async () => {
    const { conn } = await connected(
      providerWriting((request, renewals) => {
        if (renewals === 0) request.header('Authorization', 'Bearer old');
        else request.cookies('MYSSO=new');
      }),
    );
    stub.work(WORK, [401, 401]);

    const response = await get(conn);

    expect(response.status).toBe(200);
    const resend = lastSent();
    expect(resend.headers.authorization).toBeUndefined();
    expect(cookiesOf(resend.headers).get('MYSSO')).toEqual(['new']);
    expect(cookiesOf(resend.headers).get(SESSION)).toEqual(['S1']);
    expect(resend.headers['sap-client']).toBe('100');
  });

  it('a provider whose cookie changes value: only the new value is sent', async () => {
    const { conn } = await connected(
      providerWriting((request, renewals) => {
        request.cookies(`MYSSO=v${renewals}`);
      }),
    );
    stub.work(WORK, [401, 401]);

    await get(conn);

    const resend = lastSent();
    expect(cookiesOf(resend.headers).get('MYSSO')).toEqual(['v1']);
    expect(cookiesOf(resend.headers).get(SESSION)).toEqual(['S1']);
  });

  it('a provider whose cookie is renamed: the old one is not sent', async () => {
    const { conn } = await connected(
      providerWriting((request, renewals) => {
        request.cookies(renewals === 0 ? 'SSO_OLD=1' : 'SSO_NEW=2');
      }),
    );
    stub.work(WORK, [401, 401]);

    await get(conn);

    const resend = lastSent();
    const cookies = cookiesOf(resend.headers);
    expect(cookies.get('SSO_NEW')).toEqual(['2']);
    expect(cookies.has('SSO_OLD')).toBe(false);
    expect(cookies.get(SESSION)).toEqual(['S1']);
    expect(resend.headers['sap-client']).toBe('100');
  });

  it('the one more attempt after a refused logon carries the new token, the jar, and only the new credential', async () => {
    const { conn, transport } = await connected(
      providerWriting((request, renewals) => {
        if (renewals === 0) request.header('Authorization', 'Bearer old');
        else request.cookies('MYSSO=new');
      }),
    );
    transport.adoptCsrfToken('STALE');
    // Path (a)'s token fetch is refused: a refused logon, answered Ok.
    stub.discovery.push(401);

    const response = await post(conn);

    expect(response.status).toBe(200);
    const resend = lastSent();
    expect(resend.headers['x-csrf-token']).toBe(stub.tokens.at(-1));
    expect(resend.headers.authorization).toBeUndefined();
    expect(cookiesOf(resend.headers).get('MYSSO')).toEqual(['new']);
    expect(cookiesOf(resend.headers).get(SESSION)).toBeDefined();
    expect(resend.headers['sap-client']).toBe('100');
  });
});

describe("the wire's own recovery", () => {
  it('path (a): the CSRF resend carries only the credential written for it', async () => {
    // A header while the wire holds its first token, cookies once it holds a
    // new one — which is when the resend is authorized.
    const { conn, transport } = await connected(
      providerWriting((request) => {
        if (stub.tokens.length < 2)
          request.header('Authorization', 'Bearer old');
        else request.cookies('MYSSO=new');
      }),
    );
    transport.adoptCsrfToken('STALE');

    const response = await post(conn);

    expect(response.status).toBe(200);
    const [first, resend] = stub.sentTo(WORK);
    expect(first.headers.authorization).toBe('Bearer old');
    expect(resend.headers.authorization).toBeUndefined();
    expect(resend.headers['x-csrf-token']).toBe(stub.tokens.at(-1));
    expect(cookiesOf(resend.headers).get('MYSSO')).toEqual(['new']);
    expect(cookiesOf(resend.headers).get(SESSION)).toBeDefined();
    expect(resend.headers['sap-client']).toBe('100');
  });

  it('path (b), cookies at hand: the GET resend carries only the credential written for it', async () => {
    const { conn } = await connected(
      providerWriting((request) => {
        if (stub.sentTo(WORK).length === 0)
          request.header('Authorization', 'Bearer old');
        else request.cookies('MYSSO=new');
      }),
    );
    stub.work(WORK, [401]);

    const response = await get(conn);

    expect(response.status).toBe(200);
    const [first, resend] = stub.sentTo(WORK);
    expect(first.headers.authorization).toBe('Bearer old');
    expect(resend.headers.authorization).toBeUndefined();
    expect(cookiesOf(resend.headers).get('MYSSO')).toEqual(['new']);
    expect(cookiesOf(resend.headers).get(SESSION)).toEqual(['S1']);
    expect(resend.headers['sap-client']).toBe('100');
  });

  it('path (b), cookies fetched: the GET resend carries only the credential written for it', async () => {
    const { conn } = await connected(
      providerWriting((request) => {
        if (stub.sentTo(WORK).length === 0)
          request.header('Authorization', 'Bearer old');
        else request.cookies('MYSSO=new');
      }),
    );
    // A wire that holds nothing: path (b) fetches a token to get cookies.
    (conn as unknown as { invalidateSession(): void }).invalidateSession();
    stub.work(WORK, [401]);

    const response = await get(conn);

    expect(response.status).toBe(200);
    const [first, resend] = stub.sentTo(WORK);
    expect(first.headers.authorization).toBe('Bearer old');
    expect(resend.headers.authorization).toBeUndefined();
    expect(cookiesOf(resend.headers).get('MYSSO')).toEqual(['new']);
    expect(cookiesOf(resend.headers).get(SESSION)).toBeDefined();
    expect(resend.headers['sap-client']).toBe('100');
  });
});

describe('what outranks the credential', () => {
  it("a provider writing the CSRF token and content type cannot replace the wire's or the request's", async () => {
    const { conn } = await connected(
      providerWriting((request, renewals) => {
        // Spelled unlike the request's own, which HTTP does not tell apart.
        request.header('X-CSRF-Token', 'EVIL');
        request.header('content-type', 'text/evil');
        request.header('Authorization', `Bearer ${renewals}`);
      }),
    );
    // The first attempt, path (a)'s resend, and the one more attempt after
    // rejected() → Ok.
    stub.work(WORK, [401, 401]);

    const response = await post(conn);

    expect(response.status).toBe(200);
    const sent = stub.sentTo(WORK);
    expect(sent.map((request) => request.status)).toEqual([401, 401, 200]);
    for (const request of sent) {
      expect(request.headers['x-csrf-token']).toMatch(/^TOKEN-\d+$/);
      expect(request.headers['content-type']).toBe('text/plain; charset=utf-8');
    }
    expect(sent[2].headers['x-csrf-token']).toBe(stub.tokens.at(-1));
    expect(sent[2].headers.authorization).toBe('Bearer 1');
  });
});
