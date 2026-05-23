import type { ICertificateMaterialLoader } from '@mcp-abap-adt/interfaces';
import { CertificateAbapConnection } from '../../connection/CertificateAbapConnection.js';

const fakeLoader: ICertificateMaterialLoader = {
  load: async () => ({ cert: 'C', key: 'K', passphrase: 'pw' }),
};
const cfg = {
  url: 'https://h:44300',
  authType: 'certificate',
  client: '100',
  certPath: '/x.crt',
  certKeyPath: '/x.key',
} as any;

test('no Authorization header (mTLS identifies user)', () => {
  const c = new CertificateAbapConnection(cfg, null, undefined, fakeLoader);
  expect((c as any).buildAuthorizationHeader()).toBe('');
});
test('loaded material reaches getHttpsAgentOptions', async () => {
  const c = new CertificateAbapConnection(cfg, null, undefined, fakeLoader);
  await (c as any).ensureMaterial();
  const opts = (c as any).getHttpsAgentOptions();
  expect(opts.cert).toBe('C');
  expect(opts.key).toBe('K');
});
test('rejects connectionType rfc', () => {
  expect(
    () =>
      new CertificateAbapConnection(
        { ...cfg, connectionType: 'rfc' },
        null,
        undefined,
        fakeLoader,
      ),
  ).toThrow(/rfc/i);
});
test('getHttpsAgentOptions throws if material not loaded (no silent no-cert TLS)', () => {
  const c = new CertificateAbapConnection(cfg, null, undefined, fakeLoader);
  expect(() => (c as any).getHttpsAgentOptions()).toThrow(
    /not loaded|connect\(\)/i,
  );
});
