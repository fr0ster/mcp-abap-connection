/**
 * Over HTTP, only a stateful request reaches the stateful context.
 *
 * `sap-contextid` names the stateful ABAP context a `LOCK` opened, and SAP
 * routes any request carrying it into that context — session header or none.
 * Sent on every request, it made the "stateless" `PUT` run in the lock's
 * context: on E19 (BASIS 816) a package's second write answered 400 PAK/058,
 * the first save still in that context's buffer; on E98 (BASIS 756) every
 * `PUT` answered 423 "invalid lock handle". Without the cookie on the
 * non-stateful requests both systems wrote twice (2026-09-27).
 *
 * The session header and the context cookie are HTTP's, and go on stateful
 * requests only — the way Eclipse's trace shows them on `LOCK` and `UNLOCK`.
 */
import { LegacyOnPremHttpTransport } from '../connection/LegacyOnPremHttpTransport.js';
import { OnPremHttpTransport } from '../connection/OnPremHttpTransport.js';

function wire<T extends OnPremHttpTransport>(transport: T) {
  const seen: Array<Record<string, string>> = [];
  (transport as unknown as { instance: unknown }).instance = async (config: {
    headers?: Record<string, string>;
  }) => {
    seen.push(config.headers ?? {});
    return { status: 200, statusText: 'OK', headers: {}, data: '' };
  };
  // What a LOCK answer leaves in the jar.
  transport.ingest({
    'set-cookie': [
      'SAP_SESSIONID_E19_100=S1; path=/',
      'sap-contextid=CTX1; path=/',
    ],
  });
  return { transport, seen };
}

const cookieNames = (headers: Record<string, string>) =>
  String(headers.Cookie ?? '')
    .split(/;\s*/)
    .map((pair) => pair.split('=')[0]);

const sessionType = (headers: Record<string, string>) =>
  Object.entries(headers).find(
    ([name]) => name.toLowerCase() === 'x-sap-adt-sessiontype',
  )?.[1];

describe('the stateful context over HTTP', () => {
  it('a stateful request carries the session header and the context cookie', async () => {
    const { transport, seen } = wire(
      new OnPremHttpTransport(() => ({}), null, { baseUrl: 'https://h' }),
    );
    await transport.send({ method: 'POST', url: '/lock', stateful: true });

    expect(sessionType(seen[0])).toBe('stateful');
    expect(cookieNames(seen[0])).toEqual(
      expect.arrayContaining(['SAP_SESSIONID_E19_100', 'sap-contextid']),
    );
  });

  it('a request that is not stateful carries neither', async () => {
    const { transport, seen } = wire(
      new OnPremHttpTransport(() => ({}), null, { baseUrl: 'https://h' }),
    );
    await transport.send({ method: 'PUT', url: '/put' });

    expect(sessionType(seen[0])).toBeUndefined();
    expect(cookieNames(seen[0])).toContain('SAP_SESSIONID_E19_100');
    expect(cookieNames(seen[0])).not.toContain('sap-contextid');
  });

  it('keeps the context for the stateful requests that follow', async () => {
    // The UNLOCK after a stateless PUT must still reach the lock's context.
    const { transport, seen } = wire(
      new OnPremHttpTransport(() => ({}), null, { baseUrl: 'https://h' }),
    );
    await transport.send({ method: 'PUT', url: '/put' });
    await transport.send({ method: 'POST', url: '/unlock', stateful: true });

    expect(cookieNames(seen[1])).toContain('sap-contextid');
  });

  it('treats a request that already carries the session header as stateful', async () => {
    const { transport, seen } = wire(
      new OnPremHttpTransport(() => ({}), null, { baseUrl: 'https://h' }),
    );
    await transport.send({
      method: 'POST',
      url: '/lock',
      headers: { 'x-sap-adt-sessiontype': 'stateful' },
    });

    expect(cookieNames(seen[0])).toContain('sap-contextid');
  });

  it('the legacy wire asks with no header, and keeps the context', async () => {
    const { transport, seen } = wire(
      new LegacyOnPremHttpTransport(() => ({}), null, { baseUrl: 'https://h' }),
    );
    await transport.send({ method: 'POST', url: '/lock', stateful: true });

    expect(sessionType(seen[0])).toBeUndefined();
    expect(cookieNames(seen[0])).toContain('sap-contextid');
  });
});
