/**
 * Owns the session lifecycle: what state the session is in, who may use it, and
 * when it stops being current.
 *
 * Deliberately knows nothing about SAP, HTTP, RFC, cookies or ADT. Identities
 * are opaque maps of name → value that someone else computed. That is what makes
 * this unit testable without a server, and it is where the hard part lives:
 * ordering, admission, and telling one session from the next.
 *
 * Design: docs/superpowers/specs/2026-07-31-teardown-policy-design.md in
 * @mcp-abap-adt/adt-clients.
 */

import {
  ADT_SESSION_ERROR,
  type AdtSessionErrorCode,
} from '@mcp-abap-adt/interfaces';

export type TransitionKind = 'connect' | 'disconnect' | 'recover' | 'cleanup';

export interface RequestLease {
  /** Teardown epoch at admission — the baseline a recovery compares against. */
  readonly epoch: number;
  /**
   * Session generation at admission — the baseline a RESPONSE compares against
   * before touching shared state. Distinct from `epoch` on purpose: see
   * `sessionGeneration`.
   */
  readonly generation: number;
  /** Call once the request settles. Safe to call twice. */
  release(): void;
}

export interface BeginTeardownOptions {
  /** Decides the epoch: a caller's request cancels recoveries, an internal one must not. */
  origin: 'caller' | 'internal';
  /** A lost session cannot be spoken to again; its identity is dropped at once. */
  sessionLost: boolean;
}

export function sessionError(
  code: AdtSessionErrorCode,
  message?: string,
): Error & { code: AdtSessionErrorCode } {
  const error = new Error(message ?? code) as Error & {
    code: AdtSessionErrorCode;
  };
  error.code = code;
  return error;
}

export class SessionLifecycle {
  private state: 'connected' | 'disconnected' = 'disconnected';
  private fingerprint = new Map<string, string>();
  private epoch = 0;
  private generation = 0;

  private teardownPending = false;
  private inFlight = 0;

  private tail: Promise<unknown> = Promise.resolve();
  private tailKind: TransitionKind | null = null;
  private tailPromise: Promise<unknown> | null = null;

  // ---------------------------------------------------------------- state ---

  /** Whether a caller may start work. False throughout a pending teardown. */
  get connected(): boolean {
    return this.state === 'connected' && !this.teardownPending;
  }

