/**
 * Test precondition: put a connection into the connected state without a
 * network round trip.
 *
 * `connect()` is mandatory now, so a test whose subject is something else —
 * timeouts, headers, retry classification — needs the session to exist before
 * it can say anything. Establishing it for real would mean teaching every such
 * mock to answer a CSRF fetch, which tests the wrong thing and adds retry
 * delays to suites that are not about connecting.
 *
 * Tests that ARE about connecting use a real stub instead; see
 * `connection/sessionComposition.test.ts`.
 */
export function markConnectedForTest(
  connection: unknown,
  fingerprint: Map<string, string> = new Map([['SAP_SESSIONID_T_100', 'S1']]),
): void {
  (
    connection as {
      lifecycle: { markConnected(fp: Map<string, string>): void };
    }
  ).lifecycle.markConnected(fingerprint);
}

/**
 * Lose the session the way the connection does on its own, WITHOUT a logoff:
 * a dead-session answer, or a `SAP_SESSIONID` changed under it. The instance
 * stays usable — only a logoff or `disconnect()` spends it — so a following
 * `connect()` opens a next session on the same instance.
 *
 * For tests whose subject is a request that outlives its session: since
 * 16.0.0 `disconnect()` spends the instance, and this is the one path left on
 * which a next session shares the instance with the stale request.
 */
export async function loseSessionForTest(connection: unknown): Promise<void> {
  const conn = connection as {
    raiseSessionLost(reason: string): void;
    lifecycle: {
      transition(kind: string, run: () => Promise<void>): Promise<void>;
    };
  };
  conn.raiseSessionLost('test: the session was lost');
  // The cleanup is queued as a transition; a no-op one behind it settles
  // once it has run.
  await conn.lifecycle.transition('cleanup', async () => {});
}
