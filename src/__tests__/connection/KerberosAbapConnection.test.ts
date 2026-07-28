jest.mock('../../auth/kerberosSpnego', () => ({
  generateSpnegoToken: jest.fn(async (_spn: string) => 'NEG_TOKEN'),
}));

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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

test('connect() fails on a Negotiate continuation, and says why', async () => {
  const c = new KerberosAbapConnection(cfg, null, undefined);
  // RFC 4559: a 401 carrying a Negotiate token is the server continuing the
  // exchange. Continuing means feeding that token into the GSS context — and
  // generateSpnegoToken() discards the context after one step(''), so this
  // client cannot. Resolving here would claim a readiness that does not exist
  // and push the failure to the first real request, where it looks unrelated.
  jest
    .spyOn(c as any, 'fetchCsrfToken')
    .mockRejectedValue(makeNtlmAxiosError('Negotiate YIIBexyz=='));

  await expect(c.connect()).rejects.toThrow(/single-leg|continue/i);
  await expect(c.connect()).rejects.not.toThrow(/NTLM/i);
  expect(c.isConnected()).toBe(false);
});

test('connect() distinguishes a rejected token from a continuation', async () => {
  const c = new KerberosAbapConnection(cfg, null, undefined);
  // A BARE Negotiate, after our initial Authorization already went out: the
  // server declined it. Nothing came back to step with, so the advice must
  // point at the credentials, not at multi-leg support.
  jest
    .spyOn(c as any, 'fetchCsrfToken')
    .mockRejectedValue(makeNtlmAxiosError('Negotiate'));

  await expect(c.connect()).rejects.toThrow(/rejected the SPNEGO token/);
  await expect(c.connect()).rejects.not.toThrow(/multi-leg/);
  expect(c.isConnected()).toBe(false);
});

// ── the classifier must see the FIRST response ───────────────────────────────
// Every test above mocks fetchCsrfToken, which is the seam ABOVE the retry
// loop — so none of them can see what the loop does to the exchange. This one
// runs the real loop against a real socket.

interface AuthProbe {
  baseUrl: string;
  /** Authorization header of each request that reached the server, in order. */
  seen: Array<string | undefined>;
  close(): Promise<void>;
}

async function startAuthProbe(): Promise<AuthProbe> {
  const seen: Array<string | undefined> = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization);
    if (seen.length === 1) {
      // First exchange: the server continues, per RFC 4559, and sets a cookie.
      res.writeHead(401, {
        'www-authenticate': 'Negotiate YIIBc2VydmVy',
        'set-cookie': ['SAP_SESSIONID_STUB_100=S1; Path=/'],
      });
    } else {
      // Anything after: our token is spent and the cookie has silenced the
      // Authorization header, so the server just re-offers the scheme.
      res.writeHead(401, { 'www-authenticate': 'Negotiate' });
    }
    res.end('');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      ),
  };
}

test('connect() diagnoses the first challenge, and never replays the token', async () => {
  const probe = await startAuthProbe();
  try {
    const c = new KerberosAbapConnection(
      { ...cfg, url: probe.baseUrl },
      null,
      undefined,
    );

    await expect(c.connect()).rejects.toThrow(/single-leg|multi-leg/i);

    // A GSS token is one-shot. Retrying it is meaningless at best; here it is
    // actively misleading, because the 401 also set a cookie and
    // buildAuthorizationHeader() goes quiet once a cookie exists — so a retry
    // would carry NO Authorization at all, and the bare challenge that comes
    // back reads as "your credentials were declined". The diagnosis would name
    // the wrong cause, and point at kinit instead of at multi-leg support.
    expect(probe.seen).toEqual(['Negotiate NEG_TOKEN']);
    expect(c.isConnected()).toBe(false);
  } finally {
    await probe.close();
  }
});

test('a failed exchange does not leave the spent token behind', async () => {
  const probe = await startAuthProbe();
  try {
    (generateSpnegoToken as jest.Mock).mockClear();
    const c = new KerberosAbapConnection(
      { ...cfg, url: probe.baseUrl },
      null,
      undefined,
    );
    await expect(c.connect()).rejects.toThrow();
    await expect(c.connect()).rejects.toThrow();

    // Two connects, two freshly minted tokens: caching one across a failure
    // guarantees the second attempt fails exactly as the first did.
    expect((generateSpnegoToken as jest.Mock).mock.calls.length).toBe(2);
  } finally {
    await probe.close();
  }
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
