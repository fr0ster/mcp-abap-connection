import { HttpTransport } from '../../connection/HttpTransport.js';
/**
 * The session-state half of `IAdtTransport`, for a stub whose subject is
 * something else.
 *
 * A transport must answer what cookies it holds and which session it is on —
 * that is the contract, and it is the reason a connection no longer keeps a
 * cookie jar it might have no use for. A stub written to test retries or the
 * axis types has no opinion about any of it, so it says the honest thing: it
 * holds nothing, and it is on no session.
 */
export const holdsNoSession = {
  // Required members, empty because they are true of a stub: nothing to open,
  // nothing to give back. Stated rather than omitted — which is the point of
  // making them contract instead of a question the connection asks.
  open: async () => {},
  close: async () => {},
  establish: async () => {},
  // A stub holds no session, and says so — the wire answers this for itself
  // now, instead of the connection reading a fingerprint and a flag.
  sessionEstablished: () => false,
  csrfToken: () => null,
  adoptCsrfToken: () => {},
  ingest: () => {},
  cookies: () => null,
  sessionFingerprint: () => new Map<string, string>(),
  affinityHeaders: () => ({}),
  forgetSession: () => {},
};

/**
 * Real wire state, for a stub whose subject is the send path.
 *
 * A stub that answered with `set-cookie` and ingested nothing would be a wire
 * that forgets what the server told it — and the connection, which now asks
 * the transport what session it is on, would rightly say there is none. This
 * borrows `HttpTransport`'s own jar rather than growing a second copy of the
 * parsing, which is the thing that would drift.
 */
export function holdsItsSession(
  send?: (request: {
    method: string;
    url: string;
    headers?: Record<string, string>;
  }) => Promise<{ headers?: unknown }>,
) {
  const state = new HttpTransport();
  return {
    // Empty, and true of it: an HTTP wire's session arrives with the
    // establishing call below, so there is nothing to ask for and nothing to
    // give back at this level.
    open: async () => {},
    close: async () => {},
    sessionEstablished: () => state.sessionEstablished(),
    /**
     * What an HTTP wire does: ask the discovery endpoint, fold the answer in.
     * A stub that established by doing nothing would be a wire that reports no
     * session, and the connection would rightly refuse to connect over it.
     */
    establish: async (context: {
      baseUrl: string;
      authHeaders: () => Promise<Record<string, string>>;
      observe: (headers: unknown) => void;
    }) => {
      if (!send) return;
      const response = await send({
        method: 'GET',
        url: `${context.baseUrl}/sap/bc/adt/core/discovery`,
        headers: {
          ...(await context.authHeaders()),
          'x-csrf-token': 'fetch',
        },
      });
      context.observe(response.headers);
      state.ingest(response.headers as Record<string, unknown>);
      state.adoptCsrfToken('TOKEN');
    },
    csrfToken: () => state.csrfToken(),
    adoptCsrfToken: (token: string | null) => state.adoptCsrfToken(token),
    ingest: (headers?: Record<string, unknown>) => state.ingest(headers),
    cookies: () => state.cookies(),
    sessionFingerprint: () => state.sessionFingerprint(),
    affinityHeaders: () => state.affinityHeaders(),
    forgetSession: () => state.forgetSession(),
  };
}

/**
 * Seed the wire the way a response would have.
 *
 * Tests used to assign `cookies` and poke `cookieStore` directly, which worked
 * while both lived on the connection. They are the transport's now, and a test
 * that reached around it would be seeding a jar nobody reads.
 */
// biome-ignore lint/suspicious/noExplicitAny: reaches into a connection under test
export function seedCookies(conn: any, cookies: string): void {
  conn.transport.ingest({
    'set-cookie': cookies.split(';').map((entry: string) => entry.trim()),
  });
}

/** What the wire is holding, for an assertion that used to read a field. */
// biome-ignore lint/suspicious/noExplicitAny: reaches into a connection under test
export function heldCookies(conn: any): string | null {
  return conn.transport.cookies();
}
