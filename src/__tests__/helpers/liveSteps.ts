/**
 * The steps the live suites share, written against the connection's own API
 * and the ADT endpoints the connection's other tests already use.
 */

import type { AbapConnection } from '../../connection/AbapConnection.js';
import { classSourceUrl, classUrl } from './liveConfig.js';

export type LiveConnection = AbapConnection & {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  beginCriticalSection(): void;
  endCriticalSection(): void;
};

/** The ADT discovery document: 200, and it is the service document. */
export async function discovery(conn: LiveConnection) {
  return conn.makeAdtRequest({
    url: '/sap/bc/adt/discovery',
    method: 'GET',
    timeout: 60_000,
    headers: { Accept: 'application/atomsvc+xml' },
  });
}

export async function readClassSource(conn: LiveConnection, name: string) {
  return conn.makeAdtRequest({
    url: classSourceUrl(name),
    method: 'GET',
    timeout: 60_000,
    headers: { Accept: 'text/plain' },
  });
}

/**
 * LOCK then UNLOCK a class inside a critical section, on a stateful session —
 * the sequence whose handle must survive on the one ABAP session. Nothing is
 * changed: the lock is taken and given back.
 *
 * The unlock is in a `finally`, so a failure between the two does not leave the
 * user's object locked.
 */
export async function lockAndUnlock(
  conn: LiveConnection,
  name: string,
): Promise<{ lockStatus: number; unlockStatus: number }> {
  const uri = classUrl(name);
  conn.setSessionType('stateful');
  conn.beginCriticalSection();
  let handle: string | undefined;
  try {
    const locked = await conn.makeAdtRequest({
      url: `${uri}?_action=LOCK&accessMode=MODIFY`,
      method: 'POST',
      timeout: 60_000,
      headers: {
        Accept:
          'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.Result',
      },
      data: '',
    });
    handle = String(locked.data).match(
      /<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/,
    )?.[1];
    if (!handle) {
      throw new Error(
        `LOCK on ${name} answered ${locked.status} with no lock handle`,
      );
    }
    const unlocked = await conn.makeAdtRequest({
      url: `${uri}?_action=UNLOCK&lockHandle=${encodeURIComponent(handle)}`,
      method: 'POST',
      timeout: 60_000,
      data: '',
    });
    handle = undefined;
    return { lockStatus: locked.status, unlockStatus: unlocked.status };
  } finally {
    try {
      if (handle) {
        await conn.makeAdtRequest({
          url: `${uri}?_action=UNLOCK&lockHandle=${encodeURIComponent(handle)}`,
          method: 'POST',
          timeout: 60_000,
          data: '',
        });
      }
    } finally {
      conn.endCriticalSection();
      conn.setSessionType('stateless');
    }
  }
}
