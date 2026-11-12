# Goal: a stateless request keeps its answer when the SAP session was replaced

## Goal

A consumer whose connection idled long enough for SAP to replace the session behind it gets, for
the first stateless request after the pause, the answer SAP gave to that request — the status,
headers and body SAP sent, as for any other request — instead of `ADT_SESSION_REPLACED`. A
read-only tool no longer fails once and succeeds on the same call right after.

The session is still lost, and the consumer is told so: the instance stops being usable as it does
today after a replacement, so whatever the consumer held against the old session is never presented
as still held, and a new session is a new instance the consumer creates. Nothing is sent twice to
get there: the answer returned is the one already received.

A stateful request — the one that takes or releases a lock — whose answer shows the session
replaced keeps failing loudly, with `ADT_SESSION_REPLACED`, as today.

## Invariants

- **No resend.** The connection never sends a request again because the session was replaced: not
  the request itself, not on a new session, not through the CSRF retry or the credential retry. The
  answer a stateless request receives is the one the caller gets. The one named resend the HTTP
  wire already makes (a pooled socket that carried no byte of an answer) is unchanged.
- **Stateless means what the wire already means by it.** A request is stateful exactly when the
  connection's existing verdict says so (`isStatefulRequest`: marked `stateful`, or carrying
  `x-sap-adt-sessiontype: stateful`); every other request is stateless. The connection does not
  guess which stateless request is a read and which a write under a lock: it cannot tell them
  apart, and it does not try.
- **Stateful keeps failing.** A stateful request whose answer shows the session replaced rejects
  with `ADT_SESSION_REPLACED`, its answer not handed back, exactly as today.
- **The answer is SAP's, as it is.** What the stateless request returns is what the wire received:
  a success is returned as a success, a refusal rejects as that refusal would on a live session
  (its status and body, not `ADT_SESSION_REPLACED`). Nothing in the answer is rewritten.
- **The session is lost, observably.** Once a stateless request has seen a replacement:
  - the instance is spent, as after any session loss today: `isConnected()` is `false`, and
    `connect()` and every later request reject `ADT_SESSION_ERROR.NOT_CONNECTED` with nothing sent;
  - the session SAP opened with the replacing answer is logged off, as a replacement logs it off
    today, so it does not stay open on the server until its idle timeout; `disconnect()` is still
    owed once and waits for that logoff's write, `flushGoodbye()` for its answer;
  - `sessionCookies()` is `null`: neither the old session nor the replacing one is handed out;
  - the consumer can tell, without parsing words, that the session was lost at that answer (how it
    is said is a question for the spec, below); a log line alone does not count.
- **A lost lock is never hidden.** Returning a stateless request's answer must not let a write under
  a lock from the old session be reported as having succeeded. The measurements below show SAP
  refuses such a write after a replacement (403 or 423); the invariant is that the connection adds
  nothing that could turn such a refusal into success — no resend with a fresh CSRF token, no
  adopted session.
- **Every wire, one rule.** The rule is decided in the connection, from the classification the
  connection already makes, never from which wire carries the request. Over RFC no answer replaces
  the session, and an RFC error that ends the stateful conversation stays `ADT_SESSION_REPLACED`, as
  in 22.0.0.
- **Session reported gone is unchanged.** An answer saying the session no longer exists (today: a
  `400` matching "session not found") stays `ADT_SESSION_REPLACED` for every request: there is no
  valid answer to keep.
- **No timeouts, retries or polling** beyond the named exceptions the connection already states.
- **Static types first.** What the compiler can prove is not checked again at run time.
- **Tests are load-bearing.** Every unit test that protects one of these invariants goes red when
  the rule it protects is broken on purpose — the stateless/stateful split above all, each half on
  its own.
- **Proved live.** Against onprem over HTTP: a stateless GET on a session SAP replaced returns its
  `200` and body, the instance is then spent with nothing sent by the next request, the replacing
  session is logged off; a stateful request on a replaced session rejects `ADT_SESSION_REPLACED`.
- **The docs describe the new contract.** README, `docs/USAGE.md` ("When the session is lost") and
  a migration note say which requests keep their answer, what the consumer is told, and what it
  must do next (a new instance).

## What there is today

**Measured** on onprem over HTTP, with raw requests:

- A stateless write carrying the lock handle of a logged-off session is refused `423`
  `ExceptionResourceInvalidLockHandle` in every variant tried: sent from a fresh session; sent from
  a session SAP re-created on the old cookies; sent while another session holds a new lock on the
  object. The source is unchanged after each. The logoff itself releases the lock.
- On a dead `SAP_SESSIONID`, a stateless GET answers `200` with a valid body and a new session
  cookie — the #354 case.
- On a dead `SAP_SESSIONID`, a write with the old CSRF token gets `403` "CSRF token validation
  failed", also with a new session cookie, before the lock is checked; with a fresh CSRF token it
  gets `423`.
- A request that still sends the old stateful `sap-contextid` cookie gets `400` with an HTML
  "Session no longer exists" page, not an ADT exception, and SAP sets new context cookies.

**Inference** from the above: after a replacement, a write under a lost lock never succeeds
silently — it is `403` or `423` — so returning the received answer of a stateless request cannot
hide a lost lock, as long as nothing resends it with a fresh CSRF token.

