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
  ILockWindowAware,
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
function supportsLockWindows(
  conn: IAbapConnection,
): conn is IAbapConnection & ILockWindowAware {
  const candidate = conn as Partial<ILockWindowAware>;
  return (
    typeof candidate.beginWindow === 'function' &&
    typeof candidate.endWindow === 'function'
  );
}

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
function withLock(_conn: IAbapConnection & ILockWindowAware): void {}

// The compile-time half of claim 1, proved the only way a test can prove it: the
// directive below fails the build if the call STOPS erroring. So RFC being
// rejected here is checked, not asserted in prose.
// @ts-expect-error RfcAbapConnection implements no lock windows
withLock(new RfcAbapConnection(rfcConfig, null));

describe('narrowing to a connection capability', () => {
  // Claim 1: a concrete HTTP class carries the evidence in its TYPE. If this
  // assignment ever needs a cast, the implements clause has been lost.
  it('an HTTP connection satisfies both atoms at compile time', () => {
    const conn: IAbapConnection & ISessionLifecycleAware & ILockWindowAware =
      new BaseAbapConnection(httpConfig, null);
    expect(typeof conn.beginWindow).toBe('function');
    expect(typeof conn.disconnect).toBe('function');
  });

  // Claim 2: RFC genuinely does not have them. This is what makes the atoms
  // the right shape — and what an assertion would hide.
  it('an RFC connection has neither, and the predicate says so', () => {
    const conn: IAbapConnection = new RfcAbapConnection(rfcConfig, null);
    expect(supportsLockWindows(conn)).toBe(false);
    expect(supportsSessionLifecycle(conn)).toBe(false);
  });

  it('the predicate admits an HTTP connection', () => {
    const conn: IAbapConnection = new BaseAbapConnection(httpConfig, null);
    expect(supportsLockWindows(conn)).toBe(true);
    expect(supportsSessionLifecycle(conn)).toBe(true);
  });

  // Claim 3: a PARTIAL implementation must fail the guard.
  //
  // This is the case a one-method check waves through: an object with
  // beginWindow but no endWindow passes, narrows to the full atom, and then
  // throws inside the branch the guard was supposed to make safe. Test doubles
  // are the likeliest source — they implement what the test under way happens
  // to call.
  it('rejects a connection that implements only part of an atom', () => {
    const half = {
      ...(new BaseAbapConnection(httpConfig, null) as unknown as Record<
        string,
        unknown
      >),
      beginWindow: (label: string) => Symbol(label),
      endWindow: undefined,
      isConnected: () => true,
      getSessionIdentity: () => null,
      disconnect: undefined,
    } as unknown as IAbapConnection;

    expect(supportsLockWindows(half)).toBe(false);
    expect(supportsSessionLifecycle(half)).toBe(false);
  });

  // Claim 4: the branch that matters. A consumer holding only an
  // IAbapConnection must handle "no such capability" rather than cast past it.
  it('leaves a transport without the capability to a different plan', () => {
    const conn: IAbapConnection = new RfcAbapConnection(rfcConfig, null);
    let opened = false;
    if (supportsLockWindows(conn)) {
      conn.endWindow(conn.beginWindow('Class/ZCL_X'));
      opened = true;
    }
    expect(opened).toBe(false);
  });
});
