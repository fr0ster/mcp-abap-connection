/**
 * The shipped credentials against the contract as published, not as it was
 * kept here.
 *
 * `IAuthProvider` moved to @mcp-abap-adt/interfaces, where a consumer writing
 * its own credential can reach it. Two members changed shape on the way:
 *
 *   - `authorizationHeader()` answers `string | null`. `''` was a sentinel for
 *     "this credential is not a header", which a certificate genuinely is not —
 *     and `''` is also a legal header value, so one type carried two meanings.
 *   - TLS material is `transportMaterial(): ICertificateMaterial` rather than
 *     `httpsAgentOptions(): AgentOptions`. The contract package has no `node:`
 *     imports and cannot name Node's type; the material is what a client needs
 *     and what the loader already produces.
 */
import type {
  IAuthProvider,
  ICertificateMaterial,
  ICertificateMaterialLoader,
} from '@mcp-abap-adt/interfaces';
import {
  BasicAuthProvider,
  CertificateAuthProvider,
  SamlAuthProvider,
  TokenAuthProvider,
} from '../auth/providers.js';
import type { SapConfig } from '../config/sapConfig.js';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';

const config: SapConfig = {
  url: 'https://sap.example.com',
  authType: 'certificate',
  client: '100',
};

const material: ICertificateMaterial = { cert: 'CERT', key: 'KEY' };
const loader: ICertificateMaterialLoader = { load: async () => material };

describe('a credential that is not a header', () => {
  it('says so with null, which is not a legal header value', async () => {
    const credential = new CertificateAuthProvider(loader, config);
    await credential.prepare();

    expect(await credential.authorizationHeader()).toBeNull();
  });

  it('offers its TLS material as material, not as agent options', async () => {
    const credential = new CertificateAuthProvider(loader, config);
    await credential.prepare();

    expect(credential.transportMaterial()).toEqual(material);
  });

  it('is what the connection builds its https agent from', async () => {
    const credential = new CertificateAuthProvider(loader, config);
    await credential.prepare();
    const conn = new AdtOnPremConnector(config, credential, null);

    expect((conn as any).getHttpsAgentOptions()).toEqual(
      expect.objectContaining(material),
    );
  });
});

describe('the credentials that are headers', () => {
  it.each([
    ['basic', new BasicAuthProvider('u', 'p'), 'Basic '],
    ['token', new TokenAuthProvider('t'), 'Bearer '],
  ])('%s answers a header', async (_name, credential, prefix) => {
    expect(await credential.authorizationHeader()).toContain(prefix);
  });

  it('saml carries a session rather than a header', async () => {
    const credential = new SamlAuthProvider('MYSAPSSO2=x');

    expect(await credential.authorizationHeader()).toBeNull();
    expect(credential.cookies?.()).toBe('MYSAPSSO2=x');
  });
});

describe('the contract itself', () => {
  it('is the published one, so a consumer implements the same thing', () => {
    // The assignment IS the assertion: it stops compiling if these classes
    // drift from what @mcp-abap-adt/interfaces publishes, which is exactly the
    // drift that having two copies of the interface used to allow.
    const shipped: IAuthProvider[] = [
      new BasicAuthProvider('u', 'p'),
      new TokenAuthProvider('t'),
      new SamlAuthProvider('c=1'),
      new CertificateAuthProvider(loader, config),
    ];

    expect(shipped.map((c) => c.kind)).toEqual([
      'basic',
      'token',
      'saml',
      'certificate',
    ]);
  });
});
