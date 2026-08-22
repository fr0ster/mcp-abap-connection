/**
 * How many choices each connector leaves open.
 *
 * On-prem has two: the credential it authenticates with, and the transport it
 * travels over — HTTP, or RFC on a system where stateful HTTP sessions are not
 * usable. ABAP Cloud has one. There is no cloud RFC, so a cloud connector that
 * accepted a transport would be offering a choice that does not exist, and the
 * first person to take it would find out at runtime.
 *
 * Both are said by the caller. Nothing here is worked out from the credential,
 * the host name, or by asking the server.
 */

import type { IAuthProvider } from '@mcp-abap-adt/interfaces';
import { BasicAuthProvider, TokenAuthProvider } from '../auth/providers.js';
import type { SapConfig } from '../config/sapConfig.js';
import { AdtCloudConnector } from '../connection/AdtCloudConnector.js';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import type { IOnPremTransport } from '../connection/IAdtTransport.js';
import { cloudHttpTransport, onPremHttpTransport } from './helpers/onPrem.js';
import { holdsNoSession } from './helpers/transportStub.js';

const config: SapConfig = {
  url: 'https://sap.example.com',
  authType: 'basic',
  username: 'u',
  password: 'p',
  client: '100',
};

const transport: IOnPremTransport = {
  kind: 'stub',
  system: 'onprem' as const,
  ...holdsNoSession,
  send: async () => ({ status: 200, headers: {}, data: '' }),
};

const credential: IAuthProvider = new BasicAuthProvider('u', 'p');

describe('the on-prem connector', () => {
  it('takes a transport, because on-prem is where that is a real choice', () => {
    const conn = new AdtOnPremConnector(config, credential, transport, null);

    expect(conn).toBeInstanceOf(AdtOnPremConnector);
  });

  it('travels over HTTP when the caller names no transport', () => {
    const conn = new AdtOnPremConnector(
      config,
      credential,
      onPremHttpTransport(config, null),
      null,
    );

    // Not an inference: the connector's documented default, which a caller
    // overrides by naming one. Nothing is decided by looking at the config.
    expect((conn as any).adtTransport).toBeUndefined();
  });
});

describe('the cloud connector', () => {
  it('takes a credential', () => {
    const conn = new AdtCloudConnector(
      config,
      new TokenAuthProvider('t'),
      cloudHttpTransport(config, null),
      null,
    );

    expect(conn).toBeInstanceOf(AdtCloudConnector);
  });

  it('refuses an on-prem wire, and the compiler says so', () => {
    // The axis moved: a transport is no longer an option the cloud connector
    // happens not to offer, it is a required argument constrained to the
    // system. So the claim is now about which wire, not about whether one may
    // be given at all.
    //
    // @ts-expect-error there is no ABAP Cloud over an on-prem wire, and the
    // marker on each transport is what says so.
    new AdtCloudConnector(config, credential, transport, null);
  });
});
