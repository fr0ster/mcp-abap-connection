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

A stateless request holds no lock and no lock state: locks live only in the stateful requests, in
this stack the `LOCK` and the `UNLOCK`. A stateful request (any request the connection's stateful
verdict names) whose answer shows the session replaced keeps failing loudly, with
`ADT_SESSION_REPLACED`, as today.

## Invariants

- **No resend.** The connection never sends a request again because the session was replaced: not
  the request itself, not on a new session, not through the CSRF retry or the credential retry. The
  answer a stateless request receives is the one the caller gets. The one named resend the HTTP
  wire already makes (a pooled socket that carried no byte of an answer) is unchanged.
- **Stateless means what the wire already means by it.** A request is stateful exactly when the
  connection's existing verdict says so (`isStatefulRequest`: marked `stateful`, or carrying
  `x-sap-adt-sessiontype: stateful`); every other request is stateless. A stateless request holds
  no lock and no lock state; a lock is taken and released only by stateful requests.
- **Stateful keeps failing.** A stateful request whose answer shows the session replaced rejects
  with `ADT_SESSION_REPLACED`, its answer not handed back, exactly as today.
- **The answer is SAP's, as it is.** What the stateless request returns is the answer that showed
  the replacement: a success is returned as that success, a refusal rejects as that refusal (its
  status, headers and body, not `ADT_SESSION_REPLACED`) — on every attempt that carries the
  caller's request (the first, the CSRF retry's resend, the resend after a credential renewal),
  never an earlier attempt's error in its place. The connection's own exchanges (a CSRF fetch, a
  logon) carry no answer of the caller's. Nothing in the answer is
  rewritten. A refusal that shows the replacement starts no recovery: a `403` "CSRF token
  validation failed" gets no CSRF retry, a `401` no credential renewal and resend.
- **The session is lost, observably, before the caller has the answer.** By the time the stateless
  request's success or refusal reaches the caller:
  - the instance is spent, as after any session loss today: `isConnected()` is `false`, and
    `connect()` and every later request reject `ADT_SESSION_ERROR.NOT_CONNECTED` with nothing sent;
  - `sessionCookies()` is `null`: neither the old session nor the replacing one is handed out;
  - the logoff of the session SAP opened with the replacing answer has been dispatched, as a
    replacement dispatches it today — best effort: a dispatch cannot promise the server ended that
    session. `disconnect()` is still owed once and settles when that logoff is written or its close
    is over, written or not; `flushGoodbye()` when its close is over. A logoff that fails does not
    replace the caller's answer;
  - the consumer can tell, without parsing words, that the session was lost at that answer — for a
    returned success and for a rejected refusal alike, and attributable to that request when
    several are in flight. How it is said is a question for the spec; a log line alone does not
    count, nor does a later `isConnected()` or the next request's `NOT_CONNECTED` alone.
- **Every wire, one rule.** The rule is decided in the connection, from the classification the
  connection already makes, never from which wire carries the request. Over RFC no answer replaces
  the session, and an RFC error that ends the stateful conversation stays `ADT_SESSION_REPLACED`.
