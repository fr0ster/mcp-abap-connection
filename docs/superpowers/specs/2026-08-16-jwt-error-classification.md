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

/** Single-flight: concurrent callers join this rather than starting a second. */
private refreshInFlight?: Promise<boolean>;
```

**Lifecycle, in full.**

1. **Opening a scope.** Each entry point wraps its body in
   `this.withRecoveryScope(() => …)`. `withRecoveryScope` opens a new scope **only if none is
   active**; otherwise it runs the callback in the scope already there. That single rule is what
   makes nesting work: the outermost operation defines the baseline, and everything beneath it
   inherits.

   ```ts
   private withRecoveryScope<T>(fn: () => Promise<T>): Promise<T> {
     const inherited = this.recoveryScope.getStore();
     // Inherit only a scope that is still running. A store reached through an
     // async resource that outlived its operation is stale, and its baseline
     // describes a credential state that has since moved.
     if (inherited?.active) return fn();

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
   ```

2. **The entry points** are the three public or protected methods a caller can start from:
   `makeAdtRequest`, `fetchCsrfToken` and `establishSession`. Each opens a scope. In the nested
   case only the outermost actually creates one, so `makeAdtRequest`'s baseline is what the
   `fetchCsrfToken` three levels down sees — including the one reached through `recoverSession`,
   because `recoverSession` is called *inside* `makeAdtRequest`'s scope and async context flows
   through it without `recoverSession` knowing.

3. **Deciding.** `ensureFreshToken()` takes no argument; it reads the active scope.

   ```ts
   private async ensureFreshToken(): Promise<boolean> {
     const scope = this.recoveryScope.getStore();
     // No live scope means a caller reached a handler by a path that does not
     // open one, or through a stale async context. Either way, treat it as its
     // own operation rather than trusting a baseline nobody is standing behind.
     const baseline = scope?.active ? scope.baseline : this.tokenGeneration;

     // Somebody already refreshed since this operation began — this operation's
     // retry will use the newer token, which is the point. Refreshing again asks
     // the same refresher the same question.
     if (this.tokenGeneration > baseline) return true;

     if (!this.tokenRefresher) return false;

     // Single-flight: two concurrent operations that both observed the same
     // failing token share one network refresh instead of racing.
     this.refreshInFlight ??= this.performRefresh();
     try {
       return await this.refreshInFlight;
     } finally {
       this.refreshInFlight = undefined;
     }
   }

   private async performRefresh(): Promise<boolean> {
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
| one `makeAdtRequest`, 401 at CSRF level then at request level then in recovery | **1** — the second and third see `tokenGeneration > baseline` |
| two concurrent `makeAdtRequest`, both hit the same expired token | **1** — single-flight, and the loser retries with the winner's token |
| a later `makeAdtRequest` after the renewed token also expires | **1** — its baseline is the current generation, so it refreshes properly |
| `connect()` alone, 401 on CSRF | **1** — `fetchCsrfToken` refreshes, `establishSession` no longer does |
| an operation on connection **B** started inside connection **A**'s async context | **each refreshes its own** — B's storage is B's, so B sees no store and opens its own scope |
| a stale async context left behind by a finished operation | **treated as a fresh operation** — `active` is false, so its baseline is not inherited |

The third row is the one an instance-level flag gets wrong; the fifth is the one a **static**
`AsyncLocalStorage` gets wrong, which is what an earlier draft specified.


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
6. **Two concurrent operations against the same expired token refresh once between them.** The
   acceptance test for the concurrency half: establish successfully, then start two
   `makeAdtRequest` calls without awaiting the first, both answered 401. `refreshToken` is called
   **once**, and the second operation retries with the token the first fetched. This is the test
   an instance-level re-entrancy flag would also pass — which is why it comes with the next one.
7. **An operation that starts after a completed refresh may still refresh.** Establish, drive one
   operation through a 401 and its refresh, let it settle, then start a second operation whose
   request also 401s. `refreshToken` is called a **second** time. This is the case a re-entrancy
   flag gets wrong, and without it "refresh at most once" could be satisfied by never refreshing
   twice at all.
8. **Two connections do not share a recovery scope.** Build `A` and `B`, each with its own
   refresher. Establish both, then start `B.makeAdtRequest(...)` **from inside `A`'s async
   context** — inside a `.then` of an A request, which is what a caller juggling two systems
   writes without thinking about it. Both requests 401. Assert **each refresher was called
   once**: B must not inherit A's baseline, because B compares it against B's own
   `tokenGeneration` and the two counters describe different credentials. This is the test a
   static `AsyncLocalStorage` fails.
9. **A finished operation's async context is not inherited.** Run one operation to completion
   while retaining a continuation created inside it (an unawaited promise captured in the test),
   then start a new operation from that continuation. It must refresh on its own account rather
   than reading the finished operation's baseline — the `active` flag, tested directly, since
   `AsyncLocalStorage` alone does not give this.
10. **The `generation` argument reaches the base implementation.** Spy on
   `AbstractAbapConnection.prototype.fetchCsrfToken` and assert the fourth argument arrives when
   `makeAdtRequest` passes a lease generation — the dropped-parameter defect, which no current
   test would notice because the code compiles and behaves plausibly without it.

Tests 2 and 5–10 are the ones that would have caught these classes of defect; 1 is the one that
catches this instance. 6 and 7 are a pair on purpose — either alone can be passed by a design that
is wrong in the other direction — and 8 and 9 are the two ways an operation-scoped baseline can
be read by something it does not belong to: another connection, or a later moment.

## Out of scope

- `BaseAbapConnection` and `SamlAbapConnection`. Neither has a refresh path, and neither
  synthesises an error in place of the server's. Worth a look afterwards; not this change.
- Anything about `S_DEVELOP` or which object types a cloud system permits. That was the
  investigation this came out of, not the subject.
- The version bump and release. A separate decision, taken when the work is done, not here.
