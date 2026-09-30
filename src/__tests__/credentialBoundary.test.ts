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
 * The connection does neither. It used to ARRANGE the first: on a 401 it
 * called `renew()`, compared the header with the previous one, and rebuilt the
 * session if it had changed — the connection managing a lifetime it does not
 * own. Now a 401 that survives the wire's own recovery is put to the provider
 * through `rejected()`, and the provider decides: Ok buys one more attempt,
 * and a refusal after that is the verdict, never a loop.
 */
import type { IAuthProvider } from '@mcp-abap-adt/interfaces-auth';
import type { SapConfig } from '../config/sapConfig.js';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import { OnPremHttpTransport } from '../connection/OnPremHttpTransport.js';
import { credentialWriting } from './helpers/credentials.js';

const config: SapConfig = {
  url: 'https://sap.example.com',
  authType: 'jwt',
  jwtToken: 'STALE',
  client: '100',
};

/** A provider that answers Ok to every rejection, as if it had renewed. */
function refusedCredential() {
  const asked = { header: 0, renew: 0 };
  // `rejected` is what asks a provider to renew; counted, so a test can see how
  // often it was asked. `authorize` counts the per-request reads.
  const credential: IAuthProvider = credentialWriting({
    kind: 'token',
    authorization: () => {
      asked.header += 1;
      return 'Bearer STALE';
    },
  });
  const rejected = credential.rejected.bind(credential);
  credential.rejected = async (rejection) => {
    asked.renew += 1;
    return rejected(rejection);
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
  it('asks the provider once, and a refusal after its Ok is the verdict', async () => {
    const { credential, asked } = refusedCredential();
    const { conn } = connected(credential);
    await conn.connect();

    await expect(
      conn.makeAdtRequest({ url: '/work', method: 'GET', timeout: 5000 }),
    ).rejects.toMatchObject({
      name: 'AuthRefusedError',
      refusal: {
        reason:
          'the credential was refused again after the provider renewed it',
      },
      cause: { response: { status: 401 } },
    });

    // The one assertion that matters: the provider was asked once, and not
    // again after the retry it bought was refused — asking again would invite
    // a second renewal, and a server that refuses everything would loop.
    expect(asked.renew).toBe(1);
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
