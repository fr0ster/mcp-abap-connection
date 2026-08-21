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
import type { IAuthProvider } from '@mcp-abap-adt/interfaces';
import type { SapConfig } from '../config/sapConfig.js';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';

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
  const credential: IAuthProvider = {
    kind: 'test-spnego',
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
    const conn = new AdtOnPremConnector(config, credential, null);

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
    const conn = new AdtOnPremConnector(config, credential, null);

    await (conn as any).establishSession();

    expect((given[0] as { baseUrl: string }).baseUrl).toBe(
      'https://sap.example.com',
    );
  });

  it('has its token taken as the connection csrf token', async () => {
    const { credential } = credentialOwningTheFetch();
    const conn = new AdtOnPremConnector(config, credential, null);

    await (conn as any).establishSession();

    expect((conn as any).getCsrfToken()).toBe('CSRF-FROM-CREDENTIAL');
  });
});

describe('a credential that does not', () => {
  it('leaves the fetch to the connection, as before', async () => {
    const credential: IAuthProvider = {
      kind: 'test-basic',
      authorizationHeader: async () => 'Basic dTpw',
    };
    const conn = new AdtOnPremConnector(config, credential, null);
    const own = jest
      .spyOn(conn as any, 'fetchCsrfToken')
      .mockResolvedValue('CSRF-FROM-CONNECTION');

    await (conn as any).establishSession();

    expect(own).toHaveBeenCalledTimes(1);
    expect((conn as any).getCsrfToken()).toBe('CSRF-FROM-CONNECTION');
  });
});
