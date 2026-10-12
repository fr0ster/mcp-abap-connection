/**
 * A replaced ABAP session inside a lock window is SESSION_REPLACED.
 *
 * Two sessions, measured on E19 (2026-10-13) with bare HTTP: `SAP_SESSIONID`
 * is the HTTP security session (the logon); `sap-contextid`
 * (`path=/sap/bc/adt`) addresses the ABAP session, where the stateful context
 * and the ENQUEUE locks live. A stateful request with the same
 * `SAP_SESSIONID` but without `sap-contextid` is given a NEW one, and the lock
 * taken in the old one stays held there: an UNLOCK in the new one answers 200
 * and releases nothing. A stateless request in a stateful context makes SAP
 * delete `sap-contextid` (one-character value, 1980 expiry), the lock is
 * released, and `SAP_SESSIONID` stays — no replacement.
 */
import { ADT_SESSION_ERROR } from '@mcp-abap-adt/interfaces-adt-connection';
import type { SapConfig } from '../config/sapConfig.js';
import type { IAdtTransportRequest } from '../connection/IAdtTransport.js';
import { onPrem } from './helpers/onPrem.js';

const config: SapConfig = {
  url: 'https://sap.example.com',
  authType: 'basic',
  username: 'u',
  password: 'p',
  client: '100',
};

const GONE = 'expires=Tue, 01-Jan-1980 00:00:01 GMT';

/** A wire whose answers set the cookies queued per path, once each. */
async function connected(answers: Record<string, string[][]>) {
  const conn = onPrem(config, null);
  const queued = new Map(
    Object.entries(answers).map(([path, list]) => [path, [...list]]),
  );
  const send = async (request: IAdtTransportRequest) => {
    const path = request.url.startsWith(config.url)
      ? request.url.slice(config.url.length)
      : request.url;
    const cookies = queued.get(path)?.shift() ?? [];
    if (path.includes('/discovery')) {
      return {
        status: 200,
        statusText: 'OK',
        data: '<service/>',
        headers: {
          'x-csrf-token': 'TOKEN',
          'set-cookie': ['SAP_SESSIONID_STUB_100=S1; path=/', ...cookies],
        },
      };
    }
    return {
      status: 200,
      statusText: 'OK',
      data: '',
      headers: cookies.length ? { 'set-cookie': cookies } : {},
    };
  };
  Object.assign(conn.transport as unknown as Record<string, unknown>, {
    send,
    sendDetached: send,
  });
  await conn.connect();
  return conn;
}

const get = (url: string) => ({ url, method: 'GET', timeout: 5000 });

describe('the ABAP session (sap-contextid) inside a lock window', () => {
  it('a different sap-contextid inside the critical section is SESSION_REPLACED', async () => {
    const conn = await connected({
      '/lock': [['sap-contextid=A; path=/sap/bc/adt']],
      '/write': [['sap-contextid=B; path=/sap/bc/adt']],
    });
    conn.beginCriticalSection();
    conn.setSessionType('stateful');

    await conn.makeAdtRequest(get('/lock'));
    await expect(conn.makeAdtRequest(get('/write'))).rejects.toMatchObject({
      code: ADT_SESSION_ERROR.SESSION_REPLACED,
    });
    // The session is lost: admission is shut.
    expect(conn.isConnected()).toBe(false);
  });

  it('a sap-contextid issued for the first time is not a replacement', async () => {
    const conn = await connected({
      '/lock': [['sap-contextid=A; path=/sap/bc/adt']],
    });
    conn.beginCriticalSection();
    conn.setSessionType('stateful');

    await expect(conn.makeAdtRequest(get('/lock'))).resolves.toMatchObject({
      status: 200,
    });
    expect(conn.isConnected()).toBe(true);
  });

  it('a sap-contextid deleted by a stateless switch is not a replacement', async () => {
    const conn = await connected({
      '/lock': [['sap-contextid=A; path=/sap/bc/adt']],
      '/stateless': [[`sap-contextid=X; path=/sap/bc/adt; ${GONE}`]],
    });
    conn.beginCriticalSection();
    conn.setSessionType('stateful');

    await conn.makeAdtRequest(get('/lock'));
    await expect(conn.makeAdtRequest(get('/stateless'))).resolves.toMatchObject(
      { status: 200 },
    );
    expect(conn.isConnected()).toBe(true);
    expect(conn.transport.abapContext()).toBeNull();
  });

  it('the same sap-contextid again is not a replacement', async () => {
    const conn = await connected({
      '/lock': [['sap-contextid=A; path=/sap/bc/adt']],
      '/write': [['sap-contextid=A; path=/sap/bc/adt']],
    });
    conn.beginCriticalSection();
    conn.setSessionType('stateful');

    await conn.makeAdtRequest(get('/lock'));
    await expect(conn.makeAdtRequest(get('/write'))).resolves.toMatchObject({
      status: 200,
    });
    expect(conn.isConnected()).toBe(true);
  });

  it('outside a critical section a different sap-contextid decides nothing', async () => {
    const conn = await connected({
      '/one': [['sap-contextid=A; path=/sap/bc/adt']],
      '/two': [['sap-contextid=B; path=/sap/bc/adt']],
    });
    conn.setSessionType('stateful');

    await conn.makeAdtRequest(get('/one'));
    await expect(conn.makeAdtRequest(get('/two'))).resolves.toMatchObject({
      status: 200,
    });
    expect(conn.isConnected()).toBe(true);
  });
});
