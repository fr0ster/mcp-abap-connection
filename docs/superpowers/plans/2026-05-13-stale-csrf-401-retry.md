# Stale CSRF Token 401 Retry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `AbstractAbapConnection` recover from SAP's "401 + login form" response to a mutation request when a stale CSRF token is cached, by invalidating session state and retrying once. (Issue #7.)

**Architecture:** Add one private helper `invalidateSession()` to `AbstractAbapConnection`, compute a local `isCachedTokenStale` boolean in `makeAdtRequest()`'s error block, fold it into the existing CSRF retry path, clear already-built stale request cookies before refetch, and wrap the refetch+retry in `try`/`catch` so secondary failures don't replace the original `AxiosError`. Only `authType === 'basic'` triggers the new branch.

**Tech Stack:** TypeScript, axios, Jest, Biome. Single source file changed: `src/connection/AbstractAbapConnection.ts`. New test file: `src/__tests__/AbstractAbapConnection.test.ts`.

**Spec:** `docs/superpowers/specs/2026-05-12-stale-csrf-401-retry-design.md`

---

## File Structure

- **Modify:** `src/connection/AbstractAbapConnection.ts`
  - Add private `invalidateSession()`.
  - In `makeAdtRequest()` error block, compute `isCachedTokenStale`, fold into retry condition, call `invalidateSession()` when it fires, delete stale `Cookie`/`cookie` headers from the already-built request headers, wrap refetch+retry in `try`/`catch`.
- **Create:** `src/__tests__/AbstractAbapConnection.test.ts`
  - Tests use `BaseAbapConnection` as the concrete subclass.
  - Mock the lazily-created axios instance by setting `(connection as any).axiosInstance` to a `jest.fn()` before invoking `makeAdtRequest()`.

No other files change. No new public API. No env vars.

---

## Design Decisions Locked

1. **Detection placement:** `isCachedTokenStale` is computed at the call site in `makeAdtRequest()` and `||`-ed into the existing `shouldRetryCsrf(error)` condition. `shouldRetryCsrf()` itself is NOT modified — its boolean contract stays intact for existing 403/CSRF-body cases. This avoids overloading one predicate with two semantics ("should refetch" vs "should also wipe cookies").

2. **Session invalidation:** A new private `invalidateSession()` clears `csrfToken`, `cookies`, and `cookieStore`. It is called from `makeAdtRequest()` only when `isCachedTokenStale` is the triggering condition — not for the existing 403/CSRF-body branch (those keep current behavior). Because `requestHeaders` was already built before the failed request, also delete stale `Cookie`/`cookie` entries from that local object immediately after invalidation.

3. **Error contract:** The refetch + retry happens inside a `try`/`catch`. On secondary failure, log at debug level and throw the original `AxiosError` (the variable bound by the outer `catch (error)`).

4. **Test concrete class:** `BaseAbapConnection` is used to instantiate. Test-private access to `axiosInstance` and other fields is via `(instance as any)` per CLAUDE.md convention.

---

## Task 1: Bootstrap test file and pin existing behavior

**Files:**
- Create: `src/__tests__/AbstractAbapConnection.test.ts`

**Purpose:** Build the test harness and lock in the four existing behaviors the spec demands not regress (happy POST, 403 CSRF retry, 401-no-token retry, GET 401 retry). These all PASS against current code — they are regression guards.

- [ ] **Step 1: Create the test file with axios mock harness**

Create `src/__tests__/AbstractAbapConnection.test.ts` with:

```ts
import { AxiosError } from 'axios';
import type { SapConfig } from '../config/sapConfig.js';
import { BaseAbapConnection } from '../connection/BaseAbapConnection.js';
import type { ILogger } from '../logger.js';

const mockLogger: ILogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

const baseConfig: SapConfig = {
  url: 'https://sap.example.com',
  authType: 'basic',
  username: 'u',
  password: 'p',
  client: '100',
};

type AxiosCall = { method?: string; url?: string; headers?: Record<string, string> };

function makeAxiosError(
  status: number,
  data: unknown,
  config: AxiosCall = {},
  headers: Record<string, string> = {},
): AxiosError {
  const err = new AxiosError(
    `Request failed with status ${status}`,
    String(status),
    config as any,
    null,
    {
      status,
      statusText: '',
      data,
      headers,
      config: config as any,
    } as any,
  );
  return err;
}

function attachMockAxios(conn: BaseAbapConnection, fn: jest.Mock) {
  (conn as any).axiosInstance = fn;
}

describe('AbstractAbapConnection — CSRF retry behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Tests added in later steps go here.
});
```

