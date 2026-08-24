/**
 * The axes, in the type.
 *
 * The objects still arrive through the constructor — that is the runtime, and
 * nothing about it changes. What the type parameters add is that the connection
 * REMEMBERS what it was built with, so a consumer can require a particular
 * combination in a signature instead of casting at the call site and hoping.
 *
 * On-prem has two parameters because it has two choices. Cloud has one, because
 * there is no cloud RFC.
 */

import type { IAuthProvider } from '@mcp-abap-adt/interfaces';
import {
  BasicAuthProvider,
  CertificateAuthProvider,
  TokenAuthProvider,
} from '../auth/providers.js';
import type { SapConfig } from '../config/sapConfig.js';
import { AdtCloudConnector } from '../connection/AdtCloudConnector.js';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import { OnPremHttpTransport } from '../connection/OnPremHttpTransport.js';
import { RfcTransport } from '../connection/RfcTransport.js';
import { cloudHttpTransport, onPremHttpTransport } from './helpers/onPrem.js';

const config: SapConfig = {
  url: 'https://sap.example.com',
  authType: 'basic',
  username: 'u',
  password: 'p',
  client: '100',
};

const rfc = new RfcTransport(
  () =>
    ({
      alive: true,
      open: async () => {},
      close: async () => {},
      call: async () => ({}),
    }) as never,
);

/** What a consumer can now write: a signature that demands one combination. */
function needsRfc(
  _conn: AdtOnPremConnector<IAuthProvider, RfcTransport>,
): void {}
function needsHttp(
  _conn: AdtOnPremConnector<IAuthProvider, OnPremHttpTransport>,
): void {}

describe('on-prem carries both axes in its type', () => {
  it('remembers the transport it was given', () => {
    const conn = new AdtOnPremConnector(
      config,
      new BasicAuthProvider('u', 'p'),
      rfc,
      null,
      undefined,
    );

    // Inferred, not asserted: no cast at this call site.
    needsRfc(conn);
    expect(conn.transport).toBe(rfc);
  });

  it('defaults to HTTP in the type as well as at runtime', () => {
    const conn = new AdtOnPremConnector(
      config,
      new BasicAuthProvider('u', 'p'),
      onPremHttpTransport(config, null),
    );

    needsHttp(conn);
    expect(conn.transport).toBeInstanceOf(OnPremHttpTransport);
  });

  it('refuses the wrong combination at compile time', () => {
    const overHttp = new AdtOnPremConnector(
      config,
      new BasicAuthProvider('u', 'p'),
      onPremHttpTransport(config, null),
    );

    // @ts-expect-error an HTTP connection is not an RFC one, and a signature
    // that needs RFC now says so instead of failing on a cast.
    needsRfc(overHttp);
  });

  it('remembers the credential it was given', () => {
    const credential = new CertificateAuthProvider(
      { load: async () => ({ cert: 'C' }) },
      config,
    );
    const conn = new AdtOnPremConnector(
      config,
      credential,
      onPremHttpTransport(config, null),
    );

    // Typed as CertificateAuthProvider, so its own members are reachable
    // without narrowing.
    expect(typeof conn.credential.transportMaterial).toBe('function');
  });
});

describe('cloud carries one', () => {
  it('remembers the credential', () => {
    const credential = new TokenAuthProvider('t');
    const conn = new AdtCloudConnector(
      config,
      credential,
      cloudHttpTransport(config, null),
      null,
    );

    expect(conn.credential).toBe(credential);
  });
});
