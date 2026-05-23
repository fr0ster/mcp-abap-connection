jest.mock('../../auth/kerberosSpnego', () => ({
  generateSpnegoToken: jest.fn(async (_spn: string) => 'NEG_TOKEN'),
}));

import { generateSpnegoToken } from '../../auth/kerberosSpnego.js';
import { KerberosAbapConnection } from '../../connection/KerberosAbapConnection.js';

const cfg = {
  url: 'https://h:44300',
  authType: 'kerberos',
  client: '100',
  kerberosSpn: 'HTTP@h.corp',
} as any;

test('emits Authorization: Negotiate <token> before a cookie exists', async () => {
  const c = new KerberosAbapConnection(cfg, null, undefined);
  await (c as any).ensureToken();
  expect((c as any).buildAuthorizationHeader()).toBe('Negotiate NEG_TOKEN');
});

test('derives SPN from url when kerberosSpn absent', async () => {
  (generateSpnegoToken as jest.Mock).mockClear();
  const c = new KerberosAbapConnection(
    { ...cfg, kerberosSpn: undefined },
    null,
    undefined,
  );
  await (c as any).ensureToken();
  expect(generateSpnegoToken as jest.Mock).toHaveBeenCalledWith('HTTP@h');
});

test('rejects connectionType rfc', () => {
  expect(
    () =>
      new KerberosAbapConnection(
        { ...cfg, connectionType: 'rfc' },
        null,
        undefined,
      ),
  ).toThrow(/rfc/i);
});

test('buildAuthorizationHeader throws before connect/ensureToken (no silent unauthenticated request)', () => {
  const c = new KerberosAbapConnection(cfg, null, undefined);
  expect(() => (c as any).buildAuthorizationHeader()).toThrow(
    /not yet available|connect\(\)/i,
  );
});

test('returns empty auth header once a session cookie exists', async () => {
  const c = new KerberosAbapConnection(cfg, null, undefined);
  await (c as any).ensureToken();
  (c as any).setInitialCookies('SAP_SESSIONID=abc');
  expect((c as any).buildAuthorizationHeader()).toBe('');
});