  /** Derived from the tracked fingerprint; null when nothing is tracked. */
  get identity(): string | null {
    if (this.fingerprint.size === 0) return null;
    return [...this.fingerprint.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  get teardownEpoch(): number {
    return this.epoch;
  }

  /**
   * Which session is current, counted from zero.
   *
   * Two counters answer two different questions, and one cannot do both:
   *
   * - `epoch` — did the CALLER ask to stop? It moves only on a caller-initiated
   *   teardown, because a recovery must not cancel itself.
   * - `generation` — is this still the session you were issued against? It moves
   *   on every change of which session is current, however caused.
   *
   * A fence built on `epoch` misses every internal teardown: after a session
   * loss and a successful recovery, requests from the dead session carry the
   * same epoch as the new one and sail straight through.
   */
  get sessionGeneration(): number {
    return this.generation;
  }

  /**
   * Publishes a freshly established session, which also ENDS any teardown that
   * was pending: the flags describe the session being torn down, and this is a
   * different one. Without this, `connect()` after `disconnect()` — which the
   * design allows explicitly — leaves the lifecycle permanently unusable.
   */
  markConnected(fingerprint: ReadonlyMap<string, string> = new Map()): void {
    this.state = 'connected';
    this.fingerprint = new Map(fingerprint);
    this.teardownPending = false;
    this.generation += 1;
  }

  /**
   * Drops the tracked identity without touching state or generation.
   *
   * For a session the caller discarded ON PURPOSE — a credential renewal, a
   * cache invalidation. The next fingerprint then reads as `established` rather
   * than `replaced`, which is the truth: nothing was taken from us.
   */
  forgetIdentity(): void {
    this.fingerprint.clear();
  }

  markDisconnected(): void {
    this.state = 'disconnected';
    this.fingerprint.clear();
  }

  /**
   * Classifies a freshly observed fingerprint.
   *
   * Additive: a name appearing where none was tracked is `established`, never
   * `replaced` — otherwise the identifier a LOCK response adds would read as a
   * new session and condemn the operation it just covered.
   */
  observe(
    fingerprint: ReadonlyMap<string, string>,
  ): 'unchanged' | 'established' | 'replaced' {
    let established = false;
    for (const [name, value] of fingerprint) {
      const known = this.fingerprint.get(name);
      if (known === undefined) {
        established = true;
        this.fingerprint.set(name, value);
      } else if (known !== value) {
        this.fingerprint.set(name, value);
        return 'replaced';
      }
    }
    return established ? 'established' : 'unchanged';
  }

  // ------------------------------------------------------------ admission ---

  assertUsable(): void {
    if (this.state !== 'connected' || this.teardownPending) {
      throw sessionError(ADT_SESSION_ERROR.NOT_CONNECTED);
    }
  }

  /** Asserts usability and counts the request in, in one synchronous step. */
  admitRequest(): RequestLease {
    this.assertUsable();
    this.inFlight += 1;
    const epoch = this.epoch;
    const generation = this.generation;
    let released = false;
    return {
      epoch,
      generation,
      release: () => {
        if (released) return;
        released = true;
        this.inFlight -= 1;
      },
    };
  }

  /** How many admitted requests have not settled. Diagnostics only — nothing waits on it. */
  get requestsInFlight(): number {
    return this.inFlight;
  }

  /**
   * Whether a lease may still touch shared state.
   *
   * A request outliving its session is ordinary now that a teardown does not
   * wait: its response must not write cookies over a newer session's, and must
   * not be read as a replacement — which would raise a session-lost teardown
   * against a session that is perfectly healthy.
   */
  isCurrent(lease: Pick<RequestLease, 'generation'>): boolean {
    return lease.generation === this.generation;
  }

  // ------------------------------------------------------------- teardown ---

  beginTeardown({ origin, sessionLost }: BeginTeardownOptions): void {
    this.teardownPending = true;
    if (origin === 'caller') {
      this.epoch += 1;
    }
    // The moment a session stops being current is the moment leases against it
    // go stale — whether or not a replacement exists yet. Counting only at
    // markConnected() leaves the gap between a teardown and the next connect,
    // where a late response would write into state just cleared.
    this.generation += 1;
    if (sessionLost) {
      this.fingerprint.clear();
    }
  }

  get teardownRequested(): boolean {
    return this.teardownPending;
  }

  // ---------------------------------------------------------- transitions ---

  /**
   * Runs a transition on the serializing tail.
   *
   * `connect` and `disconnect` join the tail of their own kind — two callers
   * wanting the same thing get one execution and the same answer — but only
   * when nothing is queued behind it, so a join can never overtake a queued
   * transition of another kind. `recover` and `cleanup` never join and are
   * never joined: a recovery carries its own request's baseline, and an
   * internal cleanup owes its result to nobody.
   */
  transition<T>(kind: TransitionKind, run: () => Promise<T>): Promise<T> {
    const joinable = kind === 'connect' || kind === 'disconnect';
    if (joinable && this.tailKind === kind && this.tailPromise) {
      return this.tailPromise as Promise<T>;
    }

    const queued = this.tail.then(run, run);
    this.tail = queued.then(
      () => undefined,
      () => undefined,
    );
    this.tailKind = kind;
    this.tailPromise = queued;

    const settle = () => {
      if (this.tailPromise === queued) {
        this.tailKind = null;
        this.tailPromise = null;
      }
    };
    queued.then(settle, settle);
    return queued;
  }
}
