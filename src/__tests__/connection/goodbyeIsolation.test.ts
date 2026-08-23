/**
 * A goodbye is addressed to the session it is saying goodbye to.
 *
 * `disconnect()` dispatches the logoff without awaiting it — the caller is owed
 * a teardown, not a round trip — so the request is still being assembled while
 * the connection is already free to `connect()` again. By the time it is sent,
 * the wire may hold a NEW session.
 *
 * Everything the goodbye needs is therefore read synchronously, before the
 * first await. That is necessary and was not sufficient: the send path dresses
 * every request with the wire's live cookie jar, and `mergeCookieHeaders` lets
 * the later value win on a repeated name — so the live `SAP_SESSIONID`
 * overwrote the snapshot and the logoff closed the session that had just been
 * opened.
 */
import type { IAuthProvider } from '@mcp-abap-adt/interfaces';
import type { SapConfig } from '../../config/sapConfig.js';
import { AdtOnPremConnector } from '../../connection/AdtOnPremConnector.js';
import { OnPremHttpTransport } from '../../connection/OnPremHttpTransport.js';

const config: SapConfig = {
  url: 'https://sap.example.com',
  authType: 'basic',
  username: 'u',
  password: 'p',
  client: '100',
};

/**
 * A wire that issues a new session per establishment, and holds the logoff so
 * a reconnect can overtake it — which is exactly what a slow server does.
 */
function wire() {
  let issued = 0;
  const sent: Array<{ url: string; cookie?: string }> = [];
  let releaseLogoff: (() => void) | undefined;
  const logoffReached = new Promise<void>((resolve) => {
    releaseLogoff = resolve;
  });

  return {
    sent,
    letTheLogoffGo: () => releaseLogoff?.(),
    logoffReached,
    send: async (request: {
      url?: string;
      headers?: Record<string, string>;
    }) => {
      const url = String(request.url ?? '');
      sent.push({ url, cookie: request.headers?.Cookie });

      if (url.includes('/icf/logoff')) {
        releaseLogoff?.();
        return { status: 200, statusText: 'OK', headers: {}, data: '' };
      }

      issued += 1;
      return {
        status: 200,
        statusText: 'OK',
        data: '<service/>',
        headers: {
          'x-csrf-token': 'TOKEN',
          'set-cookie': [`SAP_SESSIONID_STUB_100=S${issued}; path=/`],
        },
      };
    },
  };
}

describe('a logoff still in flight when the next session opens', () => {
  it('carries the cookie of the session it is ending, not the live one', async () => {
    const w = wire();
    const transport = new OnPremHttpTransport(() => ({}), null, {
      client: config.client,
      baseUrl: config.url,
    });
    // Stubbed at the CLIENT, not at send(): the defect lives in the dressing
    // send() does on its way out, so replacing send() would step over it.
    (transport as unknown as { instance: unknown }).instance = w.send;
    // The window this is about: `close()` suspends on `authHeaders()`, and a
    // provider that takes a moment is ordinary — a token provider checks expiry
    // and may go to the network. While it is suspended, the connection is
    // already free to connect again.
    let slow = false;
    const credential: IAuthProvider = {
      kind: 'slow',
      authorizationHeader: async () => {
        if (slow) await new Promise((r) => setTimeout(r, 40));
        return 'Basic dTpw';
      },
    };
    const conn = new AdtOnPremConnector(config, credential, transport, null);

    await conn.connect();
    expect(conn.getSessionIdentity()).toContain('S1');

    // Dispatched, not awaited — so the reconnect below overtakes it while the
    // goodbye is still assembling.
    slow = true;
    await conn.disconnect();

    slow = false;
    await conn.connect();
    expect(conn.getSessionIdentity()).toContain('S2');

    await w.logoffReached;
    await new Promise((r) => setTimeout(r, 60));

    const logoff = w.sent.find((r) => r.url.includes('/icf/logoff'));
    expect(logoff).toBeDefined();
    // The one assertion that matters. S2 here means the goodbye for the first
    // session closed the second one — a live session, with work possibly
    // running on it, ended by a message meant for a session already gone.
    expect(logoff?.cookie).toContain('S1');
    expect(logoff?.cookie).not.toContain('S2');
  });
});
