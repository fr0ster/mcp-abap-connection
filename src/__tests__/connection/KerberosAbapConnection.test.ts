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

test('connect() treats a real Kerberos Negotiate 401 as the handshake, not a failure', async () => {
  const c = new KerberosAbapConnection(cfg, null, undefined);
  // A legitimate Kerberos 401 (SAP asking for SPNEGO) is the FIRST LEG: this
  // class is single-leg, so the session cookie arrives with the first real
  // request. Rejecting here would make connect() fail on every correctly
  // configured Kerberos system.
  jest
    .spyOn(c as any, 'fetchCsrfToken')
    .mockRejectedValue(makeNtlmAxiosError('Negotiate YIIBexyz=='));

  await expect(c.connect()).resolves.toBeUndefined();
  // Usable, because the credential is ready — but with no session cookie yet,
  // which is the same state as a server that issues none at all.
  expect(c.isConnected()).toBe(true);
  expect(c.getSessionIdentity()).toBeNull();
});

test('connect() still rejects when the 401 is not a Negotiate challenge', async () => {
  const c = new KerberosAbapConnection(cfg, null, undefined);
  // No WWW-Authenticate at all: nothing says a handshake is in progress, so
  // this is an ordinary failure and must not be waved through.
  const error = Object.assign(new AxiosError('unauthorized'), {
    response: {
      status: 401,
      headers: {},
      data: '',
      statusText: 'Unauthorized',
    },
  });
  jest.spyOn(c as any, 'fetchCsrfToken').mockRejectedValue(error);

  await expect(c.connect()).rejects.toThrow();
  expect(c.isConnected()).toBe(false);
});
