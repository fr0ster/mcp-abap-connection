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

```ts
private tokenGeneration = 0;

/**
 * True when the caller may retry. Refreshes only if nobody has since
 * `seenGeneration` — a nested handler that already refreshed means the current
 * token is newer than the one that failed, and retrying with it is the whole
 * point. Refreshing again would ask the same refresher the same question and
 * burn a round trip to do it.
 */
private async ensureFreshToken(seenGeneration: number): Promise<boolean> {
  if (this.tokenGeneration > seenGeneration) return true;   // someone else did it
  if (!this.tokenRefresher) return false;
  try {
    this.currentToken = await this.tokenRefresher.refreshToken();
    this.tokenGeneration += 1;
    return true;
  } catch (error) {
    this.logger?.error(`[ERROR] JwtAbapConnection - token refresh failed: ${…}`);
    return false;
  }
}
```

Each handler captures `const seen = this.tokenGeneration` **before its attempt** and passes it in.
`makeAdtRequest` capturing before `super.makeAdtRequest` is what makes the inner
`fetchCsrfToken`'s refresh visible to it as "already done".

**The one path this does not cover by itself** is `makeAdtRequest` → `recoverSession` →
`establishSession` → `fetchCsrfToken`: that inner `fetchCsrfToken` starts after the refresh, so
its own captured baseline is the new generation and it would refresh again. Two ways to close it,
and the plan picks one on the code rather than here:

- thread the operation's baseline generation into the establishment `makeAdtRequest` triggers, or
- have `makeAdtRequest`'s recovery mark a re-entrancy flag that `ensureFreshToken` honours.

**What is fixed here rather than in the plan is the acceptance criterion**, because that is what
made the earlier draft wrong: it promised a bound and left the checking to a mechanism that could
not deliver it. Whatever the plan chooses must satisfy the test below — a real 401 driven through
the real nested path, asserting `refreshToken` was called **exactly once**. No mocking of
`fetchCsrfToken`, which is how the existing establishment-retry test would let this through.

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
   test for the guarantee above: drive `makeAdtRequest` against a transport that answers 401 to
   everything, with a refresher that always resolves, and assert
   `refreshToken` was called **exactly once** — not "at most twice", not "did not hang".
   **`fetchCsrfToken` must not be mocked**: mocking it is precisely how the existing
   establishment-retry test would let four nested refreshes through, and the nesting is the
   defect. Assert the rejection carries status 401.
6. **The `generation` argument reaches the base implementation.** Spy on
   `AbstractAbapConnection.prototype.fetchCsrfToken` and assert the fourth argument arrives when
   `makeAdtRequest` passes a lease generation — the dropped-parameter defect, which no current
   test would notice because the code compiles and behaves plausibly without it.

Tests 2, 5 and 6 are the ones that would have caught these classes of defect; 1 is the one that
catches this instance.

## Out of scope

- `BaseAbapConnection` and `SamlAbapConnection`. Neither has a refresh path, and neither
  synthesises an error in place of the server's. Worth a look afterwards; not this change.
- Anything about `S_DEVELOP` or which object types a cloud system permits. That was the
  investigation this came out of, not the subject.
- The version bump and release. A separate decision, taken when the work is done, not here.