- [ ] **Step 2: Add happy-path POST test (regression guard)**

Inside the `describe`, add:

```ts
it('POST with cached CSRF token succeeds without retry', async () => {
  const conn = new BaseAbapConnection(baseConfig, mockLogger);
  (conn as any).csrfToken = 'cached-token';
  (conn as any).cookies = 'SAP_SESSIONID_HQ6=alive';

  const mock = jest.fn().mockResolvedValue({
    status: 200,
    data: 'ok',
    headers: {},
  });
  attachMockAxios(conn, mock);

  const res = await conn.makeAdtRequest({
    url: '/sap/bc/adt/ddic/domains/zfoo',
    method: 'POST',
    data: '<adtcore:objectReference/>',
  });

  expect(res.status).toBe(200);
  expect(mock).toHaveBeenCalledTimes(1);
  expect((conn as any).csrfToken).toBe('cached-token');
  expect((conn as any).cookies).toBe('SAP_SESSIONID_HQ6=alive');
});
```

- [ ] **Step 3: Add 403 CSRF retry test (regression guard, cookies preserved)**

```ts
it('403 with "CSRF" body refetches token and retries; cookies preserved', async () => {
  const conn = new BaseAbapConnection(baseConfig, mockLogger);
  (conn as any).csrfToken = 'old-token';
  (conn as any).cookies = 'SAP_SESSIONID_HQ6=alive';
  // Seed the cookie store so the post-response merge keeps it.
  (conn as any).cookieStore.set('SAP_SESSIONID_HQ6', 'alive');

  const mock = jest
    .fn()
    // 1st: original POST → 403 CSRF
    .mockRejectedValueOnce(
      makeAxiosError(403, 'CSRF token validation failed', {
        method: 'POST',
        url: 'https://sap.example.com/sap/bc/adt/ddic/domains/zfoo',
      }),
    )
    // 2nd: CSRF refetch (GET /sap/bc/adt/core/discovery) → 200 with new token
    .mockResolvedValueOnce({
      status: 200,
      data: '',
      headers: { 'x-csrf-token': 'new-token' },
    })
    // 3rd: retry POST → 200
    .mockResolvedValueOnce({ status: 200, data: 'ok', headers: {} });
  attachMockAxios(conn, mock);

  const res = await conn.makeAdtRequest({
    url: '/sap/bc/adt/ddic/domains/zfoo',
    method: 'POST',
    data: '<x/>',
  });

  expect(res.status).toBe(200);
  expect((conn as any).csrfToken).toBe('new-token');
  // Existing 403/CSRF branch must NOT wipe cookies.
  expect((conn as any).cookies).toContain('SAP_SESSIONID_HQ6=alive');
});
```

- [ ] **Step 4: Add 401-without-cached-token retry regression test**

This pins the existing `shouldRetryCsrf()` bootstrap branch required by the spec: a mutation returns 401 while `csrfToken === null`, so the CSRF retry path fetches a token and retries.

