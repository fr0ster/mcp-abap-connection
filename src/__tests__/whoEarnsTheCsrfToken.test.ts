/**
 * Who earns the CSRF token: the wire, always.
 *
 * There was a second path here — a credential could run the exchange itself,
 * and the connection asked which of the two would do the work. It asked for
 * nobody: no shipped credential implemented it, and the seam had been built
 * twice, once as a transport-shaped parameter and once as a capability atom.
 *
 * A credential whose way in IS a round trip does not need the connection to
 * arbitrate. The wire authorizes PER ATTEMPT, so a one-shot token is
 * offered on the establishing call and withheld afterwards by the credential
 * itself, with nobody deciding anything.
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import type { IAuthProvider } from '@mcp-abap-adt/interfaces-auth';
import type { SapConfig } from '../config/sapConfig.js';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import { credentialWriting } from './helpers/credentials.js';
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
    const credential: IAuthProvider = credentialWriting({
      kind: 'test-basic',
      authorization: 'Basic dTpw',
    });
    const conn = new AdtOnPremConnector(
      config,
      credential,
      onPremHttpTransport(config, null),
      null,
    );
    const wire = mock.method((conn as any).transport, 'establish', async () => {
      (conn as any).transport.adoptCsrfToken('CSRF-FROM-THE-WIRE');
    });

    await (conn as any).establishSession();

    assert.strictEqual(wire.mock.callCount(), 1);
    assert.strictEqual((conn as any).getCsrfToken(), 'CSRF-FROM-THE-WIRE');
  });

  it('hands the wire the server, the credential, and somewhere to report', async () => {
    const credential: IAuthProvider = credentialWriting({
      kind: 'test-basic',
      authorization: 'Basic dTpw',
    });
    const conn = new AdtOnPremConnector(
      config,
      credential,
      onPremHttpTransport(config, null),
      null,
    );
    const wire = mock.method(
      (conn as any).transport,
      'establish',
      async (..._args: any[]) => undefined,
    );

    await (conn as any).establishSession();

    const context = wire.mock.calls[0].arguments[0] as {
      baseUrl: string;
      authorize: (headers: Record<string, string>) => Promise<void>;
      observe: unknown;
    };
    assert.strictEqual(context.baseUrl, config.url);
    const headers: Record<string, string> = {};
    await context.authorize(headers);
    assert.strictEqual(headers.Authorization, 'Basic dTpw');
    assert.strictEqual(typeof context.observe, 'function');
  });
});
