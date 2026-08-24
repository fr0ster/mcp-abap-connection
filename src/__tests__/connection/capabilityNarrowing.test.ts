/**
 * The claims USAGE makes about narrowing to a capability atom, executed.
 *
 * These have been wrong twice, in opposite directions, which is why they are
 * executed rather than written down. First the doc said "widen it yourself and
 * the compiler rejects an RFC connection", which was false — widening is an
 * ASSERTION and silences the error for everything. Then these tests pinned the
 * correction too hard, reading "RFC owns no HTTP session" as "RFC has no
 * lifecycle": it has one, its conversation IS the session, and what it has none
 * of is a session RESOURCE to open and close by address.
 *
 * So the subject of "lacks the atom" is no longer a shipped class. It is a bare
 * IAbapConnection, which is what the atom was always for.
 */

import type {
  IAbapConnection,
  ISessionLifecycleAware,
} from '@mcp-abap-adt/interfaces';
import { BasicAuthProvider } from '../../auth/providers.js';
import { AdtOnPremConnector } from '../../connection/AdtOnPremConnector.js';
import { RfcTransport } from '../../connection/RfcTransport.js';
import { onPremHttpTransport } from '../helpers/onPrem.js';

const httpConfig = {
  url: 'https://h:44300',
  authType: 'basic',
  username: 'U',
  password: 'P',
  client: '100',
} as any;

/** The same connector, over the wire whose conversation IS its session. */
const onPremOverRfc = () =>
  new AdtOnPremConnector(
    rfcConfig,
    new BasicAuthProvider('U', 'P'),
    new RfcTransport(() => ({}) as never, null),
    null,
    undefined,
  );

const rfcConfig = {
  url: 'https://h:44300',
  authType: 'basic',
  connectionType: 'rfc',
  username: 'U',
  password: 'P',
  client: '100',
  ashost: 'h',
  sysnr: '00',
} as any;

/**
 * The predicates USAGE tells consumers to write. Evidence, not assertion.
 *
 * Every method of the atom, deliberately: a predicate narrows to the WHOLE
 * interface, so checking one method and promising the rest would put the failure
 * back inside the branch that looked safe.
 */
function supportsSessionLifecycle(
  conn: IAbapConnection,
): conn is IAbapConnection & ISessionLifecycleAware {
  const candidate = conn as Partial<ISessionLifecycleAware>;
  return (
    typeof candidate.disconnect === 'function' &&
    typeof candidate.isConnected === 'function' &&
    typeof candidate.getSessionIdentity === 'function'
  );
}

/** The signature USAGE recommends: ask for the atom, not for a class. */
function ownsSession(_conn: IAbapConnection & ISessionLifecycleAware): void {}

// Both transports satisfy it at compile time. RFC used to be rejected here, on
// the reading that a connection with no HTTP session has no lifecycle to speak
// of. That conflated two things: RFC needs no session RESOURCE opened — its
// conversation is the session, and there is no endpoint to tell — but the
// conversation is still opened, still observable and still torn down.
ownsSession(
  new AdtOnPremConnector(
    httpConfig,
    new BasicAuthProvider('U', 'P'),
    onPremHttpTransport(httpConfig, null),
    null,
  ),
);
ownsSession(onPremOverRfc());

/** A connection that genuinely stops at IAbapConnection: a stub, a recorder. */
const bare: IAbapConnection = {
  connect: async () => {},
  getBaseUrl: async () => 'https://h:44300',
  getSessionId: () => null,
  setSessionType: () => {},
  makeAdtRequest: async () => {
    throw new Error('not a real connection');
  },
};

describe('narrowing to a connection capability', () => {
  // Claim 1: a concrete HTTP class carries the evidence in its TYPE. If this
  // assignment ever needs a cast, the implements clause has been lost.
  it('an HTTP connection satisfies the atom at compile time', () => {
    const conn: IAbapConnection & ISessionLifecycleAware =
      new AdtOnPremConnector(
        httpConfig,
        new BasicAuthProvider('U', 'P'),
        onPremHttpTransport(httpConfig, null),
        null,
      );
    expect(typeof conn.disconnect).toBe('function');
    expect(typeof conn.getSessionIdentity).toBe('function');
  });

  // Claim 2: RFC carries it too. What RFC has none of is a session RESOURCE to
  // open and close — its open and close say nothing to the server, because the
  // conversation the native client holds IS the session. That is an empty
  // strategy, not an absent lifecycle.
  it('an RFC connection carries the atom, with nothing to tell the server', async () => {
    const conn: IAbapConnection = onPremOverRfc();

    expect(supportsSessionLifecycle(conn)).toBe(true);
    if (!supportsSessionLifecycle(conn)) throw new Error('unreachable');

    // Never connected, so there is nothing owed — and it still settles.
    expect(conn.isConnected()).toBe(false);
    expect(conn.getSessionIdentity()).toBeNull();
    await expect(conn.disconnect()).resolves.toBeUndefined();
  });

  it('the predicate admits an HTTP connection', () => {
    const conn: IAbapConnection = new AdtOnPremConnector(
      httpConfig,
      new BasicAuthProvider('U', 'P'),
      onPremHttpTransport(httpConfig, null),
      null,
    );
    expect(supportsSessionLifecycle(conn)).toBe(true);
    expect(supportsSessionLifecycle(conn)).toBe(true);
  });

  // Claim 3: a PARTIAL implementation must fail the guard.
  //
  // This is the case a one-method check waves through: an object with
  // isConnected but no disconnect passes, narrows to the full atom, and then
  // throws inside the branch the guard was supposed to make safe. Test doubles
  // are the likeliest source — they implement what the test under way happens
  // to call.
  it('rejects a connection that implements only part of an atom', () => {
    const half = {
      ...(new AdtOnPremConnector(
        httpConfig,
        new BasicAuthProvider('U', 'P'),
        onPremHttpTransport(httpConfig, null),
        null,
      ) as unknown as Record<string, unknown>),
      isConnected: () => true,
      getSessionIdentity: () => null,
      disconnect: undefined,
    } as unknown as IAbapConnection;

    expect(supportsSessionLifecycle(half)).toBe(false);
    expect(supportsSessionLifecycle(half)).toBe(false);
  });

  // Claim 4: the branch that matters. A consumer holding only an
  // IAbapConnection must handle "no such capability" rather than cast past it.
  //
  // Both transports this package ships now carry the atom, so the subject here
  // is what the atom exists for: an IAbapConnection from somewhere else. A stub
  // in a consumer's test, a recorder, a future transport — the guard has to
  // hold for those, and using a shipped class as the example would have made
  // this test pass for the wrong reason.
  it('leaves a connection without the capability to a different plan', async () => {
    const conn: IAbapConnection = bare;
    let tornDown = false;
    if (supportsSessionLifecycle(conn)) {
      await conn.disconnect();
      tornDown = true;
    }
    expect(tornDown).toBe(false);
  });
});
