import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { ADT_SESSION_ERROR } from '@mcp-abap-adt/interfaces-adt-connection';
import { createConnection } from '../../connection/createConnection.js';
import { refusalOf } from '../../connection/IAdtTransport.js';
import type { ILogger } from '../../logger.js';
import { type SapStub, startSapStub } from '../helpers/sapStub.js';
import { stubProvider } from '../helpers/stubProvider.js';

const CHECK = '/sap/bc/adt/checkruns';
const DISCOVERY = '/sap/bc/adt/core/discovery';
const LOGOFF = '/sap/public/bc/icf/logoff';
const expired = {
  status: 403,
  body: 'CSRF token validation failed',
  headers: { 'set-cookie': ['SAP_SESSIONID_STUB_100=REPLACED; Path=/'] },
};

let sap: SapStub;
beforeEach(async () => {
  sap = await startSapStub();
});
afterEach(async () => {
  await sap.close();
});

function connector() {
  return createConnection({
    system: 'onprem',
    transport: 'http',
    config: { url: sap.baseUrl, authType: 'basic', client: '100' },
    credential: stubProvider(),
  });
}

const check = (connection: ReturnType<typeof connector>) =>
  connection.makeAdtRequest({
    url: CHECK,
    method: 'POST',
    timeout: 1000,
    data: '<check/>',
    params: { reporters: 'abapCheckRun' },
  });

it('replays a CSRF-refused check once in a freshly established session', async () => {
  const connection = connector();
  await connection.connect();
  sap.work(CHECK, [expired, { status: 200, body: 'checked' }]);
  try {
    const result = await check(connection);
    assert.equal(result.status, 200);
    assert.equal(result.data, 'checked');
    assert.equal(result.sessionLost, ADT_SESSION_ERROR.SESSION_REPLACED);
    assert.equal(connection.isConnected(), false);
    const [first, replay] = sap.sentTo(CHECK);
    assert.equal(sap.sentTo(CHECK).length, 2);
    assert.notEqual(first.headers.cookie, replay.headers.cookie);
    assert.notEqual(
      first.headers['x-csrf-token'],
      replay.headers['x-csrf-token'],
    );
    assert.equal(sap.sentTo(DISCOVERY).length, 2);
    const stopped = () =>
      sap.sentTo(LOGOFF).some((r) => r.headers.cookie?.includes('=S2'));
    for (let i = 0; i < 50 && !stopped(); i += 1) await sleep(5);
    assert.ok(stopped(), 'the temporary retry session was logged off');
  } finally {
    await connection.disconnect();
  }
});

it('returns the failed relogon and sends no replay', async () => {
  const connection = connector();
  await connection.connect();
  sap.work(CHECK, [expired]);
  sap.discovery.push({ status: 503, body: 'logon unavailable' });
  try {
    await assert.rejects(check(connection), (error: unknown) => {
      assert.equal(refusalOf(error)?.status, 503);
      return true;
    });
    assert.equal(sap.sentTo(DISCOVERY).length, 2);
    assert.equal(sap.sentTo(CHECK).length, 1);
  } finally {
    await connection.disconnect();
  }
});

it('does not log on again for a write or a check inside a critical section', async () => {
  for (const critical of [false, true]) {
    const connection = connector();
    await connection.connect();
    const path = critical ? CHECK : '/sap/bc/adt/oo/classes/ztest/source/main';
    sap.work(path, [expired]);
    if (critical) connection.beginCriticalSection();
    const discoveryCount = sap.sentTo(DISCOVERY).length;
    try {
      await assert.rejects(
        connection.makeAdtRequest({
          url: path,
          method: critical ? 'POST' : 'PUT',
          timeout: 1000,
          data: '<x/>',
        }),
        (error: unknown) => refusalOf(error)?.status === 403,
      );
      assert.equal(sap.sentTo(DISCOVERY).length, discoveryCount);
      assert.equal(sap.sentTo(path).length, 1);
    } finally {
      if (critical) connection.endCriticalSection();
      await connection.disconnect();
    }
  }
});

it('returns a second CSRF refusal without opening a third session', async () => {
  const connection = connector();
  await connection.connect();
  sap.work(CHECK, [expired, expired]);
  try {
    await assert.rejects(
      check(connection),
      (error: unknown) => refusalOf(error)?.status === 403,
    );
    assert.equal(sap.sentTo(DISCOVERY).length, 2);
    assert.equal(sap.sentTo(CHECK).length, 2);
  } finally {
    await connection.disconnect();
  }
});

