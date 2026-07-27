jest.mock('../../auth/kerberosSpnego', () => ({
  generateSpnegoToken: jest.fn(async (_spn: string) => 'NEG_TOKEN'),
}));

import { AxiosError } from 'axios';
import { generateSpnegoToken } from '../../auth/kerberosSpnego.js';
import { KerberosAbapConnection } from '../../connection/KerberosAbapConnection.js';
import { markConnectedForTest } from '../helpers/session.js';

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

// ── NTLM-rejection guard ─────────────────────────────────────────────────────
// Seam: spy on the protected fetchCsrfToken inherited from AbstractAbapConnection.
// This exercises the connect() catch block directly and avoids any real HTTP call.
// We use (instance as any) to access the protected method; jest.spyOn patches it
// on the instance's prototype chain.

function makeNtlmAxiosError(wwwAuthenticate: string): AxiosError {
  return new AxiosError(
    'Request failed with status 401',
    '401',
    {} as any,
    null,
    {
      status: 401,
      statusText: 'Unauthorized',
      data: '',
      headers: { 'www-authenticate': wwwAuthenticate },
      config: {} as any,
    } as any,
  );
}

test('connect() rejects with NTLM error when server offers NTLM scheme', async () => {
  const c = new KerberosAbapConnection(cfg, null, undefined);
  jest
    .spyOn(c as any, 'fetchCsrfToken')
    .mockRejectedValue(makeNtlmAxiosError('NTLM'));

  await expect(c.connect()).rejects.toThrow(/NTLM/i);
});

test('connect() rejects with NTLM error when server offers Negotiate+NTLM', async () => {
  const c = new KerberosAbapConnection(cfg, null, undefined);
  jest
    .spyOn(c as any, 'fetchCsrfToken')
    .mockRejectedValue(makeNtlmAxiosError('Negotiate, NTLM'));

  await expect(c.connect()).rejects.toThrow(/NTLM/i);
});

test('connect() reports a real Kerberos Negotiate 401 as itself, not as NTLM', async () => {
  const c = new KerberosAbapConnection(cfg, null, undefined);
  // A legitimate Kerberos 401 (SAP asking for SPNEGO) must not be dressed up as
  // an NTLM rejection.
  jest
    .spyOn(c as any, 'fetchCsrfToken')
    .mockRejectedValue(makeNtlmAxiosError('Negotiate YIIBexyz=='));

  // It rejects, because connect() no longer resolves over a session it failed
  // to establish — this test asserted the opposite while the lazy path existed.
  // What must stay true is WHICH error comes out.
  await expect(c.connect()).rejects.toThrow(/401/);
  await expect(c.connect()).rejects.not.toThrow(/NTLM/i);
  expect(c.isConnected()).toBe(false);
});
