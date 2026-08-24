/**
 * Who earns the CSRF token: the wire, always.
 *
 * There was a second path here — a credential could run the exchange itself,
 * and the connection asked which of the two would do the work. It asked for
 * nobody: no shipped credential implemented it, and the seam had been built
 * twice, once as a transport-shaped parameter and once as a capability atom.
 *
 * A credential whose way in IS a round trip does not need the connection to
 * arbitrate. The wire asks `authHeaders()` PER ATTEMPT, so a one-shot token is
 * offered on the establishing call and withheld afterwards by the credential
 * itself, with nobody deciding anything.
 */

import type { IAuthProvider } from '@mcp-abap-adt/interfaces';
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

describe('a credential that owns its CSRF fetch', () => {});

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
