/**
 * `RfcAbapConnection` as a session-lifecycle-aware connection.
 *
 * The factory returns this class before it looks at anything else, so until it
 * carries the atom the factory cannot honestly declare one. These state what
 * the atom means for a connection whose session is an RFC conversation rather
 * than an HTTP one.
 */
import type { ISessionLifecycleAware } from '@mcp-abap-adt/interfaces';
import { RfcAbapConnection } from '../connection/RfcAbapConnection.js';
import type { ILogger } from '../logger.js';

const logger: ILogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

const config = {
  url: 'http://saphost:8000',
  client: '100',
  username: 'USER',
  password: 'PASS',
  authType: 'basic' as const,
  connectionType: 'rfc' as const,
};

/** A stand-in for the native client, which needs the SAP NW RFC SDK to exist. */
function fakeClient(
  overrides: Partial<{ alive: boolean; close: () => Promise<void> }> = {},
) {
  return {
    alive: true,
    open: jest.fn(async () => {}),
    close: jest.fn(async () => {}),
    call: jest.fn(async () => ({})),
    ...overrides,
  };
}

function connected(client: ReturnType<typeof fakeClient> = fakeClient()) {
  const conn = new RfcAbapConnection(config, logger);
  (conn as any).rfcClient = client;
  return { conn: conn as RfcAbapConnection & ISessionLifecycleAware, client };
}

beforeEach(() => jest.clearAllMocks());

describe('getSessionIdentity', () => {
  it('is null before a session exists', () => {
    const conn = new RfcAbapConnection(config, logger) as RfcAbapConnection &
      ISessionLifecycleAware;
    expect(conn.getSessionIdentity()).toBeNull();
  });

  it('reports the captured session cookie, not the client-side conversation id', () => {
    const { conn } = connected();
    (conn as any).sessionCookie = 'SAP_SESSIONID_TRL_100=abc123';

    expect(conn.getSessionIdentity()).toBe('SAP_SESSIONID_TRL_100=abc123');
    expect(conn.getSessionIdentity()).not.toBe(conn.getSessionId());
  });
});

describe('isConnected', () => {
  it('is false before connect()', () => {
    const conn = new RfcAbapConnection(config, logger) as RfcAbapConnection &
      ISessionLifecycleAware;
    expect(conn.isConnected()).toBe(false);
  });

  it('is true while the RFC client is alive', () => {
    const { conn } = connected();
    expect(conn.isConnected()).toBe(true);
  });

  it('is false once the client reports itself dead', () => {
    const { conn } = connected(fakeClient({ alive: false }));
    expect(conn.isConnected()).toBe(false);
  });
});

describe('disconnect', () => {
  it('closes the RFC client and leaves the connection unusable', async () => {
    const { conn, client } = connected();

    await conn.disconnect();

    expect(client.close).toHaveBeenCalledTimes(1);
    expect(conn.isConnected()).toBe(false);
  });

  it('forgets the session identity', async () => {
    const { conn } = connected();
    (conn as any).sessionCookie = 'SAP_SESSIONID_TRL_100=abc123';

    await conn.disconnect();

    expect(conn.getSessionIdentity()).toBeNull();
  });

  it('settles rather than throwing when the close fails', async () => {
    const client = fakeClient({
      close: jest.fn(async () => {
        throw new Error('RFC_COMMUNICATION_FAILURE');
      }),
    });
    const { conn } = connected(client);

    await expect(conn.disconnect()).resolves.toBeUndefined();
    expect(conn.isConnected()).toBe(false);
  });

  it('settles on a repeat call with nothing left to do', async () => {
    const { conn, client } = connected();

    await conn.disconnect();
    await expect(conn.disconnect()).resolves.toBeUndefined();

    expect(client.close).toHaveBeenCalledTimes(1);
  });
});
