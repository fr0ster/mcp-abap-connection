/**
 * The claims USAGE makes about narrowing to a capability atom, executed.
 *
 * The doc used to say "widen it yourself and the compiler rejects an RFC
 * connection". That was false: the factory returns IAbapConnection for every
 * config, so widening means an ASSERTION — which silences the error for RFC too
 * and moves the failure to runtime. These tests pin what is actually true, so
 * the prose cannot drift back.
 */
import type {
  IAbapConnection,
  ISessionLifecycleAware,
} from '@mcp-abap-adt/interfaces';
import { BaseAbapConnection } from '../../connection/BaseAbapConnection.js';
import { RfcAbapConnection } from '../../connection/RfcAbapConnection.js';

const httpConfig = {
  url: 'https://h:44300',
  authType: 'basic',
  username: 'U',
  password: 'P',
  client: '100',
} as any;

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

// The compile-time half of claim 1, proved the only way a test can prove it: the
// directive below fails the build if the call STOPS erroring. So RFC being
// rejected here is checked, not asserted in prose.
// @ts-expect-error RfcAbapConnection owns no HTTP session
ownsSession(new RfcAbapConnection(rfcConfig, null));

describe('narrowing to a connection capability', () => {
  // Claim 1: a concrete HTTP class carries the evidence in its TYPE. If this
  // assignment ever needs a cast, the implements clause has been lost.
  it('an HTTP connection satisfies the atom at compile time', () => {
    const conn: IAbapConnection & ISessionLifecycleAware =
      new BaseAbapConnection(httpConfig, null);
    expect(typeof conn.disconnect).toBe('function');
    expect(typeof conn.getSessionIdentity).toBe('function');
  });

  // Claim 2: RFC genuinely does not have them. This is what makes the atoms
  // the right shape — and what an assertion would hide.
  it('an RFC connection has neither, and the predicate says so', () => {
    const conn: IAbapConnection = new RfcAbapConnection(rfcConfig, null);
    expect(supportsSessionLifecycle(conn)).toBe(false);
    expect(supportsSessionLifecycle(conn)).toBe(false);
  });

  it('the predicate admits an HTTP connection', () => {
    const conn: IAbapConnection = new BaseAbapConnection(httpConfig, null);
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
      ...(new BaseAbapConnection(httpConfig, null) as unknown as Record<
        string,
        unknown
      >),
      isConnected: () => true,
      getSessionIdentity: () => null,
      disconnect: undefined,
    } as unknown as IAbapConnection;

    expect(supportsSessionLifecycle(half)).toBe(false);
    expect(supportsSessionLifecycle(half)).toBe(false);
  });

  // Claim 4: the branch that matters. A consumer holding only an
  // IAbapConnection must handle "no such capability" rather than cast past it.
  it('leaves a transport without the capability to a different plan', async () => {
    const conn: IAbapConnection = new RfcAbapConnection(rfcConfig, null);
    let tornDown = false;
    if (supportsSessionLifecycle(conn)) {
      await conn.disconnect();
      tornDown = true;
    }
    expect(tornDown).toBe(false);
  });
});
