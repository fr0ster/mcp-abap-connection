# JWT error classification: stop reporting a 403 as an expired token

**Status:** specified, 2026-08-16. Not implemented. Issue
[#30](https://github.com/fr0ster/mcp-abap-connection/issues/30).

**Scope:** `src/connection/JwtAbapConnection.ts`, its tests, and the documentation that describes
its refresh behaviour (`README.md`, `examples/`). No public API changes to the connection
interface, no version decision taken here.

## The defect

`JwtAbapConnection` catches 401 **and** 403, and when it cannot fix them by refreshing the token
it throws:

```ts
throw new Error('JWT token has expired. Please re-authenticate.');
```

at three places — `establishSession` (line 130), `makeAdtRequest` (line 201) and
`fetchCsrfToken` (line 250). The original `AxiosError` is discarded: the replacement carries no
`response`, no status, no body.

Each site has an escape hatch meant to let permission failures through untouched:

```ts
if (
  responseText.includes('ExceptionResourceNoAccess') ||
  responseText.includes('No authorization') ||
  responseText.includes('Missing authorization')
) {
  throw error;
}
```

**It does not fire for the error SAP actually sends.** Captured against a cloud trial:

```xml
<exc:exception xmlns:exc="...">
  <type id="ExceptionResourceNoAuthorization"/>
  <message lang="EN">You are not authorized to make changes (authorization object S_DEVELOP)</message>
</exc:exception>
```

| pattern | matches this body? |
|---|---|
| `ExceptionResourceNoAccess` | **no** — the type is `ExceptionResourceNoAuthorization`, a different word |
| `No authorization` | **no** — the message says "not authorized" |
| `Missing authorization` | **no** |

So an authorization failure falls through to the refresh path, then to the synthesised message.

### How it was found, which is the part that matters

Not by reading the code. An ATC probe against a cloud trial reported `PROG/P` and `PROG/I` as
`JWT token has expired` on three consecutive runs — **while the same connection was answering
`GET /sap/bc/adt/atc/customizing` with 200 in the same session.** The token was demonstrably
alive. It took going around the connector with plain axios, on the same credential, to see the
403 and the `S_DEVELOP` message.

That is the real cost. The message is not merely inaccurate; it is confidently wrong about a
different subsystem, and it sends whoever reads it to re-authenticate — the one thing that
cannot help. A caller cannot recover the truth, because the status and body are gone.

### The second defect: the three handlers nest, so nobody owns recovery

The three sites are not alternatives. They call each other, and **every one of them refreshes**:

```
makeAdtRequest
 └─ super.makeAdtRequest
     └─ this.fetchCsrfToken(url, 5, 2000, lease.generation)   ← override, refreshes  (1)
 └─ catch 401 → tryRefreshToken()                             ← refreshes            (2)
     └─ recoverSession → establishAndCommit → establishSession
         └─ this.fetchCsrfToken                               ← override, refreshes  (3)
         └─ catch 401 → tryRefreshToken()                     ← refreshes            (4)
             └─ return this.establishSession()                ← recurses to (3)
```

`AbstractAbapConnection` calls `this.fetchCsrfToken` at lines 814, 874 and 1302 — `this`, so the
JWT override — which is why a single `makeAdtRequest` reaches three refreshing handlers before
any recursion. And `establishSession` recursing into itself (line 127) multiplies the whole
subtree without bound, because `tryRefreshToken()` returns `true` whenever `refreshToken()`
**resolves**, not when the new token works.

An attempt counter on `establishSession` alone would remove the infinite case and still leave
four refreshes for one request. Raised in review, 2026-08-16 — an earlier draft of this spec
proposed exactly that counter while claiming "refresh at most once", which is a stronger
guarantee than the construction delivered.

### The third defect, found while mapping the second

The override **silently drops an argument**:

```ts
// AbstractAbapConnection
protected async fetchCsrfToken(url, retryCount, retryDelay, generation?)
//                              ↑ "Fences the response effects" — line 814 passes lease.generation

// JwtAbapConnection — three parameters, and super called with three
protected async fetchCsrfToken(url, retryCount = 3, retryDelay = 1000)
```

So on **every JWT connection** the lease fence is discarded. TypeScript does not object: a method
with fewer parameters is assignable to one with more. Nothing about this is JWT-specific and
nothing about it is intended — it is the kind of thing a rewrite of this method either fixes or
cements, so it is in scope.

(The override also hardcodes `3` and `1000` where the base reads `CSRF_CONFIG.RETRY_COUNT` and
`.RETRY_DELAY`. Same values today, so no behaviour change — but it is a second copy of a
constant, and it goes with the rest.)

## What the fix must achieve

Three properties, in priority order. The first alone would close the issue; the rest are what
stop it recurring in another form.

1. **The original error survives.** Whatever the classification, a caller must still be able to
   read `error.response.status` and the server's message. A connector may add context; it must
   never subtract the status and body.
2. **A 403 is not treated as an expired credential.** An expired bearer token is a 401 from the
   resource server. 403 is the server saying "authenticated, and still no".
3. **Retries are bounded across nesting, not per handler** — one network refresh per
   caller-visible operation, and no unbounded recursion.

### Why not just extend the substring list

Adding `ExceptionResourceNoAuthorization` would fix today's case and leave the mechanism intact:
a list of English prose fragments and SAP-internal type names, matched case-sensitively, deciding
whether an error is transient. The next unlisted message is the same bug. The list is the defect,
not its contents.

If a body check survives at all it should match the *type*, and be indifferent to prose:

```ts
const permanent =
  /Exception\w*No(Access|Authorization)/.test(responseText) ||
  /\b(not authorized|no authorization|missing authorization)\b/i.test(responseText);
```

But under property 2 it is largely redundant — those bodies arrive with 403, which no longer
enters the refresh path.

## The design

### Classification

```ts
/**
 * Is this worth refreshing a token for?
 *
 * 401 only. 403 means the server authenticated the caller and refused the
 * action anyway — a new token is the same caller.
 */
function isTokenExpiryCandidate(error: unknown): error is AxiosError {
  return error instanceof AxiosError && error.response?.status === 401;
}
```

A 403 stops entering the refresh path at all, so it propagates as itself, with status and body
intact, and the escape-hatch list disappears with it.

**One risk, stated rather than assumed away.** Some BTP setups answer an invalid token with 403
rather than 401. Nothing captured here shows that, and the trial's expired-token behaviour has
not been observed end to end. Property 1 is what makes this safe to get wrong: if a 403 really
was a token problem, the caller now receives the server's own 403 and message instead of a
misleading one — strictly better than today, even in the case this design does not anticipate.
The plan carries a task to capture a genuinely expired token's status before release, and if it
turns out to be 403, the classifier widens to "403 **and** a body that does not look like an
authorization refusal" — which is when the type-matching regex above earns its place.

### Never synthesise

Every `throw new Error('JWT token has expired…')` goes. When a refresh does not resolve a 401,
the original error is rethrown:

```ts
if (await this.tryRefreshToken()) {
  /* … retry … */
}
// The refresh did not help. The server's answer is the truth about why.
throw error;
```

The message is not lost — it moves to a log line, which is where an explanation belongs:

```ts
this.logger?.error(
  '[ERROR] JwtAbapConnection - 401 persists after token refresh; the credential may need re-authentication',
);
```

A caller that wants to present "please re-authenticate" can do so from `status === 401`, which it
can now see.

### One owner of recovery

**The guarantee: at most one network token refresh per caller-visible operation, whatever the
nesting depth.** Not "one per handler" — that is what the code does now, and it is how a single
`makeAdtRequest` reaches four.

Two changes together give it.

**1. `establishSession` stops refreshing, and stops recursing.** Its `try` wraps
`this.fetchCsrfToken` and nothing else, so the only 401 it can see is one `fetchCsrfToken` has
already handled — it refreshed, retried once, and failed again. A second refresh at this level
asks the same refresher the same question. The catch becomes: log, rethrow. The recursion goes
with it.

That leaves `fetchCsrfToken` as the sole owner of recovery during establishment, which it already
effectively is.

**2. A token generation guard, so nested levels do not each refresh.** `makeAdtRequest` still
needs its own recovery — a 401 on the ADT request itself is a mid-session expiry that
`fetchCsrfToken` never sees. But it must not refresh when a nested level just did.

The guard is a monotonic `tokenGeneration` compared against the **baseline the operation started
with**: a handler that finds the token newer than the one that failed retries with it instead of
refreshing again. The question is how the baseline reaches a handler three levels down, since
`recoverSession` sits in between and takes no such parameter.

#### Why not the two options an earlier draft left open

Both were named and neither was chosen, which is not a detail to defer — the choice decides
whether the thing is correct under concurrent requests. Raised in review, 2026-08-16.

- **An instance-level re-entrancy flag is wrong.** It is per-connection, not per-operation. Two
  concurrent `makeAdtRequest` calls share the instance, so a flag set by one suppresses a refresh
  the other genuinely needs — the token expires and the second request fails with a 401 it could
  have recovered from. It trades an over-refresh bug for an under-refresh bug, which is worse:
  the first costs round trips, the second costs correctness.
- **Threading the baseline through `recoverSession`** means changing `recoverSession`,
  `establishAndCommit` and `establishSession` in `AbstractAbapConnection` — the session lifecycle
  reworked in #29 — plus every subclass signature, for a concern only the JWT subclass has.

#### The mechanism: an operation-scoped baseline in `AsyncLocalStorage`

`node:async_hooks` carries a value across `await` boundaries and nested calls, and isolates it
between concurrent operations by construction. That is exactly the shape of the problem: the
baseline must follow one operation down three call levels without every level's signature
knowing about it, and without leaking into a sibling operation. Node `>=18` is already the
engine, and nothing else in the connection layer competes for this mechanism.

```ts
import { AsyncLocalStorage } from 'node:async_hooks';

/** What one caller-visible operation knows about the credential it started with. */
interface IRecoveryScope {
  /** `tokenGeneration` as it stood when this operation began. */
  readonly baseline: number;
  /** Cleared when the operation that opened this scope returns. */
  active: boolean;
}

/**
 * Per connection, deliberately NOT static. `baseline` is compared against
 * `this.tokenGeneration`, which is instance state — so a store shared between
 * instances would let one connection's operation hand its baseline to another
 * connection's, and the comparison would be between unrelated counters.
 */
private readonly recoveryScope = new AsyncLocalStorage<IRecoveryScope>();

/** Monotonic; incremented once per completed network refresh. */
private tokenGeneration = 0;

/**
 * Single-flight over the whole credential renewal — token fetch, session
 * discard and re-establishment. Concurrent callers join this rather than each
 * running their own teardown/recovery pair.
 */
private renewalInFlight?: Promise<boolean>;
```

**Lifecycle, in full.**

1. **Opening a scope — and the boundary is decided by the kind of entry point, not by whether a
   scope happens to be active.** The three sites are not peers: one of them starts operations and
   two of them are the levels an operation descends through.

   - **`makeAdtRequest` always opens a new scope.** It is public, so a call to it *is* a new
     caller-visible operation — including one made re-entrantly from inside another, which is not
     exotic: the connection itself invokes caller-supplied callbacks (`logger`,
     `tokenRefresher.refreshToken()`) while a scope is live, and either may issue a request.
     Inheriting there would give a genuinely independent request the outer operation's baseline,
     and **a stale baseline reads as "already refreshed"**: the inner request sees
     a completed renewal that happened for somebody else, retries with a
     token that is not the problem, and never refreshes on its own account. The failure is a
     *skipped* refresh, not a duplicated one. Separately, the outer operation can finish first
     and set `active = false` on the scope they share — after which the inner request's own
     recovery levels each see a dead scope, open one apiece, and the guarantee goes in the other
     direction. Raised in review, 2026-08-16.

     A new scope buys the inner request a **later baseline**, not a guaranteed network call. If a
     refresh is already in flight it still joins it — single-flight is about the network, scope
     is about which credential state an operation is reasoning from. The two are independent and
     an earlier draft's test conflated them.
   - **`fetchCsrfToken` and `establishSession` inherit a live scope**, because they *are* the
     recovery levels an operation descends through. Called directly with no scope active — both
     are `protected` and reachable on their own — they open one, so a bare `connect()` is still
     an operation with a baseline.

   ```ts
   /** For the public entry point: this call is its own operation, always. */
   private inNewRecoveryScope<T>(fn: () => Promise<T>): Promise<T> {
     const scope: IRecoveryScope = {
       baseline: this.tokenGeneration,
       active: true,
     };
     return this.recoveryScope.run(scope, async () => {
       try {
         return await fn();
       } finally {
         scope.active = false;
       }
     });
   }

   /** For the inner levels: join the operation in progress, or start one. */
   private inRecoveryScope<T>(fn: () => Promise<T>): Promise<T> {
     const inherited = this.recoveryScope.getStore();
     // Only a scope that is still running. A store reached through an async
     // resource that outlived its operation is stale, and its baseline describes
     // a credential state that has since moved.
     if (inherited?.active) return fn();
     return this.inNewRecoveryScope(fn);
   }
   ```

2. **What this makes of each path.** `makeAdtRequest` opens the scope; the `fetchCsrfToken` inside
   `super.makeAdtRequest` inherits it; so does the one reached through
   `recoverSession → establishSession`, because `recoverSession` runs *inside* `makeAdtRequest`'s
   scope and async context flows through it without `recoverSession` knowing.

   **The retry after a refresh calls `super.makeAdtRequest`, not `this.makeAdtRequest`** — the
   base implementation, which opens no scope. That is load-bearing rather than incidental: a
   retry is the same operation continuing, and routing it through the override would open a
   second scope with a baseline taken *after* the refresh, which is exactly the state that reads
   as "nobody has refreshed yet".

3. **Deciding — and the unit that is single-flighted is the whole renewal, not the token fetch.**

   Sharing only the token fetch leaves the expensive half racing. After joining one refresh, two
   operations would each still run their own `discardSession()` + `recoverSession()`, and
   `SessionLifecycle.transition` says plainly that **`recover` and `cleanup` never join and are
   never joined** (`SessionLifecycle.ts:228-231`) — each queues on the serializing tail. So two
   concurrent 401s produce:

   ```
   cleanup A → recover A → cleanup B → recover B
   ```

   A's recovery reaches `markConnected` and A leaves `recoverSession` to retry — while B's
   cleanup, already queued, tears the session back down. A's retry then races a teardown it
   knows nothing about and can come back `NOT_CONNECTED`, having refreshed nothing wrong.
   Raised in review, 2026-08-16, against a draft that single-flighted only `performRefresh`.

   So the shared unit is **refresh → discardSession → recoverSession**, and a joiner waits for
   all three.

   **Two primitives, layered — the token fetch is shared, the session recovery sits on top.**
   One promise cannot serve both: a token-only handler must not join `renewalInFlight`, because
   that promise discards and re-establishes the session, and a token-only handler runs *inside*
   an establishment. Joining it there would wait on the transition it is part of. But leaving the
   token fetch uncoordinated is the defect this closes — two concurrent requests can both reach a
   nested `fetchCsrfToken`, both see `tokenGeneration` unmoved, and both call the refresher, with
   `currentToken` ending up whichever finished last. `renewalInFlight` does not help there: it
   does not exist yet, since a full renewal only starts once the failure has climbed back to the
   outer `makeAdtRequest`. Raised in review, 2026-08-16.

   ```ts
   /** Single-flight over the token fetch alone. Touches no session state. */
   private tokenRefreshInFlight?: Promise<boolean>;

   private refreshTokenOnce(baseline: number): Promise<boolean> {
     // Somebody already fetched a newer one for this operation's purposes.
     if (this.tokenGeneration > baseline) return Promise.resolve(true);
     if (this.tokenRefreshInFlight) return this.tokenRefreshInFlight;
     if (!this.tokenRefresher) return Promise.resolve(false);

     const inFlight = this.performTokenRefresh().finally(() => {
       if (this.tokenRefreshInFlight === inFlight) {
         this.tokenRefreshInFlight = undefined;
       }
     });
     this.tokenRefreshInFlight = inFlight;
     return inFlight;
   }

   private async performTokenRefresh(): Promise<boolean> {
     try {
       this.currentToken = await this.tokenRefresher!.refreshToken();
       this.tokenGeneration += 1;
       return true;
     } catch (error) {
       this.logger?.error(`[ERROR] JwtAbapConnection - token refresh failed: …`);
       return false;
     }
   }
   ```

   `fetchCsrfToken` and `establishSession` call **only** `refreshTokenOnce` and retry.
   `performRenewal` calls it too, and then does the session half alone. The layering is what
   makes it deadlock-free: the token primitive never touches session state, so waiting on it from
   inside an establishment waits on a network call and nothing else.

   ```ts
   /** Single-flight over the whole credential renewal, session included. */
   private renewalInFlight?: Promise<boolean>;

   private renewCredential(
     baselineEpoch: number,
     baseline: number,
   ): Promise<boolean> {
     if (this.renewalInFlight) return this.renewalInFlight;
     // Identity-checked clear, as SessionLifecycle.transition does: a joiner
     // settling late must not clear a renewal somebody started after it.
     const inFlight = this.performRenewal(baselineEpoch, baseline).finally(() => {
       if (this.renewalInFlight === inFlight) this.renewalInFlight = undefined;
     });
     this.renewalInFlight = inFlight;
     return inFlight;
   }

   private async performRenewal(
     baselineEpoch: number,
     baseline: number,
   ): Promise<boolean> {
     // Shared with the token-only path: joins a fetch already running, and
     // returns straight away when the token is already newer than the one that
     // failed — then what is missing is the session, and a second fetch would
     // answer a question nobody asked.
     if (!(await this.refreshTokenOnce(baseline))) return false;
     // The renewed credential cannot keep the old ABAP session.
     this.discardSession();
     await this.recoverSession(baselineEpoch);
     // Only here: a session now exists that was built with this token.
     this.recoveredGeneration = this.tokenGeneration;
     return true;
   }
   ```

   **Deciding whether to renew at all**, in this order — the order is the design, not a detail:

   ```ts
   private async ensureRecovered(baselineEpoch: number): Promise<boolean> {
     // 1. A renewal in flight is joined REGARDLESS of generation. A newer token
     //    is no use while the session it belongs to is still being rebuilt:
     //    retrying now is how a caller meets a closed admission door.
     if (this.renewalInFlight) return this.renewalInFlight;

     const scope = this.recoveryScope.getStore();
     // No live scope means a caller reached a handler by a path that does not
     // open one, or through a stale async context. Either way, treat it as its
     // own operation rather than trusting a baseline nobody is standing behind.
     const baseline = scope?.active ? scope.baseline : this.tokenGeneration;

     // 2. A full renewal COMPLETED since this operation began — token and the
     //    session built with it. Not `tokenGeneration`: see below. Retry.
     if (this.recoveredGeneration > baseline) return true;

     // 3. Nobody has. Renew, and let everyone else join.
     return this.renewCredential(baselineEpoch, baseline);
   }
   ```

   Check 1 before check 2 is what closes the window the review found: without it, a joiner that
   sees a newer generation returns "retry now" while the session is mid-rebuild.

   **Check 2 reads `recoveredGeneration`, not `tokenGeneration`, and the difference is the whole
   invariant.** A draft used `tokenGeneration` and justified it as "the session is settled as
   well as the token" — which the token-only path below makes false. `fetchCsrfToken` bumps
   `tokenGeneration` without discarding or re-establishing anything, and the base class calls it
   polymorphically from inside `super.makeAdtRequest`, so:

   ```
   makeAdtRequest, baseline 0
     super.makeAdtRequest
       this.fetchCsrfToken → token-only refresh, tokenGeneration = 1
                           → retry still 401
     outer catch → ensureRecovered()
                     nothing in flight
                     tokenGeneration (1) > baseline (0) → "already recovered"
   ```

   The outer handler retries a request whose session was never rebuilt. Two facts were being
   carried by one counter. Raised in review, 2026-08-16.

   ```ts
   /** Bumped by any token refresh, token-only ones included. */
   private tokenGeneration = 0;

   /**
    * The `tokenGeneration` a completed session recovery was built for. Only
    * `performRenewal` moves it, and only after `recoverSession` resolves.
    */
   private recoveredGeneration = 0;
   ```

   A token-only refresh may use its new token freely — that is what it is for — but it must not
   publish "the session is settled", because it did not settle one. The establishment paths
   therefore leave `recoveredGeneration` alone even when they go on to establish successfully.
   That is deliberately conservative: the cost is at most one extra discard-and-recover, which
   single-flight collapses anyway, and the error it prevents is a **skipped** recovery — the
   direction that actually breaks callers.

   **A joiner must re-check its own epoch before retrying.** The renewal was fenced against the
   *starter's* `baselineEpoch`, not the joiner's, and `recoverSession` yields to a teardown by
   comparing against the baseline it was given. A joiner whose caller asked to stop meanwhile
   must not retry on a session someone else resurrected. This is a requirement on the
   implementation, not an observation about it.

   `fetchCsrfToken` and `establishSession` renew the **token** only — they run inside an
   establishment, so discarding and re-establishing from there would re-enter the transition they
   are part of. `makeAdtRequest` is the only site that renews the session, and
   `recoveredGeneration` is what keeps the two kinds of renewal from being mistaken for each
   other.

4. **Ending.** The outermost call clears `active` in a `finally`, and that flag — not the store's
   presence — is what marks the operation over.

   An earlier draft said the scope "cannot leak into an unrelated request", which is too strong:
   `AsyncLocalStorage` propagates the store to every async resource created inside `run()`, and
   such a resource can outlive the callback. A timer, an unawaited promise or a retained
   continuation started during one operation still sees that store when it later runs. What is
   guaranteed is narrower and sufficient: a **stale** store is visibly stale, because `active` is
   false, so nothing inherits a baseline from an operation that has finished. Raised in review,
   2026-08-16.

   `tokenGeneration` outlives every scope deliberately — it is what a *later* operation compares
   against to decide the token has since been renewed.

**What this gives, per case:**

| case | refreshes |
|---|---|
| one `makeAdtRequest`, 401 at CSRF level then at request level then in recovery | **1 renewal** — the CSRF level refreshes the token only; the request level finds `recoveredGeneration` unmoved and runs the one session recovery |
| two concurrent `makeAdtRequest`, both hit the same expired token | **1** — and one session recovery: the joiner waits for the whole renewal, then retries on the session the winner rebuilt |
| a later `makeAdtRequest` after the renewed token also expires | **1** — its baseline is the current generation, so it refreshes properly |
| `connect()` alone, 401 on CSRF | **1** — `fetchCsrfToken` refreshes, `establishSession` no longer does |
| an operation on connection **B** started inside connection **A**'s async context | **each refreshes its own** — B's storage is B's, so B sees no store and opens its own scope |
| a re-entrant `makeAdtRequest` on the **same** connection, started after the outer refresh completed | **its own baseline**, so its own 401 can refresh again — where an inherited baseline would have it skip |
| a re-entrant `makeAdtRequest` started *while* a renewal is in flight | **joins that renewal** — a new scope does not mean a new network call, and it does not mean a second teardown |
| a re-entrant `makeAdtRequest` started during the recovery *establishment* | **`NOT_CONNECTED`** — `discardSession()` has shut admission until `markConnected`. Pre-existing session behaviour, unchanged here, but it bounds where a test can inject one |
| a stale async context left behind by a finished operation | **treated as a fresh operation** — `active` is false, so its baseline is not inherited |

The third row is the one an instance-level flag gets wrong. The fifth is the one a **static**
`AsyncLocalStorage` gets wrong, and the sixth is the one a **uniform inherit-if-active rule** gets
wrong — both of which earlier drafts of this section specified. The seventh is there to keep the
sixth honest: scope and single-flight answer different questions, and a test that treats "new
scope" as "new refresh" contradicts the concurrency guarantee two rows above.


## What breaks

### A test that asserts the defect

`src/__tests__/AbstractAbapConnection.test.ts:315` —
`'JWT auth: 401 on POST … rejects.toThrow('JWT token has expired. Please re-authenticate.')'`.

Its real subject is the surrounding behaviour — that a 401 on POST does **not** trigger the
stale-CSRF retry, and that `csrfToken`/`cookies` survive untouched — which the same test already
checks on the next three lines and which this change does not alter. The assertion is rewritten
to expect the original error with status 401 preserved. Not deleted, and not turned into
`rejects.toThrow()` with no argument.

### Documentation that promises the behaviour being removed

Four places tell users that **403** triggers a refresh. After this change that is false, and
shipped documentation contradicting shipped behaviour is worse than none — it is believed.
Raised in review, 2026-08-16; an earlier draft scoped only the test.

| file | what it says |
|---|---|
| `src/connection/JwtAbapConnection.ts:11-13` | class doc: "401/403 errors trigger automatic token refresh" |
| `examples/jwt-with-token-refresh.js:7` | "When 401/403 errors occur, the connection automatically…" |
| `examples/jwt-with-token-refresh.js:71` | "This request will automatically refresh token if 401/403 occurs" |
| `examples/README.md:46` | "Automatic token refresh on 401/403 errors" |
| `README.md:223, 243` | "For automatic token refresh on 401/403 errors…", "401/403 handled automatically" |

All are **in scope** for the same PR. A doc change that trails a behaviour change by a release is
a doc change that never happens.

Each becomes "401", and the two prose ones gain the sentence that carries the reasoning: a 403 is
propagated with its status and the server's message, because a new token cannot change a
permissions answer. `examples/jwt-with-token-refresh.js` is executable and its comment at line 71
sits over a request — it should say what a caller now does with a 403, since that is the question
the example is there to answer.

## What gets tested

New tests in `src/__tests__/jwt-connection.test.ts`, each named for the fact it pins:

1. **A 403 with `ExceptionResourceNoAuthorization` propagates with status and body.** The
   regression this is all for. Asserts `error.response.status === 403` and that the body still
   contains `S_DEVELOP`.
2. **A 403 does not call the refresher.** `tokenRefresher.refreshToken` is a mock; it must not be
   called. Without this, a future change could restore the old behaviour while test 1 still
   passes, because a refreshed-then-failed 403 also ends up rethrown.
3. **A 401 with no refresher rethrows the original 401**, not a synthesised message.
4. **A 401 with a refresher that helps** retries once and succeeds — the existing happy path,
   asserted for call counts so "bounded" is checkable.
5. **A persistent 401 refreshes exactly once, through the real nested path.** The acceptance
   test for the guarantee above, and its transport has to be **scripted rather than uniform**: a
   transport that answers 401 to everything never gets a session established, so `connect()`
   fails and the request and recovery paths are never reached at all. Raised in review,
   2026-08-16. The script:

   | # | request | answer |
   |---|---|---|
   | 1 | initial CSRF / discovery, during `connect()` | **200**, with a CSRF token — establishment succeeds |
   | 2 | the ADT request under test | **401** |
   | 3 | every request of the recovery establishment that follows the refresh | **401** |

   Then assert, in this order of importance: `refreshToken` was called **exactly once** — not
   "at most twice", not "did not hang"; the rejection carries `response.status === 401`; and the
   refresher's own call count is read from the mock rather than inferred from timing.

   **`fetchCsrfToken` must not be mocked.** Mocking it is precisely how the existing
   establishment-retry test would let four nested refreshes through, and the nesting is the
   defect under test.
6. **Two concurrent operations share one renewal — token *and* session — and both succeed.**
   The acceptance test for the concurrency half. Establish successfully, then start two
   `makeAdtRequest` calls without awaiting the first, both answered 401, and assert **all four**:

   - `refreshToken` called **once**;
   - the session was recovered **once** — spy `recoverSession`, or count establishment requests
     at the transport;
   - both requests retried **after** that recovery completed;
   - both settled with the expected response, and **neither failed `NOT_CONNECTED`**.

   The last two are what a token-only single-flight fails. It gives the first assertion happily
   while each operation still runs its own `discardSession()` + `recoverSession()`, which never
   join — so the second operation's cleanup can tear down the session the first has just
   rebuilt, and the first's retry meets a closed door. A test asserting only `refreshToken === 1`
   would have passed on that. Raised in review, 2026-08-16.

   Both requests must be **in flight before** either renewal completes, since the winner's
   `discardSession()` invalidates leases and shuts admission. That is the state being tested, not
   an obstacle to it, but it decides how the test is written: start both, then release the
   transport, rather than starting the second after the first has failed.

7. **An operation that starts after a completed renewal may still renew.** The pair to 6, which
   an instance-level re-entrancy flag also passes. Establish, drive one operation through a 401
   and its renewal, let it settle completely, then start a second operation whose request also
   401s. `refreshToken` is called a **second** time. Without this, "renew at most once" could be
   satisfied by never renewing twice at all.
8. **A nested token-only refresh does not pass for a session recovery.** The test for the
   invariant above, and the one a single counter fails. Establish successfully, then drive a
   `makeAdtRequest` where:

   - the nested `fetchCsrfToken` inside `super.makeAdtRequest` is answered **401**, so it does
     its token-only refresh;
   - its retry is answered **401** as well, so the failure reaches the outer handler;
   - the outer `makeAdtRequest` must then perform **exactly one** session recovery — spy
     `recoverSession` — and issue its final retry only **after** that recovery resolves.

   With one counter the outer handler reads the nested refresh as its own and retries a request
   whose session was never rebuilt, which is a green test suite and a broken connection. Assert
   the ordering, not just the counts: a recovery that happens *after* the retry satisfies
   "exactly one" and is still wrong.
9. **Two concurrent requests that both 401 in the nested CSRF fetch refresh the token once.**
   Test 6 drives its 401s at the working request, which exercises `renewalInFlight`; this one
   drives them one level deeper, where that promise does not exist yet. Establish successfully,
   then start two `makeAdtRequest` calls without awaiting the first, with the transport answering
   401 to the **nested `fetchCsrfToken`** of each.

   Assert `refreshToken` called **once** — the token primitive is what has to collapse them, and
   without it each nested handler sees `tokenGeneration` unmoved and calls the refresher, leaving
   `currentToken` as whichever settled last. Then let both climb to their outer handlers and
   assert the session was recovered **once** as well. Raised in review, 2026-08-16.
10. **Two connections do not share a recovery scope.** Build `A` and `B`, each with its own
   refresher, and establish both. **Drive `B` through one refresh first**, so `B.tokenGeneration`
   is 1 while `A`'s is 0 — without that divergence the test proves nothing, because equal
   counters make an inherited baseline and an own baseline give the same answer.

   Then: `A`'s request 401s and `A` refreshes. During `A`'s recovery establishment a **one-shot
   transport hook** fires — the mocked HTTP layer is under test control, so this runs inside
   `A`'s scope and *after* `A`'s refresh — and it starts `B.makeAdtRequest(...)`, which also
   401s.

   Assert **`B`'s refresher was called a second time**. Under a shared store `B` would inherit
   `A`'s baseline of 0, see its own generation 1 as "greater", conclude a refresh had already
   happened for it, and retry with the same stale token instead of refreshing — a *skipped*
   refresh, which is the shape this bug takes.

   **Do not use `A.tokenRefresher.refreshToken()` as the hook.** It deadlocks: the refresher is
   awaited inside `performRenewal`, so an inner request started there waits on
   `renewalInFlight`, which waits on the refresher, which waits on the inner request. Raised in
   review, 2026-08-16, against a draft that specified exactly that.

   The transport hook is safe **here** because the inner request goes to `B`, whose lifecycle is
   its own: `A` being mid-teardown does not close `B`'s admission. Test 9 cannot borrow this
   placement, for exactly that reason.
11. **A re-entrant `makeAdtRequest` on the same connection gets its own baseline.** Same idea as
   10, but the inner request goes to the **same** connection — and that changes where the hook can
   fire, because this connection is mid-teardown for part of the window.

   **Not during recovery establishment.** After its refresh the outer operation calls
   `discardSession()`, which is `raiseSessionLost()` → `lifecycle.beginTeardown(…)`
   (`AbstractAbapConnection.ts:379`), and that shuts admission. An inner `A.makeAdtRequest`
   started there never reaches the transport: `admitRequest()` throws `NOT_CONNECTED`
   (`AbstractAbapConnection.ts:550`) and the planned 401 never happens. Raised in review,
   2026-08-16, against a draft that put the hook exactly there.

   **The window that works** is after `recoverSession()` has resolved — admission reopened by
   `markConnected`, `tokenGeneration` already 1 — and before the outer operation's
   `super.makeAdtRequest` retry, with the outer ALS scope still active. In practice: wrap
   `recoverSession`, call through to the original, start the inner request once it resolves, then
   return.

   Assert: the inner request's 401 produces a **second** refresh (`tokenGeneration` 2), because
   its baseline is 1; and the outer operation, continuing afterwards, does **not** refresh again,
   because 2 is greater than its baseline of 0. Two refreshes in total, each belonging to a
   different operation.

   With an inherited scope the inner request would carry baseline 0, read generation 1 as
   somebody else's refresh, and skip its own — which is the distinction this test exists to draw.

   **Timing is the whole test**, and it has now been wrong twice. An earlier draft started the
   inner request from inside the refresher — *while* the refresh was in flight — and asserted a
   second network refresh, which both deadlocks and contradicts the single-flight guarantee test
   6 pins. The draft after it moved to the transport hook and landed in the closed-admission
   window. The requirement is narrow and worth restating plainly: **after the refresh, after
   admission reopens, before the retry, inside the outer scope.**
12. **A finished operation's async context is not inherited.** Run one operation to completion
   while retaining a continuation created inside it, then start a new operation from that
   continuation. It must refresh on its own account rather than reading the finished operation's
   baseline — the `active` flag, tested directly, since `AsyncLocalStorage` alone does not give
   this.
13. **The `generation` argument reaches the base implementation.** Spy on
   `AbstractAbapConnection.prototype.fetchCsrfToken` and assert the fourth argument arrives when
   `makeAdtRequest` passes a lease generation — the dropped-parameter defect, which no current
   test would notice because the code compiles and behaves plausibly without it.

Tests 2 and 5–13 are the ones that would have caught these classes of defect; 1 is the one that
catches this instance. They come in pairs on purpose, because each pair pins a boundary from both
sides and either half alone can be satisfied by a design wrong in the other direction: 6/7 for
"share a renewal" against "still able to renew later", and 10/11/12 for the three ways an
operation-scoped baseline can be read by something it does not belong to — another connection, a
re-entrant operation, or a later moment. 8 and 9 stand on their own: 8 pins the one thing the two
counters must never conflate, and 9 covers the level 6 cannot reach, since a 401 at the working
request and a 401 in the nested CSRF fetch travel different paths to the same refresher.

**All three of 8, 9 and 10 assert a refresh that would otherwise be *skipped*.** That is worth
stating because the intuitive failure — "it refreshes too often" — is the one this design cannot
have: single-flight collapses concurrent refreshes, and a wrong baseline can only ever make an
operation believe somebody has already refreshed for it. A test suite written against the
intuitive failure would pass on a broken implementation.

## Out of scope

- `BaseAbapConnection` and `SamlAbapConnection`. Neither has a refresh path, and neither
  synthesises an error in place of the server's. Worth a look afterwards; not this change.
- Anything about `S_DEVELOP` or which object types a cloud system permits. That was the
  investigation this came out of, not the subject.
- The version bump and release. A separate decision, taken when the work is done, not here.