```ts
it('POST 401 without cached token: refetches token and retries', async () => {
  const conn = new BaseAbapConnection(baseConfig, mockLogger);
  (conn as any).csrfToken = null;
  (conn as any).cookies = null;

  const upfrontFetchError = new Error('upfront CSRF fetch unavailable');
  const fetchSpy = jest
    .spyOn(conn as any, 'fetchCsrfToken')
    // 1st fetch: upfront ensureFreshCsrfToken fails, makeAdtRequest continues.
    .mockRejectedValueOnce(upfrontFetchError)
    // 2nd fetch: CSRF retry branch obtains a token.
    .mockResolvedValueOnce('bootstrap-token');
  const mock = jest
    .fn()
    // 1st axios call: original POST without token → 401.
    .mockRejectedValueOnce(
      makeAxiosError(401, '<html>login</html>', {
        method: 'POST',
        url: 'https://sap.example.com/sap/bc/adt/ddic/domains/zfoo',
      }),
    )
    // 2nd axios call: retry POST → succeeds.
    .mockResolvedValueOnce({ status: 200, data: 'ok', headers: {} });
  attachMockAxios(conn, mock);

  const res = await conn.makeAdtRequest({
    url: '/sap/bc/adt/ddic/domains/zfoo',
    method: 'POST',
    data: '<x/>',
  });

  expect(res.status).toBe(200);
  expect((conn as any).csrfToken).toBe('bootstrap-token');
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  expect(mock).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 5: Add GET 401 test (existing GET branch unchanged)**

```ts
it('GET 401 with cookies retries with cookies (existing GET branch)', async () => {
  const conn = new BaseAbapConnection(baseConfig, mockLogger);
  (conn as any).csrfToken = 'whatever';
  (conn as any).cookies = 'SAP_SESSIONID_HQ6=alive';

  const mock = jest.fn();
  mock
    .mockRejectedValueOnce(
      makeAxiosError(
        401,
        '<html>login</html>',
        {
          method: 'GET',
          url: 'https://sap.example.com/sap/bc/adt/oo/classes/zcl_x',
        },
        { 'set-cookie': ['SAP_SESSIONID_HQ6=new'] },
      ),
    )
    .mockResolvedValueOnce({ status: 200, data: 'ok', headers: {} });
  attachMockAxios(conn, mock);

  const res = await conn.makeAdtRequest({
    url: '/sap/bc/adt/oo/classes/zcl_x',
    method: 'GET',
  });

  expect(res.status).toBe(200);
  expect(mock).toHaveBeenCalledTimes(2);
  // GET 401 branch must NOT clear csrfToken.
  expect((conn as any).csrfToken).toBe('whatever');
});
```

- [ ] **Step 6: Run the regression tests**

Run: `npx jest --testPathPatterns=AbstractAbapConnection`

Expected: 4 tests PASS against current `master`. If any fail, the test harness is wrong — fix the test, not the source.

- [ ] **Step 7: Commit**

```bash
git add src/__tests__/AbstractAbapConnection.test.ts
git commit -m "test: pin existing CSRF retry behavior in AbstractAbapConnection"
```

---

## Task 2: Add failing test for the new "401 with cached token" behavior

**Files:**
- Modify: `src/__tests__/AbstractAbapConnection.test.ts`

- [ ] **Step 1: Add the failing test**

Inside the same `describe`, add:

```ts
it('POST 401 with cached CSRF token: invalidates session, refetches, retries with new token/cookies', async () => {
  const conn = new BaseAbapConnection(baseConfig, mockLogger);
  (conn as any).csrfToken = 'stale-token';
  (conn as any).cookies = 'SAP_SESSIONID_HQ6=dead';
  (conn as any).cookieStore.set('SAP_SESSIONID_HQ6', 'dead');

  const calls: AxiosCall[] = [];
  const mock = jest.fn().mockImplementation(async (cfg: AxiosCall) => {
    calls.push({
      method: cfg.method,
      url: cfg.url,
      headers: { ...(cfg.headers || {}) },
    });
    // 1st call: the original POST with stale token → 401 + login HTML
    if (calls.length === 1) {
      throw makeAxiosError(
        401,
        '<html>Anmeldung fehlgeschlagen</html>',
        { method: cfg.method, url: cfg.url },
      );
    }
    // 2nd call: CSRF refetch → 200 with new token + new cookie
    if (calls.length === 2) {
      return {
        status: 200,
        data: '',
        headers: {
          'x-csrf-token': 'fresh-token',
          'set-cookie': ['SAP_SESSIONID_HQ6=fresh'],
        },
      };
    }
    // 3rd call: retry POST → 200
    return { status: 200, data: 'ok', headers: {} };
  });
  attachMockAxios(conn, mock);

  const res = await conn.makeAdtRequest({
    url: '/sap/bc/adt/ddic/domains/zfoo',
    method: 'POST',
    data: '<x/>',
  });

  expect(res.status).toBe(200);
  expect(mock).toHaveBeenCalledTimes(3);

  // Critical observable: the CSRF refetch (call #2) was sent WITHOUT the old SAP_SESSIONID cookie.
  const refetchCookie = calls[1]?.headers?.Cookie ?? calls[1]?.headers?.cookie;
  expect(refetchCookie ?? '').not.toContain('SAP_SESSIONID_HQ6=dead');

  // Retry POST (call #3) used the new token and the new cookie.
  expect(calls[2]?.headers?.['x-csrf-token']).toBe('fresh-token');
  const retryCookie = calls[2]?.headers?.Cookie ?? calls[2]?.headers?.cookie;
  expect(retryCookie ?? '').toContain('SAP_SESSIONID_HQ6=fresh');

  // Final state.
  expect((conn as any).csrfToken).toBe('fresh-token');
});
```

- [ ] **Step 2: Run the test — confirm it FAILS**

Run: `npx jest --testPathPatterns=AbstractAbapConnection -t "401 with cached CSRF token: invalidates"`

Expected: FAIL. The current code does not recognize this case; the original 401 error propagates and `mock` is called once, not three times.

- [ ] **Step 3: Commit the failing test**

```bash
git add src/__tests__/AbstractAbapConnection.test.ts
git commit -m "test: add failing test for stale CSRF 401 recovery"
```

---

## Task 3: Implement `invalidateSession()` and wire the new branch

**Files:**
- Modify: `src/connection/AbstractAbapConnection.ts`

- [ ] **Step 1: Add the `invalidateSession()` private method**

Insert this method directly above `private shouldRetryCsrf(error: unknown): boolean {` (around line 762):

```ts
/**
 * Clear SAP-side session state when SAP rejects the cached CSRF token + session
 * cookies (HTTP 401 on a mutation while a cached token exists). This forces the
 * next request path to fetch a fresh token and a fresh SAP_SESSIONID cookie.
 *
 * Distinct from reset(): this leaves the axios instance and interceptors in place.
 */
private invalidateSession(): void {
  this.setCsrfToken(null);
  this.cookies = null;
  this.cookieStore.clear();
}
```

Note: `setCsrfToken` already exists (line 627); `this.cookies` and `this.cookieStore` are private fields on the same class — direct access is fine.

- [ ] **Step 2: Wire detection and invalidation into `makeAdtRequest()`**

In `makeAdtRequest()`, locate the block starting at `// Retry logic for CSRF token errors (403 with CSRF message)` (around line 320). Replace this block:

```ts
      // Retry logic for CSRF token errors (403 with CSRF message)
      if (this.shouldRetryCsrf(error)) {
        this.logger?.debug(
          'CSRF token validation failed, fetching new token and retrying request',
          {
            url: requestUrl,
            method: normalizedMethod,
          },
        );

        this.csrfToken = await this.fetchCsrfToken(requestUrl, 5, 2000);
        if (this.csrfToken) {
          requestHeaders['x-csrf-token'] = this.csrfToken;
        }
        if (this.cookies) {
          requestHeaders.Cookie = this.cookies;
        }

        const retryResponse = await this.getAxiosInstance()(requestConfig);
        this.updateCookiesFromResponse(retryResponse.headers);

        return retryResponse as unknown as IAdtResponse<T, D>;
      }
```

with:

```ts
      // Detect the "login-form 401" pattern: SAP returned 401 for a mutation while
      // we have a cached CSRF token. The token and its bound SAP session must be
      // discarded before the retry. Basic auth only — JWT/SAML lifecycles are
      // managed elsewhere.
      const isCachedTokenStale =
        error instanceof AxiosError &&
        this.config.authType === 'basic' &&
        (normalizedMethod === 'POST' ||
          normalizedMethod === 'PUT' ||
          normalizedMethod === 'DELETE') &&
        error.response?.status === 401 &&
        this.getCsrfToken() !== null;

      // Retry logic for CSRF token errors (403 with CSRF message) and the
      // login-form 401 pattern.
      if (this.shouldRetryCsrf(error) || isCachedTokenStale) {
        this.logger?.debug(
          isCachedTokenStale
            ? 'Stale CSRF token / SAP session — invalidating and retrying'
            : 'CSRF token validation failed, fetching new token and retrying request',
          {
            url: requestUrl,
            method: normalizedMethod,
          },
        );

        if (isCachedTokenStale) {
          this.invalidateSession();
          delete requestHeaders.Cookie;
          delete requestHeaders.cookie;
        }

        try {
          this.setCsrfToken(await this.fetchCsrfToken(requestUrl, 5, 2000));
          if (this.getCsrfToken()) {
            requestHeaders['x-csrf-token'] = this.getCsrfToken() as string;
          }
          if (this.getCookies()) {
            requestHeaders.Cookie = this.getCookies() as string;
          }

          const retryResponse = await this.getAxiosInstance()(requestConfig);
          this.updateCookiesFromResponse(retryResponse.headers);

          return retryResponse as unknown as IAdtResponse<T, D>;
        } catch (retryError) {
          this.logger?.debug(
            `CSRF retry failed; rethrowing original error: ${
              retryError instanceof Error ? retryError.message : String(retryError)
            }`,
          );
          throw error;
        }
      }
```

Three functional changes:
1. New `isCachedTokenStale` branch + `invalidateSession()` call.
2. Stale `Cookie`/`cookie` entries are removed from the already-built `requestHeaders` object before CSRF refetch, so a refetch response without `set-cookie` cannot accidentally reuse the dead SAP session cookie.
3. Refetch + retry wrapped in `try`/`catch`; on secondary failure the **original** `error` is thrown (preserves the caller-visible error contract).

Style notes:
- Use `this.setCsrfToken(...)` and `this.getCsrfToken()` to stay consistent with the existing accessor pattern in this class.
- Direct field write `this.csrfToken = ...` also works (same file, private field) but accessor symmetry reads better in review.

- [ ] **Step 3: Run the new test — confirm it now PASSES**

Run: `npx jest --testPathPatterns=AbstractAbapConnection -t "401 with cached CSRF token: invalidates"`

Expected: PASS.

- [ ] **Step 4: Run all regression tests — confirm none broke**

Run: `npx jest --testPathPatterns=AbstractAbapConnection`

Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/connection/AbstractAbapConnection.ts
git commit -m "fix: recover from stale CSRF token via 401 + cached-token detection (#7)"
```

---

## Task 4: Add error-propagation tests (retry-also-fails)

**Files:**
- Modify: `src/__tests__/AbstractAbapConnection.test.ts`

These tests verify the `try`/`catch` wrapper from Task 3 step 2 preserves the original `AxiosError`.

- [ ] **Step 1: Test — retry POST also returns 401, original error propagates**

Add:

```ts
it('401 with cached token, retry also 401: original AxiosError propagates', async () => {
  const conn = new BaseAbapConnection(baseConfig, mockLogger);
  (conn as any).csrfToken = 'stale-token';
  (conn as any).cookies = 'SAP_SESSIONID_HQ6=dead';

  const originalError = makeAxiosError(
    401,
    '<html>first</html>',
    { method: 'POST', url: 'https://sap.example.com/sap/bc/adt/ddic/domains/zfoo' },
  );
  const secondError = makeAxiosError(
    401,
    '<html>second</html>',
    { method: 'POST', url: 'https://sap.example.com/sap/bc/adt/ddic/domains/zfoo' },
  );

  let call = 0;
  const mock = jest.fn().mockImplementation(async () => {
    call += 1;
    if (call === 1) throw originalError;
    if (call === 2) {
      return {
        status: 200,
        data: '',
        headers: { 'x-csrf-token': 'fresh-token' },
      };
    }
    throw secondError; // 3rd call: retry POST
  });
  attachMockAxios(conn, mock);

  await expect(
    conn.makeAdtRequest({
      url: '/sap/bc/adt/ddic/domains/zfoo',
      method: 'POST',
      data: '<x/>',
    }),
  ).rejects.toBe(originalError);

  expect(mock).toHaveBeenCalledTimes(3);
});
```

- [ ] **Step 2: Test — CSRF refetch itself fails, original error propagates**

Add:

```ts
it('401 with cached token, CSRF refetch fails: original AxiosError propagates', async () => {
  const conn = new BaseAbapConnection(baseConfig, mockLogger);
  (conn as any).csrfToken = 'stale-token';
  (conn as any).cookies = 'SAP_SESSIONID_HQ6=dead';

  const originalError = makeAxiosError(
    401,
    '<html>first</html>',
    { method: 'POST', url: 'https://sap.example.com/sap/bc/adt/ddic/domains/zfoo' },
  );
  const refetchError = makeAxiosError(
    500,
    'ICF service unavailable',
    { method: 'GET', url: 'https://sap.example.com/sap/bc/adt/core/discovery' },
  );

  const fetchSpy = jest
    .spyOn(conn as any, 'fetchCsrfToken')
    .mockRejectedValue(refetchError);
  const mock = jest.fn().mockRejectedValue(originalError);
  attachMockAxios(conn, mock);

  await expect(
    conn.makeAdtRequest({
      url: '/sap/bc/adt/ddic/domains/zfoo',
      method: 'POST',
      data: '<x/>',
    }),
  ).rejects.toBe(originalError);

  expect(mock).toHaveBeenCalledTimes(1);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 3: Run the new tests**

Run: `npx jest --testPathPatterns=AbstractAbapConnection`

Expected: all 7 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/AbstractAbapConnection.test.ts
git commit -m "test: verify original AxiosError propagates when CSRF retry fails"
```

---

## Task 5: Add negative tests — JWT, SAML, GET stay outside the new branch

**Files:**
- Modify: `src/__tests__/AbstractAbapConnection.test.ts`

These pin that the new branch fires ONLY for Basic auth on mutations.

- [ ] **Step 1: Test — JWT 401 on POST does not enter new branch**

JWT-auth tests need a different connection class. Import at the top of the test file:

```ts
import { JwtAbapConnection } from '../connection/JwtAbapConnection.js';
```

Then add:

```ts
it('JWT auth: 401 on POST with cached token does NOT trigger stale-CSRF retry', async () => {
  const jwtConfig: SapConfig = {
    url: 'https://sap.example.com',
    authType: 'jwt',
    jwtToken: 'jwt-abc',
    client: '100',
  };
  const conn = new JwtAbapConnection(jwtConfig, mockLogger);
  (conn as any).csrfToken = 'stale-token';
  (conn as any).cookies = 'SAP_SESSIONID_HQ6=dead';

  const originalError = makeAxiosError(
    401,
    '<html>login</html>',
    { method: 'POST', url: 'https://sap.example.com/sap/bc/adt/ddic/domains/zfoo' },
  );

  const mock = jest.fn().mockRejectedValue(originalError);
  attachMockAxios(conn, mock);

  await expect(
    conn.makeAdtRequest({
      url: '/sap/bc/adt/ddic/domains/zfoo',
      method: 'POST',
      data: '<x/>',
    }),
  ).rejects.toThrow('JWT token has expired. Please re-authenticate.');

  // Only the original POST from AbstractAbapConnection. No CSRF refetch, no stale-CSRF retry.
  // JwtAbapConnection wraps the original AxiosError into its JWT-expired error when no refresher is available.
  expect(mock).toHaveBeenCalledTimes(1);
  // Session state untouched.
  expect((conn as any).csrfToken).toBe('stale-token');
  expect((conn as any).cookies).toBe('SAP_SESSIONID_HQ6=dead');
});
```

- [ ] **Step 2: Test — SAML 401 on POST does not enter new branch**

Import at the top:

```ts
import { SamlAbapConnection } from '../connection/SamlAbapConnection.js';
```

Then add:

```ts
it('SAML auth: 401 on POST with cached token does NOT trigger stale-CSRF retry', async () => {
  const samlConfig: SapConfig = {
    url: 'https://sap.example.com',
    authType: 'saml',
    sessionCookies: 'MYSAPSSO2=abc',
    client: '100',
  };
  const conn = new SamlAbapConnection(samlConfig, mockLogger);
  (conn as any).csrfToken = 'stale-token';
  // SamlAbapConnection seeds cookies from sessionCookies; ensure SAP_SESSIONID also present.
  (conn as any).cookies = 'MYSAPSSO2=abc; SAP_SESSIONID_HQ6=dead';

  const originalError = makeAxiosError(
    401,
    '<html>login</html>',
    { method: 'POST', url: 'https://sap.example.com/sap/bc/adt/ddic/domains/zfoo' },
  );

  const mock = jest.fn().mockRejectedValue(originalError);
  attachMockAxios(conn, mock);

  await expect(
    conn.makeAdtRequest({
      url: '/sap/bc/adt/ddic/domains/zfoo',
      method: 'POST',
      data: '<x/>',
    }),
  ).rejects.toBe(originalError);

  expect(mock).toHaveBeenCalledTimes(1);
  expect((conn as any).csrfToken).toBe('stale-token');
});
```

- [ ] **Step 3: Test — GET 401 with cached token does not invalidate session**

The existing GET 401 retry branch handles this, but assert that the new branch (which would clear cookies) does NOT fire for GET.

```ts
it('GET 401 with cached token: does NOT invalidate session (new branch is mutation-only)', async () => {
  const conn = new BaseAbapConnection(baseConfig, mockLogger);
  (conn as any).csrfToken = 'cached-token';
  (conn as any).cookies = 'SAP_SESSIONID_HQ6=alive';
  (conn as any).cookieStore.set('SAP_SESSIONID_HQ6', 'alive');

  const mock = jest
    .fn()
    .mockRejectedValueOnce(
      makeAxiosError(
        401,
        '<html>login</html>',
        { method: 'GET', url: 'https://sap.example.com/sap/bc/adt/oo/classes/zcl_x' },
      ),
    )
    .mockResolvedValueOnce({ status: 200, data: 'ok', headers: {} });
  attachMockAxios(conn, mock);

  const res = await conn.makeAdtRequest({
    url: '/sap/bc/adt/oo/classes/zcl_x',
    method: 'GET',
  });

  expect(res.status).toBe(200);
  // Session state untouched by the new branch (existing GET branch reuses cookies as-is).
  expect((conn as any).csrfToken).toBe('cached-token');
  expect((conn as any).cookies).toContain('SAP_SESSIONID_HQ6=alive');
});
```

- [ ] **Step 4: Run the full test file**

Run: `npx jest --testPathPatterns=AbstractAbapConnection`

Expected: all 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/AbstractAbapConnection.test.ts
git commit -m "test: pin JWT/SAML/GET outside new stale-CSRF retry branch"
```

---

## Task 6: Full build + acceptance

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected: all tests PASS, no regressions in `connectionFactory.test.ts`, `jwt-connection.test.ts`, `saml-connection.test.ts`, etc.

- [ ] **Step 2: Run the build**

Run: `npm run build`

Expected: PASS. Biome lint clean, tsc compiles.

- [ ] **Step 3: If any Biome issues, fix and recommit**

If Biome flagged anything (formatting, unused imports), run:

```bash
npm run lint
```

Review the auto-fixes, then:

```bash
git add -A
git commit -m "chore: biome auto-fix"
```

- [ ] **Step 4: Verify git log**

Run: `git log --oneline master..HEAD`

Expected: 4–5 commits (test pin + failing test + fix + propagation tests + negative tests, plus optional biome).

---

## Acceptance Checklist (from spec)

- [ ] New unit tests pass (Task 1–5).
- [ ] Existing test suite passes unchanged (Task 6 step 1).
- [ ] `npm test` passes (Task 6 step 1).
- [ ] `npm run build` passes — Biome + tsc (Task 6 step 2).
- [ ] Out-of-band: comment on issue #7 asking reporter to retest `CreateDomain` with the fix. Not part of this plan's CI gate.