**Code** (`src/connection/AbstractAbapConnection.ts`, `src/connection/HttpTransport.ts`,
`src/session/SessionLifecycle.ts`):

- Every answer, success or refusal, goes through `observeResponse`, which folds its headers into the
  wire (`ingest`) and classifies the session fingerprint (`SessionLifecycle.observe`). The
  fingerprint is the `SAP_SESSIONID*` cookies only; a changed value is `replaced`, a new name is
  `established`.
- `applyIdentityPolicy` acts on `replaced` for every request alike: it logs off the replacing
  session (`endSession`), clears the CSRF token and the wire's cookies, raises the session lost and
  throws `ADT_SESSION_REPLACED` ("…anything held against the old session — a lock and any write
  under it — is dead. … Nothing is retried here."). The answer already received is discarded.
- `raiseSessionLost` marks the instance spent, begins a teardown with `sessionLost` (admission shuts
  at once, the session generation moves so in-flight leases go stale, the fingerprint is cleared)
  and logs a `warn` "Session lost: …". After it `isConnected()` is `false` and every request is
  refused `ADT_SESSION_ERROR.NOT_CONNECTED` with nothing sent.
- The replacement is checked in four places of one request: the answer of the first attempt
  (`sendObserved`), the refusal of the first attempt (`recoverOnWire`, before the CSRF retry), the
  CSRF fetch and resend of the CSRF retry, and the resend after a credential renewal
  (`answerCredentialFailure`). The wire's own requests (CSRF fetch, logon) observe through the
  session context.
- `throwIfSessionDead` raises the session lost and throws `ADT_SESSION_REPLACED` for a
  `WireSessionLostError` (RFC) and for a `400` whose status text or string body contains "session
  not found" (lower-cased match).
- Stateful is decided once for every wire by `isStatefulRequest`: `request.stateful` (set from the
  connection's session mode, `setSessionType('stateful')`) or the header
  `x-sap-adt-sessiontype: stateful`. `beginCriticalSection()` changes only the request deadline; it
  does not make a request stateful.
- **`sap-contextid` on stateless requests:** the HTTP wire does not send it. `HttpTransport.dress`
  strips `sap-contextid` from the merged `Cookie` header of every request that is not stateful
  (`withoutContextCookie`), the caller's own `Cookie` included; only stateful requests (`LOCK`,
  `UNLOCK`) carry it. The jar keeps the cookie after a `LOCK` for the stateful requests that
  follow; the logoff never carries it (`logoffCookies`). `LegacyOnPremHttpTransport` and the cloud
  wire go through the same `dress`.
- **A `400` "Session no longer exists" today:** it does not match `isDeadSessionResponse` ("session
  not found" only). Its cookies are folded in: a new `sap-contextid` replaces the jar's, which is not
  part of the fingerprint. If the answer also brings a different `SAP_SESSIONID`, it is a
  replacement and the request rejects `ADT_SESSION_REPLACED`; if not, the `400` reaches the caller as
  SAP's refusal and the instance stays connected, now holding the new context cookie. Which of the
  two happens depends on whether that answer sets `SAP_SESSIONID`, which the measurement above does
  not say. Because stateless requests carry no `sap-contextid`, this `400` can only come from a
  stateful request.

## Open questions for the spec

- **How the consumer is told.** The answer is returned; the loss must be readable without words.
  Candidates: a typed mark on the returned response, an event or callback the connection already
  has or adds, the next request's `NOT_CONNECTED` alone, or `isConnected()` read by the consumer.
  Which one, and whether it needs a contract change in `@mcp-abap-adt/interfaces-adt-connection`.
- **Refusals of a stateless request on a replaced session.** A stateless request whose answer is a
  refusal (a `404`, a `403` "CSRF token validation failed", a `423`) with a new session cookie: does
  it reject with SAP's refusal as it is, and is the CSRF retry then skipped (it would resend on the
  new session)? The invariants say SAP's answer as it is and no resend; the spec states each path.
- **The wire's own requests.** A replacement seen on the CSRF fetch of a mutation, on a logon or on
  `connect()`: those carry no answer of the caller's to keep. Do they stay `ADT_SESSION_REPLACED`?
- **The `400` "Session no longer exists" page.** Should a stateful request that gets it be read as
  the session reported gone (`ADT_SESSION_REPLACED`), like "session not found"? Measure whether that
  answer sets a new `SAP_SESSIONID`, and whether the "session not found" text still occurs on onprem
  at all.
- **Requests in flight at the moment of loss.** Another stateless request on the same instance whose
  answer arrives after the loss is fenced today (its lease is stale). Does it keep its answer too, or
  stay `NOT_CONNECTED`?
- **Cloud and legacy.** Neither is measured. Whether a cloud security session is replaced on a
  stateless request the same way, and whether the legacy wire (no `SAP_SESSIONID` named on that
  release) ever sees a replacement.

## Out of scope

- Re-sending a request, on the old session or a new one — the stack has no retries by default.
- Opening a new session on the same instance: a new session is a new instance, the consumer's.
- What the server or the ADT clients do with the loss (reconnecting, the error text in
  `@mcp-abap-adt/adt-clients`): the next links of the chain.
- Telling a read from a write under a lock: the connection cannot, and does not need to.
- RFC: no answer replaces its session.
