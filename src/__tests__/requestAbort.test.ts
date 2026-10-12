/**
 * The race every wait of a request runs against its signal.
 */
import {
  isRequestAborted,
  requestAborted,
  throwIfAborted,
  untilAborted,
} from '../connection/requestAbort.js';
import {
  ABORTED,
  deferred,
  drained,
  watched,
} from './helpers/requestSignal.js';

describe('untilAborted', () => {
  it('without a signal is the work itself', async () => {
    const work = Promise.resolve(1);
    expect(untilAborted(undefined, work)).toBe(work);
  });

  it('settles as the work does while the signal has not fired', async () => {
    const controller = new AbortController();
    await expect(
      untilAborted(controller.signal, Promise.resolve('done')),
    ).resolves.toBe('done');
    const failure = new Error('the work failed');
    await expect(
      untilAborted(controller.signal, Promise.reject(failure)),
    ).rejects.toBe(failure);
  });

  it('rejects at the abort while the work is still pending', async () => {
    const controller = new AbortController();
    const work = deferred<string>();
    const raced = watched(untilAborted(controller.signal, work.promise));
    await drained();
    expect(raced.state()).toBe('pending');
    controller.abort();
    await drained();
    expect(raced.state()).toBe('rejected');
    expect(raced.error()).toMatchObject(ABORTED);
    work.resolve('late');
  });

  it('rejects at once when the signal fired before the wait began', async () => {
    const controller = new AbortController();
    controller.abort();
    const work = deferred<string>();
    const raced = watched(untilAborted(controller.signal, work.promise));
    await drained();
    expect(raced.state()).toBe('rejected');
    expect(raced.error()).toMatchObject(ABORTED);
    work.resolve('late');
  });
});

describe('the abort error', () => {
  it('is in fixed words, with the contract code, and recognised by it', () => {
    const error = requestAborted();
    expect(error).toMatchObject(ABORTED);
    expect(error).toBeInstanceOf(Error);
    expect(isRequestAborted(error)).toBe(true);
    expect(isRequestAborted(new Error(ABORTED.message))).toBe(false);
    expect(isRequestAborted(null)).toBe(false);
  });

  it('is thrown at a boundary only once the signal fired', () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(undefined)).not.toThrow();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow(
      expect.objectContaining(ABORTED),
    );
  });
});
