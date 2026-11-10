# Migration to 21.0

21.0.0 fetches the CSRF token of a logon with one request. Before, a fetch that
failed was asked again three times, a second apart: a logon against a closed
port made four requests and reported its failure about three seconds later.
A failed request is its own error now — the caller hears it at once, as SAP or
the network gave it, and whether to try again is the caller's to decide.

The fallback endpoint stays, and is not a retry: `/sap/bc/adt/discovery` is
asked, once, only after `/sap/bc/adt/core/discovery` answered `404` (or `501`)
— a system that has no such endpoint (BASIS < 7.52).

The one named resend stays too: a request sent on a pooled kept-alive socket
that ended before any byte of an answer is sent once more on a new connection
(see "Kept-alive connections, and the one resend" in [USAGE](./USAGE.md)).

## What changed

- **The token fetch is one request per endpoint**, with no delay: on
  `connect()`, before a mutation that holds no token, and in the recovery
  after a `403` "CSRF token validation failed" (which asked up to six times,
  two seconds apart). A `500`, a refused connection or a `200` without a token
  ends the fetch at once with that error: `connect()` rejects with it, the
  recovery rethrows the error it started from, as before, and the fetch before
  a mutation is still only logged, the mutation sent as it was.
- **Removed from the public surface:**
  - `CSRF_CONFIG.RETRY_COUNT` and `CSRF_CONFIG.RETRY_DELAY`;
  - `IAdtEstablishContext.retries` and `IAdtEstablishContext.retryDelayMs`;
  - `IAdtEstablishContext.isFatal`. It said which failures must not be
    retried. With nothing retried it has nothing left to decide: a session
    verdict the connection throws (from `authorize` or `observe`) carries no
    response, so the wire neither folds it in nor reads it as an absent
    endpoint, and it reaches the caller as it is;
  - the `retryCount` and `retryDelay` parameters of the protected
    `fetchCsrfToken(url, retryCount?, retryDelay?, fence?)`, now
    `fetchCsrfToken(url, fence?)`;
  - the protected `endsTheExchange(error)`, which only fed `isFatal`.

  `IAdtEstablishContext` itself stays, now with the members of
  `IAdtSessionContext`. `CSRF_CONFIG.ENDPOINT`, `FALLBACK_ENDPOINT`,
  `REQUIRED_HEADERS` and `CSRF_ERROR_MESSAGES` are unchanged.

## What to do

**Code that read `CSRF_CONFIG.RETRY_COUNT` or `RETRY_DELAY`** (a connection
class of your own, say) drops them. To fetch a token the way this package
does: one request to `ENDPOINT`, and one to `FALLBACK_ENDPOINT` only when the
first answered `404` — see the `CSRF_CONFIG` example in [USAGE](./USAGE.md).

**A wire of your own** (`IAdtTransport.establish(context)`) that read
`context.retries`, `context.retryDelayMs` or `context.isFatal` stops reading
them: the connection no longer passes them. If your wire repeats its own
exchange, the connection's rule is that it should not.

**A subclass that called `fetchCsrfToken`** drops the two numbers:

```diff
-this.fetchCsrfToken(url, 0, 0, generation)
+this.fetchCsrfToken(url, generation)
```

**A subclass that overrode `endsTheExchange`** removes the override: nothing
calls it.

**A caller that relied on the retries** to ride out a system that was not
answering yet — an application server restarting, a tunnel coming up — waits
and calls `connect()` again on a new instance, on its own schedule. A failed
`connect()` that received no session cookie leaves its instance usable, and
`connect()` may be called on it again (see "Session Lifecycle" in
[USAGE](./USAGE.md)).

If you only call `createConnection`, the connectors and `makeAdtRequest`, there
is nothing to change in your code; a failure to fetch the token reaches you
sooner.
