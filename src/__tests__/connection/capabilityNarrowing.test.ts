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

/** The predicate USAGE tells consumers to write. Evidence, not assertion. */
function supportsLockWindows(
  conn: IAbapConnection,
): conn is IAbapConnection & ILockWindowAware {
  return typeof (conn as Partial<ILockWindowAware>).beginWindow === 'function';
}

function supportsSessionLifecycle(
  conn: IAbapConnection,
): conn is IAbapConnection & ISessionLifecycleAware {
  return (
    typeof (conn as Partial<ISessionLifecycleAware>).disconnect === 'function'
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

  // Claim 3: the branch that matters. A consumer holding only an
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
