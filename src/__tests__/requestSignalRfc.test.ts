/**
 * The request's signal at every send boundary, over RFC — through the
 * conversation seam, no SDK.
 *
 * Over RFC a non-stateful call logs on and opens a conversation of its own:
 * the kept one (reset after each call) when it is free, a throwaway one when
 * it is busy. Both logons are waits of the caller: an abort ends them for that
 * caller only, the conversation opened for it alone is closed when its open
 * answers, and nothing of it is called.
 */
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import {
  ABORTED,
  afterMicrotasks,
  rfcAnswer as answer,
  rfcConfig as config,
  rfcConversations as conversations,
  deferred,
  drained,
  gatedProvider,
  watched,
} from './helpers/requestSignal.js';

async function connected() {
  const provider = gatedProvider();
  const rfc = conversations();
  const errors: unknown[] = [];
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (...args: unknown[]) => {
      errors.push(args);
    },
  };
  const conn = new AdtOnPremConnector(config, provider, rfc.transport, logger);
  await conn.connect();
  return { conn, provider, rfc, errors };
}

const request = (url: string, method: string, signal?: AbortSignal) => ({
  url,
  method,
  timeout: 5000,
  ...(signal ? { signal } : {}),
});

describe('RFC: the request signal at every send boundary', () => {
  it('before the first send: no logon, no conversation, nothing called', async () => {
    const { conn, provider, rfc } = await connected();
    const controller = new AbortController();
    controller.abort();
    const logons = provider.counts.establish;

    const a = conn.makeAdtRequest(request('/a', 'PUT', controller.signal));
    await expect(a).rejects.toMatchObject(ABORTED);
    expect(provider.counts.establish).toBe(logons);
    expect(rfc.opened).toHaveLength(1);

    await expect(
      conn.makeAdtRequest(request('/b', 'PUT')),
    ).resolves.toMatchObject({ status: 200 });
    expect(rfc.called('/a')).toBe(0);
  });

  it("after authorize(): the caller's wait ends at the abort, the shared one runs on", async () => {
    const { conn, provider, rfc } = await connected();
    const gate = deferred();
    provider.gates.authorize = gate.promise;
    const controller = new AbortController();

    const a = watched(
      conn.makeAdtRequest(request('/a', 'PUT', controller.signal)),
    );
    const b = conn.makeAdtRequest(request('/b', 'PUT'));
    await drained();
    controller.abort();
    await drained();
    expect(a.state()).toBe('rejected');
    expect(a.error()).toMatchObject(ABORTED);

    gate.resolve();
    await expect(b).resolves.toMatchObject({ status: 200 });
    expect(rfc.called('/a')).toBe(0);
  });

  it("after the logon (establish()): the caller's wait ends at the abort, no conversation is opened for it", async () => {
    const { conn, provider, rfc, errors } = await connected();
    const gate = deferred();
    provider.gates.establish = gate.promise;
    const controller = new AbortController();

    // A takes the kept conversation's logon, B a throwaway one's: both wait
    // on the one logon gate.
    const a = watched(
      conn.makeAdtRequest(request('/a', 'PUT', controller.signal)),
    );
    const b = conn.makeAdtRequest(request('/b', 'PUT'));
    await drained();
    expect(provider.counts.establish).toBe(3);

    controller.abort();
    await drained();
    expect(a.state()).toBe('rejected');
    expect(a.error()).toMatchObject(ABORTED);

    gate.resolve();
    await expect(b).resolves.toMatchObject({ status: 200 });
    await drained();
    // The stateful conversation and B's: none was opened for A.
    expect(rfc.opened).toHaveLength(2);
    expect(rfc.called('/a')).toBe(0);
    // An abort is the caller's answer, not a failed request to recover from.
    expect(errors).toEqual([]);
  });

  it('after open(), a throwaway conversation: the wait ends at the abort, and the conversation is closed', async () => {
    const { conn, rfc } = await connected();
    // B takes the kept conversation and is held in its call.
    rfc.openAtOnce();
    const bCall = rfc.holdCall('/b');
    const b = conn.makeAdtRequest(request('/b', 'PUT'));
    await drained();

    // A, the kept one busy, opens a throwaway one, held in its open.
    const aOpen = rfc.holdOpen();
    const controller = new AbortController();
    const a = watched(
      conn.makeAdtRequest(request('/a', 'PUT', controller.signal)),
    );
    await drained();
    expect(rfc.opened).toHaveLength(3);

    controller.abort();
    await drained();
    expect(a.state()).toBe('rejected');
    expect(a.error()).toMatchObject(ABORTED);

    // Its open answers late: the conversation opened for A alone is closed.
    aOpen.resolve();
    await drained();
    const aConversation = rfc.opened[2];
    expect(aConversation.closes).toBe(1);
    expect(aConversation.called).toEqual([]);

    bCall.resolve(answer(200));
    await expect(b).resolves.toMatchObject({ status: 200 });
    expect(rfc.called('/a')).toBe(0);
  });

  it('after open(), the kept conversation: the wait ends at the abort, and it is closed, not kept', async () => {
    const { conn, rfc } = await connected();
    // A takes the kept conversation's open, held; B, in flight beside it,
    // takes a throwaway one.
    const aOpen = rfc.holdOpen();
    rfc.openAtOnce();
    const controller = new AbortController();
    const a = watched(
      conn.makeAdtRequest(request('/a', 'PUT', controller.signal)),
    );
    await drained();
    expect(rfc.opened).toHaveLength(2);
    const b = conn.makeAdtRequest(request('/b', 'PUT'));

    controller.abort();
    await drained();
    expect(a.state()).toBe('rejected');
    expect(a.error()).toMatchObject(ABORTED);
    await expect(b).resolves.toMatchObject({ status: 200 });

    aOpen.resolve();
    await drained();
    const aConversation = rfc.opened[1];
    expect(aConversation.closes).toBe(1);
    expect(aConversation.called).toEqual([]);
    expect(rfc.opened[2].called).toEqual(['/b']);
  });

  it('before rejected(): an answer that came back after the abort asks the provider nothing', async () => {
    const { conn, provider, rfc } = await connected();
    rfc.openAtOnce();
    const held = rfc.holdCall('/a');
    const controller = new AbortController();

    const a = conn.makeAdtRequest(request('/a', 'PUT', controller.signal));
    await drained();
    const b = conn.makeAdtRequest(request('/b', 'PUT'));
    controller.abort();
    held.resolve(answer(401, ''));

    await expect(a).rejects.toMatchObject(ABORTED);
    await expect(b).resolves.toMatchObject({ status: 200 });
    expect(provider.counts.rejected).toBe(0);
    expect(rfc.called('/a')).toBe(1);
  });

  it("after rejected(): the caller's wait ends at the abort, the shared renewal runs on", async () => {
    const { conn, provider, rfc } = await connected();
    rfc.answerCall('/a', answer(401, ''));
    rfc.answerCall('/b', answer(401, ''));
    const gate = deferred();
    provider.gates.rejected = gate.promise;
    const controller = new AbortController();

    const a = watched(
      conn.makeAdtRequest(request('/a', 'PUT', controller.signal)),
    );
    const b = conn.makeAdtRequest(request('/b', 'PUT'));
    await drained();
    await drained();
    expect(provider.counts.rejected).toBe(2);

    controller.abort();
    await drained();
    expect(a.state()).toBe('rejected');
    expect(a.error()).toMatchObject(ABORTED);

    gate.resolve();
    await expect(b).resolves.toMatchObject({ status: 200 });
    await drained();
    expect(rfc.called('/b')).toBe(2);
    expect(rfc.called('/a')).toBe(1);
  });
  it('an abort in any turn after open() answered: the mutation is not called once aborted, its conversation closed', async () => {
    const lateCalls: number[] = [];
    for (let hops = 0; hops <= 60; hops += 1) {
      const controller = new AbortController();
      const provider = gatedProvider();
      const rfc = conversations((uri) => {
        if (uri === '/a' && controller.signal.aborted) lateCalls.push(hops);
      });
      const conn = new AdtOnPremConnector(
        config,
        provider,
        rfc.transport,
        null,
      );
      await conn.connect();
      // B holds the kept conversation in its call; A opens a throwaway one.
      rfc.openAtOnce();
      const bCall = rfc.holdCall('/b');
      const b = conn.makeAdtRequest(request('/b', 'PUT'));
      await drained();
      const aOpen = rfc.holdOpen();
      const a = conn
        .makeAdtRequest(request('/a', 'PUT', controller.signal))
        .catch((error: unknown) => error);
      await drained();

      aOpen.resolve();
      await afterMicrotasks(hops);
      controller.abort();
      const outcome = await a;
      bCall.resolve(answer(200));
      await expect(b).resolves.toMatchObject({ status: 200 });
      await drained();
      const aConversation = rfc.opened[2];
      if (rfc.called('/a') === 0) expect(outcome).toMatchObject(ABORTED);
      // Opened for A alone: closed whether A was called or not.
      expect(aConversation.closes).toBe(1);
    }
    expect(lateCalls).toEqual([]);
  });
});
