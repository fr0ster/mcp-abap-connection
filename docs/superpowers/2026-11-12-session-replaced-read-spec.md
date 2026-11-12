# Spec: a stateless request keeps its answer when the SAP session was replaced

Bound by `2026-11-12-session-replaced-read-goal.md`. Release: section 8.

Every claim is tagged: **Code** (read in this repository at 22.0.1, or in the named package at its
published version), **Measured** (run against a real system), **Inference** (reasoned, not
checked). Points left to the owner are marked **Open**.

## 1. What exists today

The goal's "What there is today" holds the facts this spec builds on; the ones the decisions below
lean on:

- `applyIdentityPolicy` throws `ADT_SESSION_REPLACED` for every answer whose fingerprint is
  `replaced`, after `endSession` (the replacing session's logoff dispatched), `clearSessionState`
  and `raiseSessionLost` (Code: `AbstractAbapConnection.ts`). It runs inside `observeResponse`,
  which is called for the success of every attempt (`sendObserved`), for the refusal of the first
  attempt (`recoverOnWire`), for the refusal of the resend after a credential renewal
  (`answerCredentialFailure`) and, through the session context, for the connection's own exchanges
  (CSRF fetch, logon, `connect()`); not for the refusal of the CSRF retry's resend (Code).
- `raiseSessionLost` is synchronous: when it returns, admission is shut, the generation has moved,
  `isConnected()` is `false`; `clearSessionState` has emptied the jar, so `sessionCookies()` is
  `null` (Code: `SessionLifecycle.beginTeardown`, `HttpTransport.forgetSession`).
- The base builds `requestConfig.stateful` from its session mode; every wire reads statefulness with
  `isStatefulRequest(request)` (`statefulRequest.ts`), the flag or the caller's
  `x-sap-adt-sessiontype: stateful` header (Code).
- `isSessionVerdict(error)` is true for an error whose `code` is `ADT_SESSION_REPLACED`,
  `ADT_NOT_CONNECTED` or `ADT_RELEASE_PENDING`; the retry paths rethrow such an error unchanged
  (`outranksOriginal`, `answerCredentialFailure`, `staleVerdict`) (Code).
- `IAbapConnection.makeAdtRequest` resolves `IAdtWireResponse<T, D>`; a connection throws an `Error`
  conforming to `IAbapConnectionError` (`code?`, `rfc?`) (Code:
  `@mcp-abap-adt/interfaces-adt-connection` 4.1.0).
- The #354 case through the connection 22.0.1: the stateless `GET` after the session died rejects
  `ADT_SESSION_REPLACED`, without SAP's answer on the error (Measured).

## 2. The measurement (onprem, over HTTP, raw requests)

The goal's open question "do the session-dead `400` answers set a new `SAP_SESSIONID`, and can a
stateless request receive one" (Measured, every row):

| Session | `sap-contextid` sent | Stateful header | Credential | Answer | `SAP_SESSIONID` set | Phrases in body |
|---|---|---|---|---|---|---|
| live | none | no | no | `200` ADT | none | — |
| live | its own, current | no | no | `200` ADT | none | — |
| live | one never issued | no | yes | `400` `text/html` | none | timed out or not found; no longer exists |
| logged off | none | no | yes | `200` ADT | **new** | — |
| logged off | none | no | no | `401` | none | — |
| logged off | the old one | no | yes | `400` `text/html` | none | timed out or not found; no longer exists |
| logged off | the old one | yes | yes | `400` `text/html` | none | timed out or not found; no longer exists |
| logged off | the old one | no | no | `400` `text/html` | none | timed out or not found; no longer exists |
| logged off | none | yes | yes | `200` ADT | **new** (and a new `sap-contextid`) | — |
| none (context cookie alone) | the old one | no | yes | `400` `text/html` | none | timed out or not found; no longer exists |

Every `400` set `sap-contextid` cookies and no `SAP_SESSIONID`. "session not found" was not seen.

What follows:

- The session-dead `400` page is SAP's answer to a `sap-contextid` it does not know, whatever else
  the request carries; it never set a `SAP_SESSIONID`, so it never shows a replacement (Measured).
- A request without `sap-contextid` never got it (Measured). The connection sends `sap-contextid`
  only on stateful requests (Code: `HttpTransport.dress`, `withoutContextCookie`). So a stateless
  request of this connection does not receive that page (Inference from both).
- The #354 answer — a valid `200` with a new `SAP_SESSIONID` — is what a request without the context
  cookie gets on a dead session, stateful header or not (Measured).

## 3. The open questions of the goal, answered

### 3.1 How the consumer is told — `sessionLost`

- **On the answer itself.** The answer a stateless request returns after its own answer showed the
  replacement carries an own property `sessionLost` with the value
  `ADT_SESSION_ERROR.SESSION_REPLACED`:
  - a success: the resolved `IAdtWireResponse` has `sessionLost`;
  - a refusal: the rejected error — SAP's refusal as the wire threw it, its `response`, `code` and
    message unchanged — has `sessionLost`.
- **Absent otherwise.** No other answer carries it: not one that showed no replacement, not a
  stateful request's (which rejects `ADT_SESSION_REPLACED` as today), not an answer with a stale
  lease (3.4). A consumer reads `sessionLost !== undefined`, typed, without parsing words.
- **Attributable.** The mark is on the one object that answers the one request whose answer showed
  the replacement; other requests in flight do not get it (3.4).
- **Before the caller has it.** The mark is set after the session is lost (`raiseSessionLost` and
  the cleanup, synchronous) and before the answer settles, so a consumer reading `isConnected()` in
  its continuation reads `false` (Code for the synchronous loss; unit-tested for the order).
- Why not the next request's `NOT_CONNECTED`, `isConnected()` or a callback: the first two are not
  attributable to an answer (goal); a callback is a second channel a consumer must wire before the
  first request, and a forgotten one loses the fact. The mark travels with the answer (Inference).
- The `warn` "Session lost: …" line stays (Code); it is not the signal.

### 3.2 Each attempt that carries the caller's request

For a stateless request (`isStatefulRequest(requestConfig)` false), on each attempt, while its
lease is current:

| Attempt | Answer shows the replacement | Result |
|---|---|---|
| first | success | resolves that answer, marked |
| first | refusal (any status, `401` and `403` "CSRF token validation failed" included) | rejects that refusal, marked; no CSRF retry, no credential renewal |
| CSRF retry's resend | success | resolves, marked |
| CSRF retry's resend | refusal | rejects that refusal, marked — **its refusal is now observed**, never replaced by the first attempt's error |
| resend after a credential renewal | success | resolves, marked |
| resend after a credential renewal | refusal | rejects that refusal, marked; no further renewal |

The CSRF retry's resend's refusal is observed like the other two refusals, before
`throwIfSessionDead` (closes the gap in the goal's Code facts). A marked error is a session verdict
for every retry path: `isSessionVerdict` is true for an error carrying `sessionLost`, so
`outranksOriginal`, `answerCredentialFailure` (checked first, before `credentialRejection`) and
`staleVerdict` rethrow it unchanged.

A stateful request on any of these attempts: `ADT_SESSION_REPLACED`, as today.

A stateless answer that both shows the replacement and holds a session-dead phrase is a replacement
first (goal): the refusal, marked. Per section 2 this does not arise from SAP's page on a stateless
request of this connection; it is the rule if another answer ever does.

### 3.3 The connection's own exchanges

A replacement seen on an exchange that is not an attempt of the caller's request stays
`ADT_SESSION_REPLACED`, as today: the CSRF fetch inside the CSRF retry, the logon, the CSRF fetch of
`connect()` (and the resume of `createConnection({ session })`). There is no answer of the caller's
to keep. For the CSRF retry, the mutation's request rejects with that `ADT_SESSION_REPLACED`, which
outranks the first attempt's error (Code: `outranksOriginal`); nothing is resent, because the
replacement was seen before the resend.

### 3.4 Requests in flight at the moment of loss

Unchanged. A request whose lease went stale gets what it gets today: a success returned unobserved
and unmarked (it was answered by the session it was sent on, or its answer is not acted on); a
refusal's recovery fenced, the error rethrown or replaced by `NOT_CONNECTED`; the wire's own
exchanges refuse it (Code). It learns of the loss from its next request (`NOT_CONNECTED`). Only the
request whose own answer showed the replacement is marked: that is the attribution the goal asks
for.

### 3.5 The session-dead pages

Section 2 answers it: the pages set no `SAP_SESSIONID`, so they are the session reported gone, never
a replacement; `isDeadSessionResponse` (22.0.1) already reads them as `ADT_SESSION_REPLACED` for
every request, and that stays (goal). Nothing changes for them here.

### 3.6 Cloud and legacy

One rule, decided in the base from `isStatefulRequest` and the fingerprint, never from the wire's
kind (goal). Cloud and the legacy wire share `HttpTransport`'s jar and fingerprint (Code), so a
`SAP_SESSIONID` that changes on their answer takes the same path. Neither is measured: whether a
cloud security session is replaced on a stateless request, and whether a legacy system ever sets a
new `SAP_SESSIONID`, stay unknown (**Open**, not needed for this change: no wire-specific code is
written). The live proof is onprem over HTTP (goal).

## 4. The contract — `@mcp-abap-adt/interfaces-adt-connection` 4.2.0

Additive, types only, a **minor** (4.1.0 → 4.2.0), in `fr0ster/mcp-abap-adt-interfaces`:

```ts
/** What a connection says on an answer when that answer showed the SAP session lost. */
export type AdtSessionLoss = typeof ADT_SESSION_ERROR.SESSION_REPLACED;

export interface IAdtWireResponse<T = unknown, D = unknown> /* … as today … */ {
  /**
   * Present on the answer of a stateless request whose answer showed the SAP session replaced: the
   * answer is SAP's, and the connection's session is gone — the instance is spent.
   */
  readonly sessionLost?: AdtSessionLoss | undefined;
}

export interface IAbapConnectionError {
  /* code?, rfc? as today */
  /** The same, on SAP's refusal of such a request. `code` is unchanged by it. */
  readonly sessionLost?: AdtSessionLoss | undefined;
}
```

Published on the registry before the connection; the connection depends on `^4.2.0`, from the
registry, no local link.

## 5. The connection

- **The decision point.** `observeResponse` learns whether the answer it folds in is an attempt of a
  stateless caller's request (`keepAnswer: boolean`, from `!isStatefulRequest(requestConfig)` at the
  call sites of section 3.2; `false` for the session context, i.e. the connection's own exchanges).
  `applyIdentityPolicy` on `replaced` does what it does today — `endSession`, `clearSessionState`,
  `raiseSessionLost` — and then throws `ADT_SESSION_REPLACED` when `keepAnswer` is `false`, or
  returns `'lost'` when it is `true`. The result is typed; no runtime check of what the compiler
  knows.
- **Success.** `sendObserved` sets `sessionLost` on the response it returns when the observation was
  `'lost'`.
- **Refusal.** `recoverOnWire`, the CSRF retry's catch and `answerCredentialFailure` observe the
  refusal with `keepAnswer`; on `'lost'` they set `sessionLost` on that error and throw it at once,
  before `throwIfSessionDead`, the CSRF retry or the credential.
- **The mark is set on the wire's own object**, one per request attempt: the response the wire
  resolved, the error it threw (Inference: the HTTP client makes a fresh object per send;
  unit-tested that a mark never reaches another request).
- **Nothing else changes:** the replacing session's logoff (`endSession`, best effort), the spent
  instance, `NOT_CONNECTED` afterwards, `disconnect()` owed once, the session-dead phrases, the stale
  fencing, RFC.

## 6. Tests

Unit, through the public surface, a stub under the subject (`transport.client`, or the transport's
`send`/`close` for the paths that do not depend on cookies), no cast:

- every row of 3.2, each in its stateless and its stateful form: the stateless one resolves or
  rejects SAP's answer with `sessionLost`, the stateful one rejects `ADT_SESSION_REPLACED`; each
  counts the sends — no resend after the answer that showed the replacement;
- the CSRF retry's resend refusal with a new `SAP_SESSIONID`: marked, and not the first attempt's
  error (red on today's code);
- in the answer's continuation: `isConnected()` false, `sessionCookies()` null; the next request
  `NOT_CONNECTED` with nothing sent; `disconnect()` settles once; the stub's `close` was called for
  the replacing session;
- the connection's own exchanges (CSRF fetch in the retry, `connect()`): `ADT_SESSION_REPLACED`;
- unmarked: an answer with an unchanged or newly established `SAP_SESSIONID`, a stale-lease answer;
- a session-dead `400` (each phrase): `ADT_SESSION_REPLACED` for stateless and stateful alike;
- a stateless answer with both a new `SAP_SESSIONID` and a phrase: the refusal, marked;
- the header form of statefulness (`x-sap-adt-sessiontype: stateful` written by the caller): fails
  like the flag.

Load-bearing: each half is broken on its own — stateless returns throw again; stateful returns the
answer; the CSRF resend's refusal unobserved; the mark set before the loss — and the protecting
tests go red.

Live (onprem over HTTP, the existing env-file gate, skipped with its reason elsewhere): an instance
connects, its session is logged off from outside with the cookies `sessionCookies()` returned
(without `sap-contextid`); a stateless `GET` resolves `200` with `sessionLost`; the next request
rejects `NOT_CONNECTED`; a second instance, the same way, sends a stateful request
(`setSessionType('stateful')`) and rejects `ADT_SESSION_REPLACED`; the replacing session's logoff
is seen leaving through a consumer `httpClient` that records the requests (`/sap/public/bc/icf/logoff`
with the new `SAP_SESSIONID`). No object, no lock.

## 7. Docs

README and `docs/USAGE.md` "When the session is lost": a stateless request whose answer shows the
session replaced keeps SAP's answer, marked `sessionLost`; the instance is spent; a stateful request
still rejects `ADT_SESSION_REPLACED`; what a consumer does next (read `sessionLost`, create a new
instance). `docs/MIGRATION-23.0.md`: a consumer that caught `ADT_SESSION_REPLACED` from a stateless
request now reads `sessionLost` on the answer or the refusal. CHANGELOG entry.

## 8. Release

- `@mcp-abap-adt/interfaces-adt-connection` 4.2.0 (minor), published first.
- `@mcp-abap-adt/connection` **23.0.0**: a stateless request that rejected `ADT_SESSION_REPLACED`
  now resolves or rejects SAP's answer; a consumer that learned of the loss from that rejection
  must read `sessionLost` — a changed result of a published call, so a major (Inference;
  **Open**: the owner confirms the major).
- The next links (`@mcp-abap-adt/adt-clients`, the server) read `sessionLost`: their own changes,
  listed in the PR, not here.

## 9. Noted, outside this change

- A `sap-contextid` the server no longer knows gets the session-dead `400` even on a live session
  (section 2, the "one never issued" row), and 22.0.1 reads that as the session lost. A stateful
  request that carries a context id SAP has dropped while the `SAP_SESSIONID` lives would therefore
  spend a live instance. Whether SAP drops a context while its session lives (after an `UNLOCK`,
  say) is not measured (**Open**, reported for the owner; not decided here).