- **Session reported gone is unchanged.** An answer saying the session no longer exists (today: a
  `400` whose status text or string body holds, without case, "session not found", "Session Timed
  Out or Not Found" or "Session no longer exists") that does not show a replacement stays
  `ADT_SESSION_REPLACED` for every request. A stateless request whose answer both shows a
  replacement and says the session is gone is a replacement first, as it is seen today: its
  refusal is the caller's, with the loss told as for any replacement.
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

**Measured** on onprem over HTTP, with raw requests — background facts about what SAP answers:

- On a dead `SAP_SESSIONID`, a stateless GET answers `200` with a valid body and a new session
  cookie — the #354 case.
- The logoff of a session releases the locks taken in it. A request carrying the lock handle of a
  session that is gone is refused `423` `ExceptionResourceInvalidLockHandle` in every variant
  tried (sent from a fresh session; from a session SAP re-created on the old cookies; while another
  session holds a new lock on the object), and the object is unchanged.
- On a dead `SAP_SESSIONID`, a mutation with the old CSRF token gets `403` "CSRF token validation
  failed", also with a new session cookie; with a fresh CSRF token, such a request carrying a gone
  session's lock handle gets `423`.
- A request that still sends the old stateful `sap-contextid` cookie gets `400` with an HTML
  "Session no longer exists" page, not an ADT exception, and SAP sets new context cookies.

**Code** at 22.0.1 (`src/connection/AbstractAbapConnection.ts`, `src/connection/HttpTransport.ts`,
`src/session/SessionLifecycle.ts`):

- An answer goes through `observeResponse`, which folds its headers into the wire (`ingest`) and
  classifies the session fingerprint (`SessionLifecycle.observe`). The fingerprint is the non-empty
  `SAP_SESSIONID*` cookies only (a deleted one leaves it). A tracked name whose value changed is
  `replaced`, and that wins over a name newly added; a new name alone is `established`; a name that
  disappeared is not a replacement. An answer whose lease is stale (its session generation moved)
  is not folded in, and a successful one is still returned to its caller (`sendObserved`); the
  wire's own exchanges refuse a stale answer with `NOT_CONNECTED` (`leasedContext`).
- `applyIdentityPolicy` acts on `replaced` for every request alike: it logs off the replacing
  session (`endSession`), clears the CSRF token and the wire's cookies, raises the session lost and
  throws `ADT_SESSION_REPLACED` ("…anything held against the old session — a lock and any write
  under it — is dead. … Nothing is retried here."). The answer already received is discarded.
- `raiseSessionLost` marks the instance spent, begins a teardown with `sessionLost` (admission shuts
  at once, the session generation moves so in-flight leases go stale, the fingerprint is cleared)
  and logs a `warn` "Session lost: …". After it `isConnected()` is `false` and every request is
  refused `ADT_SESSION_ERROR.NOT_CONNECTED` with nothing sent.
- Where one request's answers are observed: the success of every attempt (`sendObserved`); the
  refusal of the first attempt (`recoverOnWire`, before the CSRF retry); the refusal of the resend
  after a credential renewal (`answerCredentialFailure`). The refusal of the CSRF retry's resend is
  **not** observed: its catch checks the session-dead text and precedence and may rethrow the
  first attempt's error, so a changed session cookie on that refusal goes unnoticed. The wire's own
  requests (the CSRF fetch, the logon) observe through the session context.
- While the request's lease is current, on the paths that observe a refusal (the first attempt in
  `recoverOnWire`, the resend after a credential renewal in `answerCredentialFailure`) the headers are observed before the session-dead
  text is checked, so an answer carrying both a changed `SAP_SESSIONID` and one of the session-dead
  phrases is a replacement first. On the CSRF retry's resend the headers are not observed: such an answer
  takes the session-dead path, and the replacing session's logoff is not dispatched.
- The replacing session's logoff is dispatched without waiting (`dispatchGoodbye`): a `close()`
  that fails is logged and absorbed, and its write waiter settles when the close is over, written
  or not.
- `throwIfSessionDead` raises the session lost and throws `ADT_SESSION_REPLACED` for a
  `WireSessionLostError` (RFC) and for a `400` whose status text or string body contains, compared
  lower-cased, one of the three phrases of `DEAD_SESSION_PHRASES` (`isDeadSessionResponse`):
  "session not found", "session timed out or not found" (SAP ICM's session-expired page) and
  "session no longer exists". Any other status is not read for them; an answer to a request whose
  lease is stale is not acted on. It applies to every request,
  stateful ones (`LOCK`, `UNLOCK`) included; the instance is spent and no logoff is dispatched, as
  the old session is SAP's to have ended.
- The connection sets `request.stateful` from its session mode (`setSessionType('stateful')`);
  every wire reads statefulness through one predicate, `isStatefulRequest`: that flag, or the
  header `x-sap-adt-sessiontype: stateful` (name and value without case) a caller wrote itself. The
  HTTP wire calls it while dressing a request, the legacy wire before it drops the header. Any
  request can be stateful; `@mcp-abap-adt/adt-clients` marks only `LOCK` and `UNLOCK`.
  `beginCriticalSection()` changes only the request deadline; it does not make a request stateful.
- **`sap-contextid` on stateless requests:** the HTTP wire does not send it. `HttpTransport.dress`
  strips `sap-contextid` from the merged `Cookie` header of every request that is not stateful
  (`withoutContextCookie`), the caller's own `Cookie` included; only stateful requests (`LOCK`,
  `UNLOCK`) carry it. The jar keeps the cookie after a `LOCK` for the stateful requests that
  follow; the logoff never carries it (`logoffCookies`). `LegacyOnPremHttpTransport` and the cloud
  wire go through the same `dress`.
- **A `400` "Session no longer exists" today:** it matches `isDeadSessionResponse`, so, while the
  request's lease is current, it rejects `ADT_SESSION_REPLACED` and spends the instance on every
  path; a request whose lease is stale gets its own error back, or `NOT_CONNECTED`, and nothing is
  acted on (`recoverOnWire`, `throwIfSessionDead`). On a path that observes the refusal
  (the first attempt, the resend after a credential renewal) its cookies are folded in first: if
  the answer also changes the value of the tracked `SAP_SESSIONID`, it is a replacement (the
  replacing session's logoff dispatched); otherwise it is the session reported gone (no logoff). A
  new `sap-contextid` alone is not part of the fingerprint. On the CSRF retry's resend the refusal
  is not observed: it is the session reported gone. Whether that answer sets a new `SAP_SESSIONID`
  the measurement above does not say. Since the connection sends `sap-contextid` only on stateful
  requests, the measured trigger (the old context cookie sent) arises only from a stateful
  request; whether SAP sends the same page for anything else is not known.

## Open questions for the spec

- **How the consumer is told.** The loss must be attributable to the answer that showed it, for a
  returned success and for a rejected refusal, without words. Candidates: a typed mark on the
  returned response and on the refusal, or an event or callback naming the request. Which one, and
  whether it needs a contract change in `@mcp-abap-adt/interfaces-adt-connection`.
- **The connection's own exchanges.** A replacement seen on the CSRF fetch of a mutation's retry,
  on a logon or on `connect()`: those carry no answer of the caller's to keep. Do they stay
  `ADT_SESSION_REPLACED`, and does the mutation's request then reject with it?
- **The session-dead pages and a new `SAP_SESSIONID`.** Do SAP's session-dead `400` answers ("Session
  no longer exists", "Session Timed Out or Not Found") set a new `SAP_SESSIONID`, and can a stateless
  request receive one? That decides whether such an answer is a replacement (its refusal the
  caller's, the replacing session logged off) or only the session reported gone; it is measured
  before the spec fixes the tests.
- **Requests in flight at the moment of loss.** Another request on the same instance whose answer
  arrives after the loss has a stale lease: today a success is returned unobserved, a refusal's
  recovery is fenced and the error rethrown or replaced by `NOT_CONNECTED`, and the wire's own
  exchanges refuse it. Does the spec keep that as it is, and how is such a request told the session
  was lost?
- **Cloud and legacy.** Neither is measured. Whether a cloud security session is replaced on a
  stateless request the same way, and whether the legacy wire (no `SAP_SESSIONID` named on that
  release) ever sees a replacement.

## Out of scope

- Re-sending a request, on the old session or a new one — the stack has no retries by default.
- Opening a new session on the same instance: a new session is a new instance, the consumer's.
- What the server or the ADT clients do with the loss (reconnecting, the error text in
  `@mcp-abap-adt/adt-clients`): the next links of the chain.
- RFC: no answer replaces its session.
