/**
 * A goodbye whose `close()` throws SYNCHRONOUSLY is absorbed exactly like one
 * that rejects — at every place the connection says goodbye.
 *
 * `close()` is typed as returning a promise, but a custom wire is free to write
 * it as a plain function, and a plain function throws before anything could
 * attach a `.catch` to what it returns. Left unguarded, that throw replaced the
 * establishment error the caller is owed and skipped the cleanup behind it, so
 * the failed attempt's cookies survived into the next one; in `disconnect()`
 * it made the one method that must never throw, throw.
 *
 * And the call itself stays synchronous. The wires read the cookie jar and the
 * affinity headers on their first line, because the teardown clears both right
 * after dispatching the goodbye: a close deferred to a later turn would go out
 * without the session it is ending — or not at all.
 */
import type { SapConfig } from '../../config/sapConfig.js';
import { AdtOnPremConnector } from '../../connection/AdtOnPremConnector.js';
import { OnPremHttpTransport } from '../../connection/OnPremHttpTransport.js';
import { credentialWriting } from '../helpers/credentials.js';
import { settled } from '../helpers/settled.js';

const config: SapConfig = {
  url: 'https://sap.example.com',
  authType: 'basic',
  username: 'u',
  password: 'p',
  client: '100',
};

const SESSION = 'SAP_SESSIONID_STUB_100=S1; path=/';
const NO_SESSION = 'sap-XSRF_STUB_100=X1; path=/';

/** A real on-prem wire over a recorded client that answers discovery with `cookie`. */
function onPremWire(cookie: string) {
  const sent: Array<{ url: string; cookie?: string }> = [];
  const transport = new OnPremHttpTransport(() => ({}), null, {
    client: config.client,
    baseUrl: config.url,
  });
  // Stubbed at the CLIENT, so the wire's own dressing of the logoff — the
  // cookie it snapshots — is what gets recorded.
  (transport as unknown as { instance: unknown }).instance = async (request: {
    url?: string;
    headers?: Record<string, string>;
  }) => {
    const url = String(request.url ?? '');
    sent.push({ url, cookie: request.headers?.Cookie });
    if (url.includes('/icf/logoff')) {
      return { status: 200, statusText: 'OK', headers: {}, data: '' };
    }
    return {
      status: 200,
      statusText: 'OK',
      data: '<service/>',
      headers: { 'x-csrf-token': 'TOKEN', 'set-cookie': [cookie] },
    };
  };
  const conn = new AdtOnPremConnector(
    config,
    credentialWriting({ authorization: 'Basic dTpw' }),
    transport,
    null,
  );
  const logoffs = () => sent.filter((r) => r.url.includes('/icf/logoff'));
  return { conn, transport, logoffs };
}

/** The wire establishes — cookie and all — and the establishment then fails. */
function failAfterEstablishing(transport: OnPremHttpTransport): void {
  const establish = transport.establish.bind(transport);
  transport.establish = async (context) => {
    await establish(context);
    throw new Error('established, then failed');
  };
}

function closeThrowsSynchronously(
  transport: OnPremHttpTransport,
): () => number {
  let calls = 0;
  (transport as unknown as { close: () => never }).close = () => {
    calls += 1;
    throw new Error('the goodbye threw synchronously');
  };
  return () => calls;
}

describe('a close() that throws synchronously', () => {
  it('after a failed establishment, the caller gets the establishment error and no cookie survives', async () => {
    const { conn, transport } = onPremWire(SESSION);
    failAfterEstablishing(transport);
    const closes = closeThrowsSynchronously(transport);

    await expect(conn.connect()).rejects.toThrow('established, then failed');

    expect(closes()).toBe(1);
    expect(conn.isConnected()).toBe(false);
    expect(transport.cookies()).toBeNull();
    expect(conn.getSessionIdentity()).toBeNull();
  });

  it('when the server opened no session, the caller gets that refusal and no cookie survives', async () => {
    const { conn, transport } = onPremWire(NO_SESSION);
    const closes = closeThrowsSynchronously(transport);

    await expect(conn.connect()).rejects.toThrow(/opened no ABAP session/);

    expect(closes()).toBe(1);
    expect(conn.isConnected()).toBe(false);
    expect(transport.cookies()).toBeNull();
  });

  it('disconnect() settles, never throws, and drops the session', async () => {
    const { conn, transport } = onPremWire(SESSION);
    await conn.connect();
    const closes = closeThrowsSynchronously(transport);

    await expect(conn.disconnect()).resolves.toBeUndefined();

    expect(closes()).toBe(1);
    expect(conn.isConnected()).toBe(false);
    expect(transport.cookies()).toBeNull();
    await expect(conn.flushGoodbye(100)).resolves.toBeUndefined();
  });
});

describe('the goodbye is still called synchronously', () => {
  it('after a failed establishment, it carries the session cookie', async () => {
    const { conn, transport, logoffs } = onPremWire(SESSION);
    failAfterEstablishing(transport);

    await expect(conn.connect()).rejects.toThrow('established, then failed');
    await settled();

    expect(logoffs()).toHaveLength(1);
    expect(logoffs()[0].cookie).toContain('SAP_SESSIONID_STUB_100=S1');
  });

  it('when the server opened no session, it carries the cookie the wire held', async () => {
    const { conn, logoffs } = onPremWire(NO_SESSION);

    await expect(conn.connect()).rejects.toThrow(/opened no ABAP session/);
    await settled();

    expect(logoffs()).toHaveLength(1);
    expect(logoffs()[0].cookie).toContain('sap-XSRF_STUB_100=X1');
  });

  it('on disconnect(), it carries the session cookie', async () => {
    const { conn, logoffs } = onPremWire(SESSION);
    await conn.connect();

    await conn.disconnect();
    await conn.flushGoodbye(1000);

    expect(logoffs()).toHaveLength(1);
    expect(logoffs()[0].cookie).toContain('SAP_SESSIONID_STUB_100=S1');
  });
});
