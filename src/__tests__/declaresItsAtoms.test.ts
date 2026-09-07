/**
 * The connection declares the atoms it honours, and the compiler checks it.
 *
 * All four methods existed before `@mcp-abap-adt/interfaces@38.1.0`, on the
 * concrete class only — `AbapConnection` is `IAbapConnection`, so a consumer
 * holding the contract reached them by casting or not at all. The atoms are the
 * fix, and declaring them is what makes the fix real: a narrowing consumer now
 * gets `beginCriticalSection`, `setProfilingRequest` and `flushGoodbye` from
 * the type they already hold.
 *
 * These are compile-time assertions with a runtime line each, so a member that
 * disappears fails the build rather than a test nobody reads.
 */
import type {
  IAbapConnection,
  ICriticalSection,
  IRequestProfiling,
  ISessionLifecycleAware,
} from '@mcp-abap-adt/interfaces';
import type { SapConfig } from '../config/sapConfig.js';
import { onPrem } from './helpers/onPrem.js';

const config: SapConfig = {
  url: 'https://sap.example.com',
  authType: 'basic',
  username: 'u',
  password: 'p',
  client: '100',
};

describe('the connection is the atoms it declares', () => {
  it('narrows to every one of them from the base contract', () => {
    const conn: IAbapConnection &
      ISessionLifecycleAware &
      ICriticalSection &
      IRequestProfiling = onPrem(config, null);

    expect(typeof conn.disconnect).toBe('function');
    expect(typeof conn.flushGoodbye).toBe('function');
    expect(typeof conn.beginCriticalSection).toBe('function');
    expect(typeof conn.endCriticalSection).toBe('function');
    expect(typeof conn.setProfilingRequest).toBe('function');
    expect(typeof conn.getProfilingRequest).toBe('function');
  });

  it('answers through the contract, not only through the class', () => {
    const conn: IAbapConnection & IRequestProfiling = onPrem(config, null);

    expect(conn.getProfilingRequest()).toBe('server-time');
    conn.setProfilingRequest(null);
    expect(conn.getProfilingRequest()).toBeNull();
  });
});
