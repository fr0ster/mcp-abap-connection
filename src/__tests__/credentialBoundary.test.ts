/**
 * Where the credential's lifetime stops being the connection's business.
 *
 * A token has two different events behind it, and only one of them was ever
 * this package's:
 *
 *   - **refresh** — the provider swaps an expired access token for a new one,
 *     on an expiry it can see. It happens inside `authorizationHeader()`, which
 *     is asked per request, so a token that expired between two requests is
 *     replaced without anyone deciding to replace it.
 *   - **re-obtain** — a whole new grant, when refreshing is no longer possible.
 *     That is a decision with a human or a secret behind it, and it belongs to
 *     whoever owns the credential.
 *
 * The connection did neither, but it used to ARRANGE the first: on a 401 it
 * called `renew()`, compared the header with the previous one, and rebuilt the
 * session if it had changed. That is the connection managing a lifetime it does
 * not own, and it is gone. A refusal surfaces.
 */
import type { IAuthProvider } from '@mcp-abap-adt/interfaces';
import type { SapConfig } from '../config/sapConfig.js';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import { OnPremHttpTransport } from '../connection/OnPremHttpTransport.js';

const config: SapConfig = {
  url: 'https://sap.example.com',
  authType: 'jwt',
  jwtToken: 'STALE',
  client: '100',
};

/** A provider that would renew if anyone asked it to. Nobody does. */
function refusedCredential() {
  const asked = { header: 0, renew: 0 };
  const credential: IAuthProvider = {
    kind: 'token',
    authorizationHeader: async () => {
      asked.header += 1;
      return 'Bearer STALE';
    },
    renew: async () => {
      asked.renew += 1;
    },
  };
  return { credential, asked };
}

/** A wire that connects, then refuses the work with 401. */
function wire() {
  const seen: string[] = [];
  return {
    seen,
    send: async (request: { url?: string }) => {
      const url = String(request.url ?? '');
      seen.push(url);
      if (url.includes('/work')) {
        const error = new Error('unauthorized') as Error & {
          response?: unknown;
        };
        error.response = { status: 401, headers: {}, data: '' };
        throw error;
      }
      return {
        status: 200,
        statusText: 'OK',
        data: '<service/>',
        headers: {
          'x-csrf-token': 'TOKEN',
          'set-cookie': ['SAP_SESSIONID_STUB_100=abc; path=/'],
        },
      };
    },
  };
}

function connected(credential: IAuthProvider) {
  const w = wire();
  const transport = new OnPremHttpTransport(() => ({}), null, {
    client: '100',
    baseUrl: config.url,
  });
  (transport as unknown as { send: unknown }).send = w.send;
  return {
    conn: new AdtOnPremConnector(config, credential, transport, null),
    w,
  };
}

describe('a credential the server refuses', () => {
  it('surfaces the refusal instead of renewing behind the caller', async () => {
    const { credential, asked } = refusedCredential();
    const { conn } = connected(credential);
    await conn.connect();

    await expect(
      conn.makeAdtRequest({ url: '/work', method: 'GET', timeout: 5000 }),
    ).rejects.toMatchObject({ response: { status: 401 } });

    // The one assertion that matters: nothing here decided to get a new
    // credential. Whether to is the caller's call, with what it knows.
    expect(asked.renew).toBe(0);
  });

  it('leaves the connection usable, because the session is not what failed', async () => {
    const { credential } = refusedCredential();
    const { conn } = connected(credential);
    await conn.connect();

    await conn
      .makeAdtRequest({ url: '/work', method: 'GET', timeout: 5000 })
      .catch(() => undefined);

    // A refused credential is not a lost session. Tearing the connection down
    // over it would throw away a session the server never complained about.
    expect(conn.isConnected()).toBe(true);
    expect(conn.getSessionIdentity()).not.toBeNull();
  });

  it('asks the credential per request, which is where a refresh happens', async () => {
    const { credential, asked } = refusedCredential();
    const { conn } = connected(credential);
    await conn.connect();
    const afterConnect = asked.header;

    await conn
      .makeAdtRequest({ url: '/work', method: 'GET', timeout: 5000 })
      .catch(() => undefined);

    // Asked again rather than replayed from a cached value — which is the whole
    // mechanism by which a provider renews without anyone arranging it.
    expect(asked.header).toBeGreaterThan(afterConnect);
  });
});
