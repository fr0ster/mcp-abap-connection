/**
 * Owns the session lifecycle: what state the session is in, who may use it, and
 * when it is safe to tear it down.
 *
 * Deliberately knows nothing about SAP, HTTP, RFC, cookies or ADT. Identities
 * are opaque maps of name → value that someone else computed; windows are
 * opaque labels. That is what makes this unit testable without a server, and it
 * is where the hard part of the design lives: ordering, admission, deadlines.
 *
 * Design: docs/superpowers/specs/2026-07-27-session-lifecycle-design.md in
 * @mcp-abap-adt/adt-clients.
 */

/** Opaque handle for one open lock window: `Symbol(label)`. */
export type WindowToken = symbol;

export type TransitionKind = 'connect' | 'disconnect' | 'recover' | 'cleanup';

export interface RequestLease {
  /** Teardown epoch at admission — the baseline a recovery compares against. */
  readonly epoch: number;
  /** Call once the request settles. Safe to call twice. */
  release(): void;
}

export interface DrainResult {
  /** Labels of windows still open when the wait gave up, deduplicated. */
  abandonedWindows: string[];
}

export interface BeginTeardownOptions {
  /** Decides the epoch: a caller's request cancels recoveries, an internal one must not. */
  origin: 'caller' | 'internal';
  /** Decides admission: a lost session cannot let an open window finish. */
  sessionLost: boolean;
}

export const ADT_SESSION_ERROR = {
  NOT_CONNECTED: 'ADT_NOT_CONNECTED',
  SESSION_REPLACED: 'ADT_SESSION_REPLACED',
  RELEASE_PENDING: 'ADT_RELEASE_PENDING',
} as const;

export type AdtSessionErrorCode =
  (typeof ADT_SESSION_ERROR)[keyof typeof ADT_SESSION_ERROR];

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

export interface SessionLifecycleOptions {
  /** Ceiling for the window wait, from the moment a teardown is requested. */
  ceilingMs?: number;
  /** Injected clock, so tests need no real time. */
  now?: () => number;
}

interface WindowEntry {
  label: string;
  /** Given up on: still open, but no longer waited for. */
  abandoned: boolean;
}

export class SessionLifecycle {
  private state: 'connected' | 'disconnected' = 'disconnected';
  private fingerprint = new Map<string, string>();
  private epoch = 0;

  private teardownPending = false;
  private teardownLostSession = false;
  private teardownAt: number | null = null;
  /** Set at expiry: admission is shut regardless of open windows. */
  private admissionForcedShut = false;

  private readonly windows = new Map<WindowToken, WindowEntry>();
  private inFlight = 0;

  private tail: Promise<unknown> = Promise.resolve();
  private tailKind: TransitionKind | null = null;
  private tailPromise: Promise<void> | null = null;

  private waiters: Array<() => void> = [];

  private readonly ceilingMs: number;
  private readonly now: () => number;

  constructor(options: SessionLifecycleOptions = {}) {
    this.ceilingMs = options.ceilingMs ?? 600_000;
    this.now = options.now ?? (() => Date.now());
  }

  // ---------------------------------------------------------------- state ---

  /**
   * Whether a caller may start work. False throughout a teardown, including
   * while a grandfathered window is still finishing: finishing is not starting.
   */
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

  /** One entry per open window, abandoned ones included. */
  get openWindows(): readonly string[] {
    return [...this.windows.values()].map((w) => w.label);
  }

  /**
   * Publishes a freshly established session, which also ENDS any teardown that
   * was pending: the flags describe the session being torn down, and this is a
   * different one. Without this, `connect()` after `disconnect()` — which the
   * design allows explicitly — leaves the lifecycle permanently unusable.
   *
   * Windows are dropped for the same reason: they belonged to the old session,
   * nothing here can close them, and a teardown that gave up on them has
   * already carried their labels out in its report. Keeping them would make
   * every future drain re-report locks from a session that no longer exists.
   */
  markConnected(fingerprint: ReadonlyMap<string, string> = new Map()): void {
    this.state = 'connected';
    this.fingerprint = new Map(fingerprint);
    this.teardownPending = false;
    this.teardownLostSession = false;
    this.admissionForcedShut = false;
    this.teardownAt = null;
    this.windows.clear();
    this.wake();
  }

  markDisconnected(): void {
    this.state = 'disconnected';
    this.fingerprint.clear();
    this.wake();
  }