it('does not resend a check after the caller disconnects during relogon', async () => {
  const connection = connector();
  await connection.connect();
  sap.work(CHECK, [expired]);
  let signalArrival!: () => void;
  let releaseDiscovery!: () => void;
  const arrived = new Promise<void>((resolve) => {
    signalArrival = resolve;
  });
  const unblocked = new Promise<void>((resolve) => {
    releaseDiscovery = resolve;
  });
  sap.discovery.push({
    status: 200,
    hold: () => {
      signalArrival();
      return unblocked;
    },
  });
  const call = assert.rejects(check(connection));
  await arrived;
  const disconnected = connection.disconnect();
  releaseDiscovery();
  await Promise.all([call, disconnected]);
  assert.equal(sap.sentTo(CHECK).length, 1);
});

it('with noResend, a CSRF-refused check is the answer: no relogon, no replay', async () => {
  const connection = connector();
  await connection.connect();
  sap.work(CHECK, [expired]);
  try {
    await assert.rejects(
      connection.makeAdtRequest({
        url: CHECK,
        method: 'POST',
        timeout: 1000,
        data: '<check/>',
        params: { reporters: 'abapCheckRun' },
        noResend: true,
      }),
      (error: unknown) => {
        assert.equal(refusalOf(error)?.status, 403);
        return true;
      },
    );
    assert.equal(sap.sentTo(DISCOVERY).length, 1);
    assert.equal(sap.sentTo(CHECK).length, 1);
  } finally {
    await connection.disconnect();
  }
});

it('with noLog, the replay writes nothing of its own: one quiet line for the call', async () => {
  for (const noLog of [true, false]) {
    const lines: { message: string; meta: unknown }[] = [];
    let recording = false;
    const record = (message: string, meta?: unknown) => {
      if (recording) lines.push({ message, meta });
    };
    const logger: ILogger = {
      info: record,
      warn: record,
      error: record,
      debug: record,
    };
    const connection = createConnection({
      system: 'onprem',
      transport: 'http',
      config: { url: sap.baseUrl, authType: 'basic', client: '100' },
      credential: stubProvider(),
      logger,
      wireLogger: logger,
    });
    await connection.connect();
    sap.work(CHECK, [expired, { status: 200, body: 'checked' }]);
    // The replacement's logon names an application server.
    sap.discovery.push({
      status: 200,
      headers: { 'sap-adt-saplb': 'LBCANARY' },
    });
    recording = true;
    try {
      const result = await connection.makeAdtRequest({
        url: CHECK,
        method: 'POST',
        timeout: 1000,
        data: '<check/>',
        params: { reporters: 'abapCheckRun' },
        ...(noLog ? { noLog: true } : {}),
      });
      assert.equal(result.status, 200);
      const all = lines.map((l) => `${l.message} ${JSON.stringify(l.meta)}`);
      if (noLog) {
        const own = new Set([
          'CSRF token obtained',
          'The server published no logoff resource; sending the platform logoff',
        ]);
        const quiet = lines.filter((l) => !own.has(l.message));
        assert.equal(quiet.length, 1, all.join('\n'));
        assert.ok(!all.join('\n').includes('LBCANARY'), all.join('\n'));
      } else {
        assert.ok(all.join('\n').includes('LBCANARY'), all.join('\n'));
      }
    } finally {
      recording = false;
      await connection.disconnect();
    }
  }
});

it('with rawText, a replayed check answers its exact text', async () => {
  const connection = connector();
  await connection.connect();
  const body = '{"ok":true}\n';
  sap.work(CHECK, [
    expired,
    { status: 200, body, headers: { 'content-type': 'application/json' } },
  ]);
  try {
    const result = await connection.makeAdtRequest({
      url: CHECK,
      method: 'POST',
      timeout: 1000,
      data: '<check/>',
      params: { reporters: 'abapCheckRun' },
      rawText: true,
    });
    assert.equal(result.data, body);
    assert.equal(sap.sentTo(CHECK).length, 2);
  } finally {
    await connection.disconnect();
  }
});

it('with rawText, a JSON refusal is not replayed — as without it', async () => {
  const refusal = {
    ...expired,
    body: '{"message":"CSRF token validation failed"}',
    headers: { ...expired.headers, 'content-type': 'application/json' },
  };
  const sent: number[] = [];
  for (const rawText of [false, true]) {
    const connection = connector();
    await connection.connect();
    const before = sap.sentTo(CHECK).length;
    sap.work(CHECK, [refusal, { status: 200, body: 'checked' }]);
    try {
      await connection
        .makeAdtRequest({
          url: CHECK,
          method: 'POST',
          timeout: 1000,
          data: '<check/>',
          params: { reporters: 'abapCheckRun' },
          ...(rawText ? { rawText: true } : {}),
        })
        .catch(() => undefined);
      sent.push(sap.sentTo(CHECK).length - before);
    } finally {
      await connection.disconnect();
    }
  }
  assert.equal(sent[1], sent[0]);
});
