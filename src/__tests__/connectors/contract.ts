/**
 * What every connection must do, whichever one it is.
 *
 * The hierarchy offers three combinations — cloud, on-prem over HTTP, on-prem
 * over RFC — and until now the behavioural suites proved one of them. They all
 * reached the shared machinery through whatever subclass was shortest, so
 * teardown, session identity and stale-request fencing were established for
 * on-prem HTTP and *assumed* for the other two.
 *
 * The bodies were never HTTP-specific, which is why this is one suite rather
 * than three: every assertion below is on `IAbapConnection` and
 * `ISessionLifecycleAware`, the contract all three implement. What differs is
 * the substrate — a cloud session is an ADT resource, an on-prem one arrives
 * with the establishing call, and an RFC conversation IS the session — so each
 * combination supplies a fixture and the same body runs against it.
 *
 * Anything that is true of only one of them does NOT belong here. It goes in
 * that combination's own file, where naming the mechanism is the point.
 */
import type {
  IAbapConnection,
  ISessionLifecycleAware,
} from '@mcp-abap-adt/interfaces-adt-connection';

export type Connection = IAbapConnection & ISessionLifecycleAware;

/**
 * The smallest vocabulary the shared bodies need from a substrate.
 *
 * Deliberately three operations. A fixture interface that grew HTTP nouns —
 * cookies, a discovery URL, `set-cookie` — could not be answered by the RFC
 * one, and the suite would quietly become an HTTP suite again.
 */
export interface ConnectorFixture {
  /** A connection whose far side answers normally. Not yet connected. */
  build(): Connection;
  /** How many sessions the far side has opened for this fixture so far. */
  sessionsOpened(): number;
  /** Make the far side refuse the next establishment. */
  refuseNext(): void;
  /** Release whatever the fixture holds. */
  dispose(): Promise<void>;
}

export function describeConnectorContract(
  name: string,
  makeFixture: () => Promise<ConnectorFixture>,
): void {
  describe(`${name}: the connection contract`, () => {
    let fixture: ConnectorFixture;

    beforeEach(async () => {
      fixture = await makeFixture();
    });

    afterEach(async () => {
      await fixture.dispose();
    });

    it('holds no session before connect()', () => {
      const conn = fixture.build();

      expect(conn.isConnected()).toBe(false);
      expect(conn.getSessionIdentity()).toBeNull();
    });

    it('is usable and on a session after connect()', async () => {
      const conn = fixture.build();

      await conn.connect();

      expect(conn.isConnected()).toBe(true);
      // Non-null on every wire, though what names the session differs: a
      // SAP_SESSIONID on HTTP, the conversation on RFC.
      expect(conn.getSessionIdentity()).not.toBeNull();
    });

    it('stays on the same session across requests', async () => {
      const conn = fixture.build();
      await conn.connect();
      const established = conn.getSessionIdentity();

      await conn.makeAdtRequest({
        url: '/sap/bc/adt/discovery',
        method: 'GET',
        timeout: 5000,
      });

      // A CHANGED identity is a replacement, which is the failure this exists
      // to expose. Unchanged is the whole assertion.
      expect(conn.getSessionIdentity()).toBe(established);
    });

    it('opens exactly one session for one connect()', async () => {
      const conn = fixture.build();

      await conn.connect();

      expect(fixture.sessionsOpened()).toBe(1);
    });

    it('refuses to connect when no session is established', async () => {
      const conn = fixture.build();
      fixture.refuseNext();

      await expect(conn.connect()).rejects.toThrow();

      // And keeps nothing: a resolved connect() must mean a usable session
      // exists, and a failed one must leave no debris for the next attempt to
      // trip over.
      expect(conn.isConnected()).toBe(false);
      expect(conn.getSessionIdentity()).toBeNull();
    });

    it('is unusable after disconnect()', async () => {
      const conn = fixture.build();
      await conn.connect();

      await conn.disconnect();

      expect(conn.isConnected()).toBe(false);
      expect(conn.getSessionIdentity()).toBeNull();
      await expect(
        conn.makeAdtRequest({
          url: '/sap/bc/adt/discovery',
          method: 'GET',
          timeout: 5000,
        }),
      ).rejects.toThrow(/ADT_NOT_CONNECTED/);
    });

    it('rejects a repeat disconnect(): it is called once per instance', async () => {
      const conn = fixture.build();
      await conn.connect();

      await conn.disconnect();

      await expect(conn.disconnect()).rejects.toMatchObject({
        code: 'ADT_NOT_CONNECTED',
      });
    });

    it('settles disconnect() on a connection that never connected', async () => {
      const conn = fixture.build();

      await expect(conn.disconnect()).resolves.toBeUndefined();
    });

    it('settles without waiting for the server to answer', async () => {
      const conn = fixture.build();
      await conn.connect();

      // It notifies; the answer is not acted on, so there is nothing to wait
      // for and no deadline to pass. What must hold is that it settles and
      // leaves the connection unusable.
      await expect(conn.disconnect()).resolves.toBeUndefined();
      expect(conn.isConnected()).toBe(false);
    });

    it('refuses connect() after disconnect(): one instance is one session', async () => {
      const conn = fixture.build();
      await conn.connect();
      await conn.disconnect();

      await expect(conn.connect()).rejects.toMatchObject({
        code: 'ADT_NOT_CONNECTED',
        message:
          "This connection's SAP session has ended (it was disconnected, logged off or lost); one connection instance is one session. Create a new connection for a new session.",
      });
      expect(conn.isConnected()).toBe(false);
      // Nothing was asked of the server for it.
      expect(fixture.sessionsOpened()).toBe(1);
    });

    it('a new session is a new instance', async () => {
      const first = fixture.build();
      await first.connect();
      await first.disconnect();

      const next = fixture.build();
      await next.connect();
      expect(next.isConnected()).toBe(true);
    });
  });
}
