/**
 * The CSRF recovery's predicate in its own module decides exactly as it did
 * inside the connection: the wire's token is read lazily, at the original
 * short-circuit point — after the refusal is serialised, and only for a
 * `POST`, `PUT` or `DELETE`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SapConfig } from '../config/sapConfig.js';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import { shouldRetryCsrf } from '../connection/csrfRetry.js';
import type { IOnPremTransport } from '../connection/IAdtTransport.js';
import { stubProvider } from './helpers/stubProvider.js';
import { holdsNoSession } from './helpers/transportStub.js';

const config: SapConfig = {
  url: 'https://sap.example.com',
  authType: 'basic',
  username: 'u',
  password: 'p',
  client: '100',
};

/** A refusal whose body runs `onSerialise` each time it is serialised. */
function refusal(status: number, onSerialise: () => void): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: {
      status,
      headers: {},
      data: {
        toJSON() {
          onSerialise();
          return { serialised: true };
        },
      },
    },
  });
}

describe('the CSRF predicate reads the token where it always did', () => {
  it('a 401 PUT whose serialisation sets the token: no CSRF resend, as on origin/master', async () => {
    let token: string | null = null;
    let serialised = 0;
    const sends: string[] = [];
    const adopted: (string | null)[] = [];
    let established = 0;
    const transport: IOnPremTransport = {
      kind: 'stub',
      system: 'onprem',
      ...holdsNoSession,
      // A session is open: the request is a request, not a refused connect.
      sessionEstablished: () => true,
      csrfToken: () => token,
      adoptCsrfToken: (value) => {
        adopted.push(value);
        token = value;
      },
      establish: async () => {
        established += 1;
      },
      send: async (request) => {
        sends.push(request.method);
        // The connection serialises the refusal for its log preview first,
        // and the predicate second: the token arrives with the second.
        throw refusal(401, () => {
          serialised += 1;
          if (serialised === 2) token = 'SET';
        });
      },
    };
    const provider = stubProvider();
    const connection = new AdtOnPremConnector(
      config,
      provider,
      transport,
      null,
    );
    await connection.connect();
    await assert.rejects(
      connection.makeAdtRequest({
        url: '/sap/bc/adt/oo/classes/zcl_x/source/main',
        method: 'PUT',
        timeout: 1000,
        data: 'source',
      }),
    );
    // origin/master, measured: the predicate saw the token set, so the CSRF
    // recovery did not run — no token dropped, no extra establish — and the
    // 401 went to the provider, which renewed; the request went once more.
    assert.deepStrictEqual(
      { sends, renewals: provider.renewals(), adopted, established, token },
      {
        sends: ['PUT', 'PUT'],
        renewals: 1,
        adopted: [],
        established: 2,
        token: 'SET',
      },
    );
    await connection.disconnect();
  });

  it('a GET: the token is never read', () => {
    let read = 0;
    const decided = shouldRetryCsrf(
      refusal(401, () => {}),
      'GET',
      () => {
        read += 1;
        return null;
      },
    );
    assert.strictEqual(decided, false);
    assert.strictEqual(read, 0);
  });

  it('a 401 POST: the token is read after the refusal is serialised', () => {
    const order: string[] = [];
    const decided = shouldRetryCsrf(
      refusal(401, () => order.push('serialised')),
      'POST',
      () => {
        order.push('token read');
        return null;
      },
    );
    assert.strictEqual(decided, true);
    assert.deepStrictEqual(order, ['serialised', 'token read']);
  });
});
