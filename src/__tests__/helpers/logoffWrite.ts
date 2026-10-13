/**
 * What a real request reports and an axios double does not: that its bytes
 * left.
 *
 * `disconnect()` resolves once the logoff is written — the node request's
 * `finish`, which the wire listens for on the request its `logoffRequest`
 * opens. A double that replaces the axios instance never opens one, so a
 * logoff it holds would hold `disconnect()` too, as an unwritten one should.
 * A double that has RECEIVED the logoff has, by that, had it written: this
 * plays that part, and nothing else of the request.
 */
import { EventEmitter } from 'node:events';

/** Make the wire open a request object a double can report on. */
export function reportableLogoff(transport: unknown): void {
  (transport as { logoffRequest: unknown }).logoffRequest = () =>
    new EventEmitter();
}

/**
 * Called by an axios double for every request it receives: a logoff, which
 * carries the wire's `transport`, is reported written.
 */
export function wroteIt(config: {
  transport?: { request: (options: object, onResponse: () => void) => unknown };
}): void {
  const outgoing = config.transport?.request({}, () => {});
  if (outgoing instanceof EventEmitter) outgoing.emit('finish');
}
