# Stale CSRF Token 401 Retry — Design Spec

**Issue:** [#7 — Cached CSRF token causes 401 + login form on POST when SAP rejects it (no retry triggered)](https://github.com/fr0ster/mcp-abap-connection/issues/7)
**Date:** 2026-05-12
**Status:** Draft

## Problem

`AbstractAbapConnection` caches a CSRF token (and the session cookies SAP binds to it) for the lifetime of the connection. When the cached token becomes invalid for a given mutation endpoint, SAP on-prem can answer in two distinct ways:

1. **Standard pattern** — `HTTP 403` with `"CSRF token validation failed"` (or similar) in the body.
2. **Login-form pattern** — `HTTP 401` with an HTML login page in the body (locale-dependent: `Anmeldung fehlgeschlagen` / `Logon failed` / `401 Nicht autorisiert` / ...).

The existing detector `shouldRetryCsrf()` only handles pattern (1), plus the "no cached token yet → 401 on mutation" bootstrap case. Pattern (2) with a **cached** token falls through, the request fails permanently, and consumers see an opaque 401 with login HTML on every POST/PUT/DELETE for the rest of the connection's life.

The original issue reporter proposed matching the German strings in the response body. This is rejected here because it is locale-dependent and breaks on English-, Russian-, or custom-themed SAP login pages.

## Out of scope

- **Per-endpoint CSRF fetch** (issue reporter's secondary observation that a token fetched from `/sap/bc/adt/core/discovery` may be rejected by `/sap/bc/adt/ddic/...`). This is a separate, rarer SAP behavior and will be addressed in a follow-up only if the primary fix proves insufficient. Tracked as a future change to `fetchCsrfToken()`, not part of this spec.
- **JWT auth path.** `shouldRetryCsrf()` already short-circuits to `false` for `authType === 'jwt'` — JWT refresh is the consumer's responsibility (see `feedback_auth_lifecycle_boundary`).
- **SAML auth path.** The new 401-with-cached-token branch is scoped to Basic auth only. A SAML 401 can mean the external SAML session is no longer valid, not merely that SAP rejected a stale CSRF token/session pair.
- **GET requests.** Already covered by the existing 401-on-GET retry branch.

## Design

### Detection signal

For the login-form 401 pattern, add a **status + method + cached-token** signal instead of matching locale-dependent body text:

> A Basic-auth mutation request (POST/PUT/DELETE) that returns **HTTP 401** while we **have** a cached CSRF token is treated as evidence that SAP has invalidated the token and its bound session.

Rationale:

- Locale-independent. Works against any SAP login theme.
- Semantically strong for Basic auth: the only reason a previously-successful Basic-auth connection would return 401 on a mutation is that the SAP session bound to our `SAP_SESSIONID` cookie + CSRF token has expired or been killed.
- Symmetric with the existing "no token yet → 401" branch, which uses the same shape (`isPostPutDelete && status === 401 && !csrfToken`).

The two branches together cover both directions:

| Cached CSRF | Status | Method | Action |
|---|---|---|---|
| no  | 401 | POST/PUT/DELETE | fetch token + cookies, retry (existing) |
| yes | 401 | POST/PUT/DELETE | **invalidate** session, refetch, retry (new, Basic auth only) |
| any | 403 | any | refetch, retry (existing) |
| any | any | any | refetch if body mentions CSRF (existing) |

### Session invalidation

When the new branch fires, both the CSRF token AND the session state SAP bound to it must be discarded before the retry. Currently the retry path overwrites `this.csrfToken` but leaves `this.cookies` / `this.cookieStore` intact — those carry the now-dead `SAP_SESSIONID`, which is exactly what SAP rejected.

Introduce a private helper `invalidateSession()` on `AbstractAbapConnection`:

```ts
private invalidateSession(): void {
  this.csrfToken = null;
  this.cookies = null;
  this.cookieStore.clear();
}
```

This is **distinct** from the existing public `reset()`, which also tears down the axios instance and interceptors. `invalidateSession()` clears only the SAP-side session state — the HTTP client is reused.

### Wiring into the retry path

In `makeAdtRequest()` error-handling block:

1. Compute `isCachedTokenStale` as a local boolean alongside the existing `shouldRetryCsrf()` call. It is `true` iff: AxiosError, `authType === 'basic'`, method ∈ {POST,PUT,DELETE}, status === 401, `this.csrfToken !== null`.
2. Fold `isCachedTokenStale` into the retry condition (either by making it a third branch returned from `shouldRetryCsrf()` or by `||`-ing it at the call site — implementation detail for the plan).
3. **If** the retry was triggered by `isCachedTokenStale`, call `invalidateSession()` **before** `fetchCsrfToken()`. The 403/CSRF-body branches keep their current behavior (don't clear cookies — those may still be valid).

`authType === 'basic'` applies only to the new 401-with-cached-token branch. Existing 403/body-based CSRF retry behavior must remain unchanged for the auth types it already supports.

The retry itself reuses the existing `fetchCsrfToken(requestUrl, 5, 2000)` call and the existing single-shot retry of `requestConfig`. No new retry loop, no exponential backoff added.

Wrap the CSRF refetch + retry request in `try`/`catch`. If either the refetch or the retry request fails, log the secondary failure at debug level and rethrow the original AxiosError. This preserves the pre-existing caller-visible error contract while still allowing recovery when the one-shot retry succeeds.

### Failure modes after retry

- Retry succeeds → caller sees success. (Most common case per the issue reporter.)
- Retry also returns 401/403 → original AxiosError is thrown. We do **not** loop. Caller sees the same exception they would have seen without this fix; they are no worse off.
- New CSRF fetch itself fails → original AxiosError is thrown. The fetch failure may be logged at debug level for diagnostics, but it must not replace the original mutation failure.

## Components touched

Only one file: `src/connection/AbstractAbapConnection.ts`.

- **New private method** `invalidateSession()`.
- **Modified** `shouldRetryCsrf()` — extended to recognize the new pattern, OR a sibling boolean computed at the call site. Plan decides.
- **Modified** retry block in `makeAdtRequest()` — calls `invalidateSession()` conditionally before the refetch and wraps the refetch + retry so secondary failures do not replace the original AxiosError.

No changes to public interface, no changes to `BaseAbapConnection` / `JwtAbapConnection` / `SamlAbapConnection`. No new config options. No new env vars.

## Testing

Unit tests in `src/__tests__/AbstractAbapConnection.test.ts` (or the closest existing file — plan picks):

1. **Happy-path regression** — POST with valid cached CSRF → succeeds, no retry, no session invalidation. (Guards against accidental invalidation on success.)
2. **403 CSRF (existing behavior)** — POST → 403 with `"CSRF"` body → token refetched, cookies preserved, retry succeeds. Confirms existing branch still works and cookies are NOT cleared.
3. **401 with cached token (new behavior)** — POST → 401 with HTML body, `csrfToken` set and old `SAP_SESSIONID` present → old session state is cleared before refetch, CSRF fetch is sent without the old `Cookie`, new token/cookies are captured, retry succeeds with the new `x-csrf-token` and new `Cookie`.
4. **401 without cached token (existing behavior)** — POST → 401, `csrfToken === null` → existing branch fires, retry succeeds.
5. **401 with cached token, retry also 401** — original AxiosError propagates. No infinite loop. Assert the thrown object is the original first POST error (for example with `toBe(originalError)`), not merely any 401 response.
6. **401 with cached token, CSRF refetch fails** — original AxiosError propagates, not the refetch error.
7. **JWT auth, 401 on POST** — no retry (existing JWT short-circuit holds).
8. **SAML auth, 401 on POST** — no new stale-CSRF retry; SAML session lifecycle remains outside this Basic-auth recovery branch.
9. **GET 401** — does not trigger the new mutation-only branch.

Tests mock axios per existing conventions in `src/__tests__/`. Access protected members via `(instance as any).` per the codebase convention noted in CLAUDE.md. Prefer assertions on observable request headers/session state over spying on the private `invalidateSession()` helper.

## Risks

- **False positive: legitimate 401** (e.g., user's SAP account locked mid-session). The fix would trigger one extra CSRF refetch, which also fails with 401, and the original error propagates. Net effect: one extra HTTP request per terminal-401 mutation. Acceptable.
- **Cookie-clearing interferes with stateful sessions.** Stateful mode relies on `SAP_SESSIONID` continuity for locks. But if SAP already returned 401, the stateful session is **already broken** — locks are gone server-side. Clearing local cookies is correct; consumers using stateful mode must already handle session loss (it's a SAP-side concern).
- **Body-content heuristic regressions.** None — we do not add body matching; we add a status+state check that is strictly orthogonal to the existing body-based branch.

## Acceptance

- New unit tests pass.
- Existing test suite passes unchanged.
- `npm test` passes.
- `npm run build` passes (Biome + tsc).
- Issue #7 reporter confirms `CreateDomain` succeeds after the fix (out-of-band verification).
