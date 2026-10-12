/**
 * Every wait an aborted request stops waiting for, answered late with a
 * failure — the worst case for an unhandled rejection — under plain node,
 * where the real process reports what nobody handled.
 *
 * Prints one JSON line: what each aborted caller got, and every rejection
 * left unhandled. `INJECT_UNHANDLED=1` leaves one unhandled on purpose, so
 * the test can show this process does see one.
 */
import { AdtOnPremConnector } from '../../../connection/AdtOnPremConnector.js';
import { untilAborted } from '../../../connection/requestAbort.js';
import {
  DISCOVERY,
  deferred,
  drained,
  gatedProvider,
  httpConfig,
  refused,
  rfcConfig,
  rfcConversations,
  scriptedWire,
} from '../requestSignal.js';
import { recordUnhandled } from './run.js';

const unhandled = recordUnhandled();

const request = (url: string, method: string, signal?: AbortSignal) => ({
  url,
  method,
  timeout: 5000,
  ...(signal ? { signal } : {}),
});

/** What an aborted caller got: its error's code, or `resolved`. */
const outcome = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'resolved',
    (error: unknown) => String((error as { code?: unknown })?.code),
  );

async function http() {
  const provider = gatedProvider();
  const wire = scriptedWire();
  const conn = new AdtOnPremConnector(
    httpConfig,
    provider,
    wire.transport,
    null,
  );
  await conn.connect();
  return { conn, provider, wire };
}

async function rfc() {
  const provider = gatedProvider();
  const conversations = rfcConversations();
  const conn = new AdtOnPremConnector(
    rfcConfig,
    provider,
    conversations.transport,
    null,
  );
  await conn.connect();
  return { conn, provider, conversations };
}

/** Starts `a` with a signal, aborts it once it waits, then fails the wait. */
async function abortedThenFailed(
  start: (signal: AbortSignal) => Promise<unknown>,
  fail: () => void,
): Promise<string> {
  const controller = new AbortController();
  const result = outcome(start(controller.signal));
  await drained();
  controller.abort();
  await drained();
  fail();
  await drained();
  return result;
}

async function main() {
  const results: Record<string, string> = {};

  {
    const { conn, provider } = await http();
    const gate = deferred();
    provider.gates.authorize = gate.promise;
    results.httpAuthorize = await abortedThenFailed(
      (signal) => conn.makeAdtRequest(request('/a', 'POST', signal)),
      () => gate.reject(new Error('late authorize failure')),
    );
  }
  {
    const { conn, provider, wire } = await http();
    wire.transport.adoptCsrfToken(null);
    const gate = deferred();
    provider.gates.authorize = gate.promise;
    results.httpExchangeAuthorize = await abortedThenFailed(
      (signal) => conn.makeAdtRequest(request('/a', 'POST', signal)),
      () => gate.reject(new Error('late exchange authorize failure')),
    );
  }
  {
    const { conn, wire } = await http();
    wire.transport.adoptCsrfToken(null);
    const held = wire.hold(DISCOVERY);
    results.httpExchange = await abortedThenFailed(
      (signal) => conn.makeAdtRequest(request('/a', 'POST', signal)),
      () => held.reject(refused(500)),
    );
  }
  {
    const { conn, provider, wire } = await http();
    conn.beginCriticalSection();
    wire.answer('/a', async () => {
      throw refused(401);
    });
    const gate = deferred();
    provider.gates.rejected = gate.promise;
    results.httpRejected = await abortedThenFailed(
      (signal) => conn.makeAdtRequest(request('/a', 'PUT', signal)),
      () => gate.reject(new Error('late rejected failure')),
    );
  }
  {
    const { conn, provider } = await rfc();
    const gate = deferred();
    provider.gates.establish = gate.promise;
    results.rfcLogon = await abortedThenFailed(
      (signal) => conn.makeAdtRequest(request('/a', 'PUT', signal)),
      () => gate.reject(new Error('late logon failure')),
    );
  }
  {
    const { conn, conversations } = await rfc();
    const held = conversations.holdOpen();
    results.rfcOpenFailed = await abortedThenFailed(
      (signal) => conn.makeAdtRequest(request('/a', 'PUT', signal)),
      () => held.reject(new Error('late open failure')),
    );
  }
  {
    const { conn, conversations } = await rfc();
    const held = conversations.holdOpen();
    results.rfcOpenSucceeded = await abortedThenFailed(
      (signal) => conn.makeAdtRequest(request('/a', 'PUT', signal)),
      () => held.resolve(),
    );
    results.rfcOpenSucceededClosed = String(conversations.opened[1]?.closes);
  }

  {
    // A wait that begins after its signal fired, on work that fails later.
    const controller = new AbortController();
    controller.abort();
    const work = deferred();
    results.preAborted = await outcome(
      untilAborted(controller.signal, work.promise),
    );
    work.reject(new Error('late failure of a wait that never began'));
  }

  await drained();
  await drained();
  process.stdout.write(`${JSON.stringify({ results, unhandled })}\n`);
}

main().catch((error: unknown) => {
  process.stdout.write(
    `${JSON.stringify({ failed: error instanceof Error ? error.message : String(error) })}\n`,
  );
});
