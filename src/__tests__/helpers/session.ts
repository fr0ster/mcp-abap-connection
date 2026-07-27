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