  /**
   * Classifies a freshly observed fingerprint.
   *
   * Additive: a name appearing where none was tracked is `established`, never
   * `replaced` — otherwise the identifier a LOCK response adds would read as a
   * new session and blow up the window it just opened.
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

  /** True while an already-open window is allowed to finish its work. */
  private get finishingWindowOpen(): boolean {
    return (
      this.teardownPending &&
      !this.teardownLostSession &&
      !this.admissionForcedShut &&
      this.windows.size > 0
    );
  }

  private get admits(): boolean {
    if (this.state !== 'connected') return false;
    if (!this.teardownPending) return true;
    return this.finishingWindowOpen;
  }

  assertUsable(): void {
    if (!this.admits) {
      throw sessionError(ADT_SESSION_ERROR.NOT_CONNECTED);
    }
  }

  /** Asserts usability and counts the request in, in one synchronous step. */
  admitRequest(): RequestLease {
    this.assertUsable();
    this.inFlight += 1;
    const epoch = this.epoch;
    let released = false;
    return {
      epoch,
      release: () => {
        if (released) return;
        released = true;
        this.inFlight -= 1;
        this.wake();
      },
    };
  }

  // -------------------------------------------------------------- windows ---

  /**
   * A lock outlives the request that takes it, so it is the one thing a pending
   * teardown refuses outright.
   */
  beginWindow(label: string): WindowToken {
    if (this.state !== 'connected' || this.teardownPending) {
      throw sessionError(ADT_SESSION_ERROR.NOT_CONNECTED);
    }
    const token = Symbol(label);
    this.windows.set(token, { label, abandoned: false });
    return token;
  }

  /** A token matching no open window is ignored: double close, foreign token. */
  endWindow(token: WindowToken): void {
    if (!this.windows.delete(token)) return;
    this.wake();
  }

  // ------------------------------------------------------------- teardown ---

  beginTeardown({ origin, sessionLost }: BeginTeardownOptions): void {
    if (!this.teardownPending) {
      this.teardownAt = this.now();
    }
    this.teardownPending = true;
    if (origin === 'caller') {
      this.epoch += 1;
    }
    if (sessionLost) {
      this.teardownLostSession = true;
      // Nothing can finish over a session that is gone: give up on every window
      // now, and drop the identity so a later comparison sees the change.
      for (const entry of this.windows.values()) entry.abandoned = true;
      this.fingerprint.clear();
    }
    this.wake();
  }

  get teardownRequested(): boolean {
    return this.teardownPending;
  }

  /**
   * Resolves when nothing is in flight and no window is still worth waiting
   * for. Bounded by the ceiling measured from the teardown request — absolute,
   * never extended by request activity.
   *
   * On expiry, before resolving and without yielding in between: shuts
   * admission, gives up on the remaining windows, then waits once more for the
   * already-admitted requests to settle.
   */
  async drain(): Promise<DrainResult> {
    // `??`, not `||`: a teardown requested at timestamp 0 is a real teardown,
    // and treating it as absent would restart the ceiling from drain() — making
    // the deadline relative to the wrong event, which is the sliding behaviour
    // this design rejects.
    const deadline = (this.teardownAt ?? this.now()) + this.ceilingMs;

    while (this.inFlight > 0 || this.liveWindows > 0) {
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      await this.changed(remaining);
    }

    if (this.inFlight === 0 && this.liveWindows === 0) {
      return { abandonedWindows: this.abandonedLabels() };
    }

    // Expiry. Synchronous, before any await: no request may enter after this.
    this.admissionForcedShut = true;
    for (const entry of this.windows.values()) entry.abandoned = true;

    while (this.inFlight > 0) {
      await this.changed();
    }
    return { abandonedWindows: this.abandonedLabels() };
  }

  private get liveWindows(): number {
    let live = 0;
    for (const entry of this.windows.values()) if (!entry.abandoned) live += 1;
    return live;
  }

  private abandonedLabels(): string[] {
    const labels = new Set<string>();
    for (const entry of this.windows.values()) {
      if (entry.abandoned) labels.add(entry.label);
    }
    return [...labels];
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
   * internal cleanup owes its result to nobody while a caller's teardown owes a
   * report.
   */
  transition(kind: TransitionKind, run: () => Promise<void>): Promise<void> {
    const joinable = kind === 'connect' || kind === 'disconnect';
    if (joinable && this.tailKind === kind && this.tailPromise) {
      return this.tailPromise;
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

  // ----------------------------------------------------------- internals ---

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  private changed(timeoutMs?: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      this.waiters.push(finish);
      if (timeoutMs !== undefined) {
        const timer = setTimeout(finish, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }
    });
  }
}
