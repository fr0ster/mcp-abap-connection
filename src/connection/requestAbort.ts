/**
 * What a request's signal does to it: the error it ends with, the check made
 * at each send boundary, and the race each of its waits runs against it.
 *
 * The signal belongs to ONE caller. A wait it ends — the provider's
 * `authorize()` or `rejected()`, a logon, a conversation's `open()` — ends for
 * that caller only: the work behind it runs on, because another caller may be
 * waiting on the very same work (a provider shares one renewal among all who
 * ask). Its late answer is handled here and dropped, never left unhandled.
 *
 * A request already sent is not recalled: nothing here reaches into the wire.
 */
import {
  ADT_REQUEST_ERROR,
  type AdtRequestErrorCode,
} from '@mcp-abap-adt/interfaces-adt-connection';

/**
 * Fixed words: nothing of the request, the signal's reason or anything a
 * server said reaches them.
 */
const ABORTED_WORDS =
  'The request was aborted by its caller; nothing more of it was sent.';

export type RequestAbortedError = Error & { code: AdtRequestErrorCode };

/** The error an aborted request rejects with: `ADT_REQUEST_ERROR.ABORTED`. */
export function requestAborted(): RequestAbortedError {
  const error = new Error(ABORTED_WORDS) as RequestAbortedError;
  error.name = 'AdtRequestAbortedError';
  error.code = ADT_REQUEST_ERROR.ABORTED;
  return error;
}

/** Whether an error is a request's abort. Read structurally, by its code. */
export function isRequestAborted(error: unknown): boolean {
  return (
    (error as { code?: unknown } | null | undefined)?.code ===
    ADT_REQUEST_ERROR.ABORTED
  );
}

/** A send boundary: an aborted request goes no further. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw requestAborted();
}

/**
 * One wait of a request, raced against its signal.
 *
 * Settles as `work` does, or rejects with the abort the moment the signal
 * fires — at once when it already has. `work` is never cancelled: it runs on
 * for whoever else waits on it, and what it answers after the abort is
 * handled and dropped. Without a signal, `work` itself.
 */
export function untilAborted<T>(
  signal: AbortSignal | undefined,
  work: Promise<T>,
): Promise<T> {
  if (!signal) return work;
  // Handled before anything else can happen: an answer that arrives after
  // the abort is nobody's, and must not surface as an unhandled rejection.
  work.catch(() => {});
  if (signal.aborted) return Promise.reject(requestAborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(requestAborted());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
