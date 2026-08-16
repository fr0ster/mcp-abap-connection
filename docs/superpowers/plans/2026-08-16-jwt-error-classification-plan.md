# Plan: JWT error classification and bounded recovery

**Spec:** `docs/superpowers/specs/2026-08-16-jwt-error-classification.md` (approved 2026-08-16).
**Issue:** [#30](https://github.com/fr0ster/mcp-abap-connection/issues/30).
**Delivery:** one PR against `master`, code and documentation together. No version bump in it —
that is decided when the work is done.

## Shape of the work

Seven tasks. The first three each close something on their own and leave the suite green; task 4
is the machinery the rest sits on; task 5 is the one that carries risk. Docs land in the same PR
because a doc change trailing a behaviour change by a release is a doc change that never happens.

Every task ends the same way: `npm run build && npm test`, green, before the next one starts. No
task is "done" with a red tree behind it.

---

## Task 1 — Stop dropping the `generation` argument

**Why first:** it is independent of everything else, it is a pre-existing defect, and it touches
the method tasks 3 and 4 rewrite. Fixing it afterwards would mean re-reading a method twice.

`JwtAbapConnection.fetchCsrfToken` declares three parameters where the base declares four, and
calls `super` with three — so `lease.generation`, passed by
`AbstractAbapConnection.makeAdtRequest` (line 814), is discarded on every JWT connection.

- match the base signature, including `generation?: number`;
- forward all four to `super.fetchCsrfToken`;
- take the defaults from `CSRF_CONFIG.RETRY_COUNT` / `.RETRY_DELAY` rather than the hardcoded
  `3` / `1000` — same values today, one copy instead of two.

**Test 13** (spec numbering): spy `AbstractAbapConnection.prototype.fetchCsrfToken`, drive a
`makeAdtRequest` that fetches CSRF, assert the fourth argument arrives.

**Verify by breaking it:** drop the argument again and watch the new test fail. TypeScript will
not catch this class of defect — fewer parameters are assignable to more — so the test is the
only thing standing between it and a silent return.

---

## Task 2 — Classify by status, and never synthesise an error

This is what closes #30, and it is worth landing as its own commit so the fix is legible in the
history without the machinery around it.

In all three handlers:

- refresh only on **401**. A 403 no longer enters the refresh path;
- delete the `ExceptionResourceNoAccess` / `No authorization` / `Missing authorization`
  substring list — with 403 out of the path it guards nothing;
- replace every `throw new Error('JWT token has expired. Please re-authenticate.')` (lines 130,
  201, 250) with `throw error`;
- the explanation moves to a log line at ERROR level: a 401 that survived a refresh may need
  re-authentication, and that belongs where an explanation belongs.

**Update the existing test** `src/__tests__/AbstractAbapConnection.test.ts:315`. Its subject is
that a 401 on POST does not trigger the stale-CSRF retry and that `csrfToken`/`cookies` survive —
the next three lines already check that and do not change. Only the `rejects.toThrow('JWT token
has expired…')` becomes an assertion on the original error with `response.status === 401`. Not
deleted; not `rejects.toThrow()` with no argument.

**Tests 1–4:**

1. a 403 with `ExceptionResourceNoAuthorization` propagates with status and body — assert the
   body still contains `S_DEVELOP`;
2. a 403 does not call the refresher (mock, `not.toHaveBeenCalled`);
3. a 401 with no refresher rethrows the original 401;
4. a 401 with a refresher that helps retries once and succeeds — assert call counts, so
   "bounded" is checkable rather than asserted.

Test 2 is the one that keeps this fixed: without it, a future change could restore the old
behaviour and test 1 would still pass, because a refreshed-then-failed 403 also ends up rethrown.

---

## Task 3 — `establishSession` renews nothing

- its catch becomes: log at ERROR, `throw error`;
- the recursive `return this.establishSession()` goes;
- it takes no part in the recovery scope introduced in task 4.

Its `try` wraps `this.fetchCsrfToken` and nothing else, so the only 401 it can see is one
`fetchCsrfToken` has already refreshed for and retried. A second refresh here asks the same
refresher the same question.

**Test 5 does not land here.** At this point `makeAdtRequest` and `fetchCsrfToken` still refresh
independently — there is no generation guard yet — so the spec's scenario produces two refreshes,
not one:

```
ADT request → 401
  makeAdtRequest refreshes                 ← call 1
  recoverSession → establishSession
    fetchCsrfToken → 401
      fetchCsrfToken refreshes             ← call 2
      retry → 401
    establishSession rethrows
```

Removing the recursion bounds the loop; it does not collapse the two handlers. An assertion of
`refreshToken` called **once** cannot pass before task 5, and a plan that scheduled it here would
have forced either a red tree or a temporary assertion written to be rewritten. Raised in review,
2026-08-16.

**What task 3 does prove**, and can: a persistent 401 during `connect()` **terminates** and
rejects with the original error carrying `status === 401`, rather than recursing. Count the CSRF
attempts, or spy `establishSession`, and assert it ran once — the recursion is what this task
removes, so that is what this task's test pins. `fetchCsrfToken` is not mocked.

Test 5 in full — the scripted transport, `refreshToken` exactly once — belongs to task 5, where
the machinery that makes it true exists.

---

## Task 4 — The two single-flight primitives

The layering is the point: `tokenRefreshInFlight` shares the token fetch and touches no session
state; `renewalInFlight` sits above it and owns the session half. A token-only handler joins only
the lower one, because it runs inside an establishment and joining the upper one would wait on
the transition it is part of.

Add, in this order — each compiles and the suite stays green:

1. `tokenGeneration`, `tokenRefreshInFlight`, `refreshTokenOnce`, `performTokenRefresh`;
   `fetchCsrfToken` calls `refreshTokenOnce` and retries once;
2. `recoveryScope` (**instance field**, `AsyncLocalStorage<IRecoveryScope>`), `IRecoveryScope`
   with `baseline` and `active`, `inNewRecoveryScope`, `inRecoveryScope`;
   `makeAdtRequest` wraps in the first, `fetchCsrfToken` in the second.

**Both in-flight fields are cleared with an identity check** — `if (this.xInFlight === inFlight)`
— exactly as `SessionLifecycle.transition` does with `tailPromise`. A joiner settling late must
not clear a promise somebody started after it. Flagged in the spec's approval as the thing most
likely to be simplified away; it is not a nicety.

**Test 9, first form.** The spec's Test 9 has two halves — one shared token refresh at the CSRF
level, and one shared session recovery after the failures climb to the outer handlers. Only the
lower half can be green here, because `renewalInFlight` does not exist yet: if the CSRF retries
also 401ed, the old outer handlers would each recover independently and the tree would go red.

So at task 4 the transport answers **401 to each nested `fetchCsrfToken`, then succeeds on the
retry**. Assert `refreshToken` called **once** across the two concurrent requests. That pins the
token primitive, which is this task's subject, and nothing it cannot yet deliver.

Its second half lands in task 5, and is listed there so it cannot be forgotten. Raised in review,
2026-08-16, against a plan that scheduled the whole test here and then omitted it from task 5.

---

## Task 5 — The full renewal, and the decision order

The task with the risk in it.

1. `recoveredGeneration`, `renewalInFlight`, `renewCredential`, `performRenewal`;
2. `performRenewal` = `refreshTokenOnce` → `discardSession()` → `recoverSession()` →
   `recoveredGeneration = tokenGeneration`;
3. `ensureRecovered`, and `makeAdtRequest`'s catch calls it.

**The order of checks in `ensureRecovered` is the design, not style.** Written out here so nobody
tidies it:

```ts
if (this.renewalInFlight) return this.renewalInFlight;   // 1. join, regardless of generation
const baseline = scope?.active ? scope.baseline : this.tokenGeneration;
if (this.recoveredGeneration > baseline) return true;    // 2. a renewal COMPLETED for us
return this.renewCredential(baselineEpoch, baseline);    // 3. nobody has
```

Check 1 before check 2, or a joiner with a newer generation retries into a closed admission door.
Check 2 on `recoveredGeneration`, not `tokenGeneration`, or a nested token-only refresh passes for
a session recovery.

### The epoch re-check, as a step rather than a remark

`establishAndCommit` compares `teardownEpoch` against its baseline **twice** — before the
establishment (`AbstractAbapConnection.ts:298`) and again after it
(`AbstractAbapConnection.ts:334`). Both belong to the establishment that runs. Between the second
check and the retry there is a gap nothing guards, and a renewal that returned `true` is the
signal to retry.

The epoch belongs to the **connection**, not to a request: a teardown invalidates every request
in flight, whoever asked for it. So this is not "did *my* caller stop" and it is not about
joiners specifically — the request that started the renewal passes through the same gap. It is:
**has this connection been torn down between the last lifecycle check and this retry.** An
earlier draft framed it per-joiner, which reads as if joiners had epochs of their own; raised in
review, 2026-08-16.

Written at the one place a retry is issued:

```ts
const recovered = await this.ensureRecovered(baselineEpoch);
if (!recovered) throw error;                     // the original, per task 2
if (this.teardownEpoch !== baselineEpoch) {
  throw sessionError(
    ADT_SESSION_ERROR.NOT_CONNECTED,
    'Retry abandoned: a teardown was requested for this connection',
  );
}
return super.makeAdtRequest<T, D>(options);
```

Same helper and same shape as `establishAndCommit`, so a reader meeting the second one recognises
it.

**Test 14, and the window is the test.** Two drafts of it were green either way.

*Draft one* put the teardown "during the renewal". `establishAndCommit`'s own checks catch that —
`performRenewal` rejects, `renewalInFlight` rejects, everything fails `NOT_CONNECTED` with the
guard or without it.

*Draft two* moved it after `recoverSession` resolved, and hit a different blocker:
`reset()` → `beginTeardown` sets `teardownPending = true` **synchronously**
(`SessionLifecycle.ts:202`), so the retry stops at `admitRequest()` with the same
`NOT_CONNECTED` and never reaches the transport. Deleting the guard changes nothing observable.
Both raised in review, 2026-08-16.

**What isolates the guard is a connection that is usable again *and* has a moved epoch.** Only a
caller teardown bumps the epoch (`origin === 'caller'`, `SessionLifecycle.ts:203-205`) — the
renewal's own `discardSession()` is `origin: 'internal'` and does not — and `markConnected` clears
`teardownPending` **without** touching the epoch (`SessionLifecycle.ts:109-114`). So after
`reset()` followed by a successful `connect()`, admission is open and the epoch is still moved.
That is the only state in which the guard is the sole thing standing between a stale operation
and the transport, and it is exactly the case it exists for: the connection was torn down and
made usable again before the retry.

The test, then — wrapping **`ensureRecovered`**, not `recoverSession`:

- `await` the original, so the renewal has completed and `renewalInFlight` is cleared;
- call `reset()`;
- `await connect()`, so the cleanup drains and a new session is connected;
- return the original's answer to the outer handler.

Assert: the rejection is `NOT_CONNECTED`, and the **transport received no retry**. One request is
enough; a joiner adds nothing, since the request that started the renewal passes through the same
gap.

**Mutation check for this one is mandatory rather than routine:** delete the guard and the
transport must see the forbidden retry, issued over the *new* session. If it does not, the window
was missed again and the test is back to decoration.

`baselineEpoch` is already captured at the top of `makeAdtRequest`
(`JwtAbapConnection.ts:146`) and needs no new plumbing; `sessionError` and `ADT_SESSION_ERROR`
need importing into the subclass, which today imports neither.

**Tests 5, 6, 7, 8, 9 (strengthened), 10, 11, 12 and 14.** Test 5 lands here in full rather than
being strengthened — task 3 could not host it. Three need care:

- **9** — now the whole scenario: both nested CSRF retries 401 **again**, both failures climb to
  their outer handlers. Assert one token refresh (as before) **and** one session recovery, and
  that both requests end with the response the final retries fetch. The second half is the part
  task 4 could not carry.
- **6** — both requests in flight *before* either renewal completes, since the winner's
  `discardSession()` invalidates leases. Asserts four things, not one: refresher once, recovery
  once, both retried after it, neither `NOT_CONNECTED`. It differs from 9 in where the 401 lands
  — at the working request rather than in the nested CSRF fetch — and the two reach the same
  refresher by different paths, which is why both exist.
- **11** — the hook goes on **`ensureRecovered`**, not `recoverSession`: `await` the original,
  start the inner request, await it, then return. Three earlier attempts landed inside the
  refresher, inside the recovery establishment, and inside `renewalInFlight`; the spec lists the
  five conditions the window needs.

---

## Task 6 — The documentation that promises 401/403

Six places, all now false:

| file | change |
|---|---|
| `src/connection/JwtAbapConnection.ts:11-13` | class doc → 401 |
| `examples/jwt-with-token-refresh.js:7` | → 401 |
| `examples/jwt-with-token-refresh.js:71` | → 401, and say what a caller does with a 403 |
| `examples/README.md:46` | → 401 |
| `README.md:223` | → 401 |
| `README.md:243` | → 401 |

The two prose ones gain the reasoning in a sentence: a 403 propagates with its status and the
server's message, because a new token cannot change a permissions answer. Line 71 sits over a
request in a runnable example, so it should answer the question a reader arrives with.

---

## Task 7 — Verify, then hand over

1. `npm run build && npm test` clean.
2. **Mutation-check each new test.** For every one of 1–14, break the thing it pins and confirm
   that test — and ideally only that test — goes red. A test that stays green under its own
   mutation is not a test. Run them one at a time; parallel agents reverting each other's
   mutations has corrupted this exercise before.
3. Re-read the PR description against the diff before pushing, and again after any push.
4. Open the PR with `Closes #30`, a before/after of the error a caller now sees, and a note that
   403 no longer triggers a refresh.

## The one open question, and when it must be answered

The spec's classifier assumes an expired token yields **401**. Some BTP setups may answer 403.
Nothing captured shows either way, and it has not been observed end to end.

**Capture it before the release, not before the merge.** The design is safe under the assumption
being wrong — a caller receives the server's own 403 and message instead of a misleading one,
which beats today either way — so it does not block this PR. If the probe shows 403, the
classifier widens to "403 **and** a body that does not look like an authorization refusal", and
the type-matching regex the spec keeps in reserve earns its place.

Recorded here rather than in a comment because it is a task, not a caveat.

## Out of scope, deliberately

- `BaseAbapConnection` and `SamlAbapConnection` — neither refreshes, neither synthesises.
- The version bump and release.
- Anything about `S_DEVELOP` or which object types a cloud system permits.
