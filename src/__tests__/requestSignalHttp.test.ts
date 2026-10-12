/**
 * The request's signal at every send boundary, over HTTP.
 *
 * Two callers on one connection; one is cancelled at each boundary in turn.
 * The cancelled one rejects with `ADT_REQUEST_ABORTED`, in fixed words, at the
 * abort — while the wait it was in is still pending — and nothing more of it
 * reaches the endpoint after; the other caller, waiting on the same shared
 * work, succeeds. Nothing is left unhandled.
 */
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import {
  ABORTED,
  httpConfig as config,
  DISCOVERY,
  deferred,
  drained,
  gatedProvider,
  ok,
  refused,
  scriptedWire,
  watched,
} from './helpers/requestSignal.js';

async function connected() {
  const provider = gatedProvider();
  const wire = scriptedWire();
  const conn = new AdtOnPremConnector(config, provider, wire.transport, null);
  await conn.connect();
  return { conn, provider, wire };
}

const request = (url: string, method: string, signal?: AbortSignal) => ({
  url,
  method,
  timeout: 5000,
  ...(signal ? { signal } : {}),
});

describe('HTTP: the request signal at every send boundary', () => {
  it('before the first send: an aborted request asks nothing and sends nothing', async () => {
    const { conn, provider, wire } = await connected();
    const controller = new AbortController();
    controller.abort();
    const before = provider.counts.authorize;

    const a = conn.makeAdtRequest(request('/a', 'POST', controller.signal));
    const b = conn.makeAdtRequest(request('/b', 'POST'));

    await expect(a).rejects.toMatchObject(ABORTED);
    await expect(b).resolves.toMatchObject({ status: 200 });
    // B's one authorize, none of A's.
    expect(provider.counts.authorize).toBe(before + 1);
    expect(wire.sends('/a')).toBe(0);
  });

  it("after authorize(): the caller's wait ends at the abort, the shared one runs on", async () => {
    const { conn, provider, wire } = await connected();
    const gate = deferred();
    provider.gates.authorize = gate.promise;
    const controller = new AbortController();

    const a = watched(
      conn.makeAdtRequest(request('/a', 'POST', controller.signal)),
    );
    const b = conn.makeAdtRequest(request('/b', 'POST'));
    await drained();

    controller.abort();
    await drained();
    // At the abort: the authorize it waited on has not answered.
    expect(a.state()).toBe('rejected');
    expect(a.error()).toMatchObject(ABORTED);

    gate.resolve();
    await expect(b).resolves.toMatchObject({ status: 200 });
    await drained();
    expect(wire.sends('/a')).toBe(0);
  });

  it("the wire's own token exchange stops after authorize() for an aborted caller", async () => {
    const { conn, provider, wire } = await connected();
    // No token held: both mutations earn one first, through the exchange.
    wire.transport.adoptCsrfToken(null);
    const gate = deferred();
    provider.gates.authorize = gate.promise;
    const controller = new AbortController();
    const discoveryBefore = wire.sends(DISCOVERY);
    // The exchange A's request starts, watched: it must end at the abort
    // rather than idle through its retries.
    const establish = wire.transport.establish.bind(wire.transport);
    const exchanges: Array<ReturnType<typeof watched>> = [];
    wire.transport.establish = (context) => {
      const running = establish(context);
      exchanges.push(watched(running));
      return running;
    };

    const a = watched(
      conn.makeAdtRequest(request('/a', 'POST', controller.signal)),
    );
    await drained();
    controller.abort();
    await drained();
    expect(a.state()).toBe('rejected');
    expect(a.error()).toMatchObject(ABORTED);

    gate.resolve();
    await drained();
    await drained();
    // A's exchange was not sent after its abort, and its request never was.
    expect(wire.sends(DISCOVERY)).toBe(discoveryBefore);
    expect(wire.sends('/a')).toBe(0);
    // The abort ended the exchange, past its retries.
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].state()).toBe('rejected');
    expect(exchanges[0].error()).toMatchObject(ABORTED);

    provider.gates.authorize = undefined;
    await expect(
      conn.makeAdtRequest(request('/b', 'POST')),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('after the logon (establish()) a wire makes in the exchange: the exchange stops for an aborted caller', async () => {
    const { conn, provider, wire } = await connected();
    wire.transport.adoptCsrfToken(null);
    // A wire whose token exchange logs on first, as a custom one may.
    const establish = wire.transport.establish.bind(wire.transport);
    wire.transport.establish = async (context) => {
      await context.logon({
        tlsMaterial: () => ({ ok: true }),
        logonParameters: () => ({ ok: true }),
      });
      return establish(context);
    };
    const gate = deferred();
    provider.gates.establish = gate.promise;
    const controller = new AbortController();
    const discoveryBefore = wire.sends(DISCOVERY);
    const asked = provider.counts.authorize;

    const a = watched(
      conn.makeAdtRequest(request('/a', 'POST', controller.signal)),
    );
    await drained();
    controller.abort();
    await drained();
    expect(a.state()).toBe('rejected');
    expect(a.error()).toMatchObject(ABORTED);

    gate.resolve();
    await drained();
    await drained();
    // The exchange ended at the logon: nothing after it was asked or sent.
    expect(provider.counts.authorize).toBe(asked);
    expect(wire.sends(DISCOVERY)).toBe(discoveryBefore);
    expect(wire.sends('/a')).toBe(0);

    await expect(
      conn.makeAdtRequest(request('/b', 'POST')),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('the token exchange before a mutation: the wait ends at the abort, the exchange runs on', async () => {
    const { conn, provider, wire } = await connected();
    wire.transport.adoptCsrfToken(null);
    const held = wire.hold(DISCOVERY);
    const controller = new AbortController();
    const asked = provider.counts.authorize;

    const a = watched(
      conn.makeAdtRequest(request('/a', 'POST', controller.signal)),
    );
    await drained();
    controller.abort();
    await drained();
    expect(a.state()).toBe('rejected');
    expect(a.error()).toMatchObject(ABORTED);
    // The exchange's one authorize; the request itself was never authorized.
    expect(provider.counts.authorize).toBe(asked + 1);

    // The exchange already sent is not recalled: its answer is the wire's.
    held.resolve({
      status: 200,
      statusText: 'OK',
      data: '<service/>',
      headers: { 'x-csrf-token': 'EARNED' },
    });
    await drained();
    expect(wire.transport.csrfToken()).toBe('EARNED');
    expect(wire.sends('/a')).toBe(0);

    await expect(
      conn.makeAdtRequest(request('/b', 'POST')),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('before rejected(): an answer that came back after the abort asks the provider nothing', async () => {
    const { conn, provider, wire } = await connected();
    // Inside a critical section a 401 on a mutation goes straight to the
    // provider: the login-form cure would discard the lock's session.
    conn.beginCriticalSection();
    const held = wire.hold('/a');
    const controller = new AbortController();

    const a = conn.makeAdtRequest(request('/a', 'PUT', controller.signal));
    const b = conn.makeAdtRequest(request('/b', 'PUT'));
    await drained();
    controller.abort();
    // A request already sent is not recalled: its answer arrives.
    held.reject(refused(401));

    await expect(a).rejects.toMatchObject(ABORTED);
    await expect(b).resolves.toMatchObject({ status: 200 });
    expect(provider.counts.rejected).toBe(0);
    expect(wire.sends('/a')).toBe(1);
  });

  it("after rejected(): the caller's wait ends at the abort, the shared renewal runs on", async () => {
    const { conn, provider, wire } = await connected();
    conn.beginCriticalSection();
    wire.answer('/a', async () => {
      throw refused(401);
    });
    wire.answer('/b', async () => {
      throw refused(401);
    });
    const gate = deferred();
    provider.gates.rejected = gate.promise;
    const controller = new AbortController();

    const a = watched(
      conn.makeAdtRequest(request('/a', 'PUT', controller.signal)),
    );
    const b = conn.makeAdtRequest(request('/b', 'PUT'));
    await drained();
    expect(provider.counts.rejected).toBe(2);

    controller.abort();
    await drained();
    // At the abort: the renewal it waited on has not answered.
    expect(a.state()).toBe('rejected');
    expect(a.error()).toMatchObject(ABORTED);

    gate.resolve();
    await expect(b).resolves.toMatchObject({ status: 200 });
    await drained();
    // B was resent after the renewal; A was not.
    expect(wire.sends('/b')).toBe(2);
    expect(wire.sends('/a')).toBe(1);
  });

  it('before the CSRF recovery: no token exchange, no resend, the token kept', async () => {
    const { conn, wire } = await connected();
    const held = wire.hold('/a');
    const controller = new AbortController();
    const discoveryBefore = wire.sends(DISCOVERY);

    const a = conn.makeAdtRequest(request('/a', 'POST', controller.signal));
    await drained();
    controller.abort();
    held.reject(refused(403, 'CSRF token validation failed'));

    await expect(a).rejects.toMatchObject(ABORTED);
    // The session's token is everyone's: an aborted caller does not drop it.
    expect(wire.transport.csrfToken()).toBe('TOKEN');
    expect(wire.sends(DISCOVERY)).toBe(discoveryBefore);
    expect(wire.sends('/a')).toBe(1);

    await expect(
      conn.makeAdtRequest(request('/b', 'POST')),
    ).resolves.toMatchObject({ status: 200 });
    expect(wire.sends(DISCOVERY)).toBe(discoveryBefore);
  });

  it('before the resend of a GET the cookies would cure: nothing more is asked or sent', async () => {
    const { conn, provider, wire } = await connected();
    const held = wire.hold('/a');
    const controller = new AbortController();

    const a = conn.makeAdtRequest(request('/a', 'GET', controller.signal));
    const b = conn.makeAdtRequest(request('/b', 'GET'));
    await drained();
    const asked = provider.counts.authorize;
    controller.abort();
    held.reject(refused(401));

    await expect(a).rejects.toMatchObject(ABORTED);
    await expect(b).resolves.toMatchObject({ status: 200 });
    expect(provider.counts.authorize).toBe(asked);
    expect(wire.sends('/a')).toBe(1);
  });

  it("during the CSRF recovery's exchange: the caller gets its abort, not the 403", async () => {
    const { conn, wire } = await connected();
    wire.answer('/a', async () => {
      throw refused(403, 'CSRF token validation failed');
    });
    const held = wire.hold(DISCOVERY);
    const controller = new AbortController();

    const a = watched(
      conn.makeAdtRequest(request('/a', 'POST', controller.signal)),
    );
    await drained();
    expect(wire.sends('/a')).toBe(1);
    controller.abort();
    await drained();
    expect(a.state()).toBe('rejected');
    expect(a.error()).toMatchObject(ABORTED);

    // The exchange already sent is not recalled; its answer is the wire's.
    held.resolve({
      status: 200,
      statusText: 'OK',
      data: '<service/>',
      headers: { 'x-csrf-token': 'RENEWED' },
    });
    await drained();
    expect(wire.sends('/a')).toBe(1);
    await expect(
      conn.makeAdtRequest(request('/b', 'POST')),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('a session that went away while the caller waited: the caller still gets its abort', async () => {
    const { conn, provider, wire } = await connected();
    const gate = deferred();
    provider.gates.authorize = gate.promise;
    const controller = new AbortController();

    const a = watched(
      conn.makeAdtRequest(request('/a', 'POST', controller.signal)),
    );
    await drained();
    await conn.disconnect();
    await drained();
    // The goodbye went to the stub, as every send of this wire does.
    expect(wire.sends('/sap/public/bc/icf/logoff')).toBe(1);
    controller.abort();
    await drained();
    expect(a.state()).toBe('rejected');
    expect(a.error()).toMatchObject(ABORTED);
    gate.resolve();
    await drained();
    expect(wire.sends('/a')).toBe(0);
  });

  it('a request already sent is not recalled: its answer is the caller’s', async () => {
    const { conn, wire } = await connected();
    const held = wire.hold('/a');
    const controller = new AbortController();

    const a = conn.makeAdtRequest(request('/a', 'POST', controller.signal));
    await drained();
    controller.abort();
    held.resolve(ok('<done/>'));

    await expect(a).resolves.toMatchObject({ status: 200, data: '<done/>' });
    expect(wire.sends('/a')).toBe(1);
  });

  it('the abort words carry nothing of the request', async () => {
    const { conn } = await connected();
    const controller = new AbortController();
    controller.abort('secret-reason');

    const error = await conn
      .makeAdtRequest(
        request('/sap/bc/adt/secret-path?x=1', 'POST', controller.signal),
      )
      .catch((e: unknown) => e as Error);
    expect(error).toMatchObject(ABORTED);
    expect(String((error as Error).message)).not.toContain('secret');
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });
});
