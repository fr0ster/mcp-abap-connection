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
} from '@mcp-abap-adt/interfaces';

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

    it('settles a repeat disconnect(), with nothing left owed', async () => {
      const conn = fixture.build();
      await conn.connect();

      await conn.disconnect();

      await expect(conn.disconnect()).resolves.toBeUndefined();
    });

    it('settles disconnect() on a connection that never connected', async () => {
      const conn = fixture.build();

      await expect(conn.disconnect()).resolves.toBeUndefined();
    });

    it('honours a disconnect deadline of zero', async () => {
      const conn = fixture.build();
      await conn.connect();

      // Zero means do not wait for the release. It must still settle, and still
      // leave the connection unusable.
      await expect(conn.disconnect({ deadlineMs: 0 })).resolves.toBeUndefined();
      expect(conn.isConnected()).toBe(false);
    });

    it('opens a new session on a second connect()', async () => {
      const conn = fixture.build();
      await conn.connect();
      const first = conn.getSessionIdentity();
      await conn.disconnect();

      await conn.connect();

      expect(conn.isConnected()).toBe(true);
      // A reconnect is a NEW session, not the old one resumed — otherwise a
      // caller could not tell a session it still holds from one it lost.
      expect(conn.getSessionIdentity()).not.toBe(first);
      expect(fixture.sessionsOpened()).toBe(2);
    });
  });
}
