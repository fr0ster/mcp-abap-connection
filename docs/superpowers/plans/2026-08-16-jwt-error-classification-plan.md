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

**Test 5** lands here in its first form — a persistent 401 through the real nested path, with the
scripted transport the spec sets out (establishment succeeds, the ADT request 401s, the recovery
establishment 401s), asserting the refresher is called once and the rejection carries 401. It is
strengthened again in task 5 when the full renewal exists. `fetchCsrfToken` is not mocked.

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

**Test 9:** two concurrent requests both answered 401 at the **nested `fetchCsrfToken`**;
`refreshToken` called once. This is the level `renewalInFlight` cannot reach, since it does not
exist until the failure climbs to the outer handler.

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

**A joiner re-checks its own epoch before retrying.** The renewal was fenced against the
*starter's* `baselineEpoch`. A joiner whose caller asked to stop meanwhile must not retry on a
session someone else resurrected.

**Tests 5 (strengthened), 6, 7, 8, 10, 11, 12.** Two need care and the spec says exactly where:

- **6** — both requests in flight *before* either renewal completes, since the winner's
  `discardSession()` invalidates leases. Asserts four things, not one: refresher once, recovery
  once, both retried after it, neither `NOT_CONNECTED`.
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
2. **Mutation-check each new test.** For every one of 1–13, break the thing it pins and confirm
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
