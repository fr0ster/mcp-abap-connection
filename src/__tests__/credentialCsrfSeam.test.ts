/**
 * What a credential is given when it fetches the CSRF token itself.
 *
 * `IAuthProvider.fetchCsrfToken` was cut for SPNEGO — "its token is consumed by
 * one request and the exchange IS the fetch" — and the call site in
 * CredentialAbapConnection has been wired all along. No provider ever
 * implemented it, so the seam was never used, and it was handed a URL string:
 * everything a credential needs to actually make that request, and everything
 * the request produces, was on the other side of it.
 *
 * A URL cannot carry the exchange. The SPNEGO round trip is what the server
 * answers with the session cookie, and a credential returning only a token
 * string has nowhere to put that cookie — after which every later request goes
 * out with an already-spent Negotiate token.
 *
 * So the seam passes a transport, the shape `src/session/` already uses for the
 * same reason.
 */

import type {
  IAuthProvider,
  ICredentialOwningItsFetch,
} from '@mcp-abap-adt/interfaces';
import type { SapConfig } from '../config/sapConfig.js';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import { onPremHttpTransport } from './helpers/onPrem.js';

const config: SapConfig = {
  url: 'https://sap.example.com',
  authType: 'basic',
  username: 'u',
  password: 'p',
  client: '100',
};

/** A credential that fetches the token its own way, and records what it got. */
function credentialOwningTheFetch() {
  const given: unknown[] = [];
  // The atom, because it earns the token itself — which is the one thing about
  // a credential the connection still asks, and it asks by narrowing.
  const credential: ICredentialOwningItsFetch = {
    kind: 'test-spnego',
    // Empty where there is nothing to say: since interfaces 20.0.0 a credential
    // states all of itself, so nothing has to ask whether it does.
    prepare: async () => {},
    cookies: () => null,
    transportMaterial: () => ({}),
    authorizationHeader: async () => 'Negotiate AAAA',
    fetchCsrfToken: async (transport: unknown) => {
      given.push(transport);
      return 'CSRF-FROM-CREDENTIAL';
    },
  };
  return { credential, given };
}

describe('a credential that owns its CSRF fetch', () => {
  it('is handed a transport it can send with, not a URL to look at', async () => {
    const { credential, given } = credentialOwningTheFetch();
    const conn = new AdtOnPremConnector(
      config,
      credential,
      onPremHttpTransport(config, null),
      null,
    );

    await (conn as any).establishSession();

    expect(given).toHaveLength(1);
    expect(typeof given[0]).not.toBe('string');
    expect(given[0]).toEqual(
      expect.objectContaining({
        baseUrl: expect.any(String),
        send: expect.any(Function),
      }),
    );
  });

  it('is told where the system is, so it need not parse a URL back apart', async () => {
    const { credential, given } = credentialOwningTheFetch();
    const conn = new AdtOnPremConnector(
      config,
      credential,
      onPremHttpTransport(config, null),
      null,
    );

    await (conn as any).establishSession();

    expect((given[0] as { baseUrl: string }).baseUrl).toBe(
      'https://sap.example.com',
    );
  });

  it('has its token taken as the connection csrf token', async () => {
    const { credential } = credentialOwningTheFetch();
    const conn = new AdtOnPremConnector(
      config,
      credential,
      onPremHttpTransport(config, null),
      null,
    );

    await (conn as any).establishSession();

    expect((conn as any).getCsrfToken()).toBe('CSRF-FROM-CREDENTIAL');
  });
});

describe('a credential that does not', () => {
  // Left to the WIRE, which is the change: the exchange is HTTP's — an endpoint
  // to ask and a token to earn — and the RFC wire has neither. Asked of the
  // connection, it was one implementation for both, and the RFC one could not
  // succeed.
  it('leaves the exchange to the wire it travels over', async () => {
    const credential: IAuthProvider = {
      kind: 'test-basic',
      // Empty where there is nothing to say: since interfaces 20.0.0 a credential
      // states all of itself, so nothing has to ask whether it does.
      prepare: async () => {},
      cookies: () => null,
      transportMaterial: () => ({}),
      authorizationHeader: async () => 'Basic dTpw',
    };
    const conn = new AdtOnPremConnector(
      config,
      credential,
      onPremHttpTransport(config, null),
      null,
    );
    const wire = jest
      .spyOn((conn as any).transport, 'establish')
      .mockImplementation(async () => {
        (conn as any).transport.adoptCsrfToken('CSRF-FROM-THE-WIRE');
      });

    await (conn as any).establishSession();

    expect(wire).toHaveBeenCalledTimes(1);
    expect((conn as any).getCsrfToken()).toBe('CSRF-FROM-THE-WIRE');
  });

  it('hands the wire the server, the credential, and somewhere to report', async () => {
    const credential: IAuthProvider = {
      kind: 'test-basic',
      // Empty where there is nothing to say: since interfaces 20.0.0 a credential
      // states all of itself, so nothing has to ask whether it does.
      prepare: async () => {},
      cookies: () => null,
      transportMaterial: () => ({}),
      authorizationHeader: async () => 'Basic dTpw',
    };
    const conn = new AdtOnPremConnector(
      config,
      credential,
      onPremHttpTransport(config, null),
      null,
    );
    const wire = jest
      .spyOn((conn as any).transport, 'establish')
      .mockResolvedValue(undefined);

    await (conn as any).establishSession();

    const context = wire.mock.calls[0][0] as {
      baseUrl: string;
      authHeaders: () => Promise<Record<string, string>>;
      observe: unknown;
    };
    expect(context.baseUrl).toBe(config.url);
    expect((await context.authHeaders()).Authorization).toBe('Basic dTpw');
    expect(typeof context.observe).toBe('function');
  });
});
