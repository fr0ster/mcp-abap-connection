# Spec: the RFC wire carries the passport, names its errors, and never reopens a session

Bound by `2026-11-11-rfc-passport-goal.md`. Release: 22.0.0 (section 9).

Every claim is tagged: **Code** (read in this repository at the commit the branch starts from,
or in the named package at its published or tagged version), **Measured** (run against a real
system), **Inference** (reasoned, not checked). Points left to the owner are marked **Open**.

## 1. What exists today

- `RfcTransport.carry()` builds `HEADER_FIELDS` from every request header, `SAP-PASSPORT`
  included, and calls `conversation.call('SADT_REST_RFC_ENDPOINT', { REQUEST })` with no third
  argument (Code: `src/connection/RfcTransport.ts`, `carry`).
- A rejected call is logged and rethrown as
  `new Error('RFC call to SADT_REST_RFC_ENDPOINT failed: ' + message(e))`, where `message()`
  is `JSON.stringify` for a plain object: key, group and code survive only as text (Code).
- `IRfcConversation.call(fm, params)` takes two arguments (Code).
- `SADT_REST_RFC_ENDPOINT` does not read a `SAP-PASSPORT` header field: a class run carrying
  it over RFC is not caught by a terminal-mode listener; the same passport given to the SDK
  is (Measured, sap-rfc-lite 0.4.0 live suite and earlier probes).
- `@mcp-abap-adt/sap-rfc-lite` 0.4.0: `call(name, params?, { passport?: Buffer })`; the
  passport is refused with a `TypeError` before sending when empty, without `*TH*` at either
  end, or when its declared length (bytes 5–6) is not its own. After an error that ends the
  connection (codes `RFC_COMMUNICATION_FAILURE`, `RFC_ABAP_RUNTIME_FAILURE`,
  `RFC_ABAP_MESSAGE`, `RFC_EXTERNAL_FAILURE`, `RFC_CLOSED`; groups `ABAP_RUNTIME_FAILURE`,
  `LOGON_FAILURE`, `COMMUNICATION_FAILURE`, `EXTERNAL_RUNTIME_FAILURE`) the handle is
  released, `alive` is `false`, the call rejects with the SDK's own error, and every later
  `call`, `resetServerContext()` and `close()` rejects with `nodeRfcError` "RFM client request
  over closed connection" (Code: sap-rfc-lite v0.4.0 README, `src/ts/client.ts`).
- The SDK's errors are plain objects: `RfcLibError { name, group: number, code: number,
  codeString, key, message }`, `AbapError` the same plus the `abapMsg*` fields, `nodeRfcError
  { name, message }` (Code: sap-rfc-lite `src/ts/types.ts`).
- A caught session keeps its debugging state: later calls on the same connection are caught
  without a passport until the context is reset (Measured, sap-rfc-lite 0.4.0 README).
- The stateful conversation is opened by `open()`, never reset, and carries the requests
  marked stateful; the non-stateful ones go on a kept conversation reset after each call, or
  on a throwaway one closed after the call (Code).
- The session-lost path: `throwIfSessionDead(error, lease)` in `recoverOnWire` calls
  `raiseSessionLost()` (the instance is spent, teardown begins) and throws
  `sessionError(ADT_SESSION_ERROR.SESSION_REPLACED, …)`; a spent instance answers
  `ADT_NOT_CONNECTED` to every later request and to `connect()` (Code:
  `AbstractAbapConnection.ts`). A wire marks a refused logon with `WireLogonError`
  (`authErrors.ts`) and the base acts on the class, never on the transport's kind (Code;
  CLAUDE.md).
- `terminateDebugger` on the debugger's stateful session ends the RFC conversation with
  `RFC_CLOSED`: `key` and `codeString` both `RFC_CLOSED`, group `4`, code `6` (Measured earlier
  at debugger termination over RFC; not re-run here). The ADT strategies will read the typed
  `codeString`.
- `RfcTransport` holds two regular expressions: `statusFromExceptionXml` and
  `SECRET_HEADER_PATTERNS` (Code).

## 2. The `rfc` contract — what connection needs from `interfaces-adt-connection` 4.1.0

Additive, types and constants only (Code: that package's goal, its worktree `rfc-error`). The
names below are the ones decided for 4.1.0; the final ones are that package's spec's, and this
spec follows them where they differ:

```ts
/** The 34 `RFC_RC` names of `sapnwrfc.h`, closed. */
export const RFC_RCS = [/* 'RFC_OK', …, 'RFC_CLOSED', … — 34 names */] as const;
export type RfcReturnCode = (typeof RFC_RCS)[number];

/** The SDK's error, as fields. */
export interface IRfcErrorInfo {
  readonly key: string;
  readonly group: number;
  readonly code: number;
  readonly codeString: RfcReturnCode;
}

/** What a connection's thrown error may carry. */
export interface IAbapConnectionError {
  readonly code?: string | undefined;
  readonly rfc?: IRfcErrorInfo | undefined;
}
```

What the connection uses: `RFC_RCS` (a value — the one membership test of section 3),
`RfcReturnCode`, `IRfcErrorInfo` (the type of `rfc`) and `IAbapConnectionError` (what both the
wire's errors and the base's `SESSION_REPLACED` error conform to). Nothing else: no guard, no
code-to-group table.

## 3. The SDK error, checked once

- **Where.** In `RfcTransport.carry()`, in the `catch` of `conversation.call(…)`: the one place
  an SDK error enters (Code). One module-private function, `rfcErrorOf(thrown: unknown):
  IRfcErrorInfo | undefined`.
- **The shape test.** `thrown` is a non-null object; `key` and `codeString` are own data
  properties holding strings; `group` and `code` own data properties holding integers
  (`Number.isInteger`). Read with `Object.getOwnPropertyDescriptor` (no getter runs), inside a
  `try` (a Proxy trap that throws reads as no shape). `name` and `message` are not read.
- **The return code is one of `RFC_RCS`.** `codeString` must be a member of the closed list
  (`RFC_RCS.find((listed) => listed === codeString)`, plain comparison — the found member is
  what is stored, so it is typed `RfcReturnCode` without a cast). One not listed: no `rfc` at
  all — the error goes as today, its text only.
- All four present and the code listed: a fresh frozen `{ key, group, code, codeString }`;
  otherwise `undefined`.
- **What is thrown.** Always an `Error` whose message is today's
  (`RFC call to SADT_REST_RFC_ENDPOINT failed: …`, unchanged) — with an own `rfc` property when
  the shape test passed, without one otherwise. Top-level `code` is not set. The thrown value
  conforms to `IAbapConnectionError`.
- **No shape.** `nodeRfcError` (the closed-connection error), the passport's `TypeError`, the
  passport-too-long error, an SDK error whose `codeString` is not in `RFC_RCS`, and anything
  else carry no `rfc`; thrown as today. Whether such a
  failure ended the session is decided by section 4, not by the shape.
- The `error`-level log line stays as today (Code); no field is parsed out of it.

## 4. A session-ending error on the stateful conversation

- **The verdict is `alive`, not a code list.** After a call on the stateful conversation
  rejects, the wire reads `conversation.alive`. `false` (and the wire's `generation` unchanged,
  so it was not a `close()` of ours) means the conversation is gone: sap-rfc-lite released it
  (Code: 0.4.0 sets `alive` false exactly then). The connection keeps no copy of the SDK's list.
  A concurrent stateful call that then meets the closed-connection error sees `alive` false too
  and is reported the same way (Inference; unit-tested).
- **The wire marks it, the base decides.** The wire drops the dead conversation (`conversation`
  set to `null`, `conversationId` to `''`, without calling `close()` — there is nothing left to
  release and `close()` would reject) and throws `WireSessionLostError` (new, beside
  `WireLogonError` in `authErrors.ts`, exported like it): an `Error` with `rfc?: IRfcErrorInfo`
  (from section 3) and the fixed message of the call's failure. It decides nothing else.
- **The base.** `throwIfSessionDead(error, lease)` also recognises `error instanceof
  WireSessionLostError`: when the lease is current it calls
  `raiseSessionLost('the wire reports the session ended')` and throws
  `sessionError(ADT_SESSION_ERROR.SESSION_REPLACED, <fixed words>)` with the wire error's `rfc`
  copied on as an own property when present; when the lease is stale it rethrows the error
  unchanged (as today for a stale dead-session answer). No `kind` is read. Fixed words: "The
  RFC conversation that carried this connection's SAP session has ended; any lock held in it
  is gone. Create a new connection for a new session."
- **After it.** The instance is spent: every later request and `connect()` answer
  `ADT_NOT_CONNECTED` from the base, before the wire is reached (Code: `sendObserved`,
  `spentError`). `disconnect()` still settles; the wire's `close()` finds no stateful
  conversation and closes the kept stateless one (Code).
- **The `IAdtTransport` contract text** (its doc comment) names the marker: a wire that loses
  the session it carries throws `WireSessionLostError`; the HTTP wires never do.
- `isSessionVerdict()` already rethrows a `SESSION_REPLACED` error unchanged through
  `answerCredentialFailure` (Code); the error must reach the caller with `rfc` intact
  (unit-tested through the public surface).

## 5. The stateless conversations

- **Kept.** A call whose conversation is left `alive === false` gets the section-3 error (with
  `rfc` where shaped), the conversation is dropped (`stateless = null`, language cleared)
  without `resetServerContext()` or `close()`, and the next non-stateful call opens a new one
  as today after a failed reset. The instance's session is not touched; nothing is spent.
- **Throwaway.** As today: closed in the `finally`, except that a dead one (`alive === false`)
  is not closed. Error as section 3.
- **Alive after a failure** (e.g. `RFC_ABAP_EXCEPTION`): unchanged — the kept one is reset in
  the `finally`, the throwaway closed.

## 6. The passport header

- **Found.** In `carry()`, over `request.headers`: every entry whose name, with ASCII `A–Z`
  folded to lower case, is `sap-passport`. None: no passport. More than one entry, in any case
  and whatever their values (equal ones too): always refused before anything is sent ("The
  request names SAP-PASSPORT more than once; nothing was sent.").
- **Decoded with plain code.** The value is a string (the header type, Code); it must be
  non-empty, of even length, and every character one of `0–9`, `a–f`, `A–F` (a character test
  per position, no regex, no `Buffer.from(…, 'hex')` before the test — that call stops silently
  at the first bad pair, Code: Node docs). Then `Buffer.from(value, 'hex')`.
- **Refused.** Any rule broken: an `Error` "The SAP-PASSPORT header is not a passport in hex;
  nothing was sent." — the header named, the value never quoted. Thrown before the generation
  check and before anything is sent. No `rfc`, nothing spent.
- **Removed.** The passport entry is not put into `HEADER_FIELDS`, and is not in the
  `logWire` header line.
- **Passed.** `conversation.call('SADT_REST_RFC_ENDPOINT', params, { passport })` only when a
  passport was found; otherwise the two-argument call exactly as today.
  `IRfcConversation.call` gains the optional third parameter `options?: { passport?: Buffer |
  undefined }` (a conversation written for two arguments still conforms — Code: TypeScript
  parameter bivariance of fewer parameters).
- **Structure** (`*TH*`, declared length) is sap-rfc-lite's check; its `TypeError` is thrown
  through section 3 without `rfc`, nothing sent (Code: 0.4.0 refuses before `invoke`).
- **On every conversation**: a stateful request carries it on the stateful one, a non-stateful
  one on the kept or throwaway one. The connection does not reset a caught stateful session
  (goal; documented, section 8).
- HTTP wires: untouched.

## 7. The two regex rewrites, results kept — with one exception

### 7.1 `statusFromExceptionXml(body)`

Today: `/<exc:type[^>]*>([^<]+)<\/exc:type>/.exec(body)?.[1]?.trim()`, then
`EXCEPTION_STATUS[type]`, else `{ 500, 'Internal Server Error' }`. Linear rewrite: for each
occurrence `i` of `<exc:type` (from the left, `indexOf`), let `j` be the first `>` after
`i + 9`; none: no match at all. The capture runs from `j + 1` to the first `<` after it, `k`;
it matches when `k > j + 1` and `body.startsWith('</exc:type>', k)`; else try the next
occurrence after `i`. First match wins, then `trim()` and the lookup.

Pinned inputs → status (each as a test row, and each also run against the old regex kept in the
test file as the oracle — the rule is "no regex in production code", Code: goal):

| Body | Result |
|---|---|
| `<exc:type>ExceptionResourceNotFound</exc:type>` | 404 |
| `<exc:type id="x">ExceptionResourceLocked</exc:type>` | 423 |
| `<exc:type> ExceptionConflict </exc:type>` (spaces) | 409 |
| `<exc:type></exc:type><exc:type>ExceptionBadRequest</exc:type>` (first empty) | 400 |
| `<exc:type>   </exc:type>` (blank) | 500 |
| `<exc:typeX>ExceptionNotSupported</exc:typeX>` (no `</exc:type>`) | 500 |
| `<exc:typeX>ExceptionNotSupported</exc:type>` | 501 |
| `<exc:type>Exception<b>Bad</exc:type>` (`<` inside) | 500 |
| `<exc:type>Unknown</exc:type>` | 500 |
| `<EXC:TYPE>ExceptionResourceNotFound</EXC:TYPE>` (case) | 500 |
| no `<exc:type` | 500 |
| `<exc:type` without `>` | 500 |

**The one exception to "same results": the lookup is by own keys only.** Today
`EXCEPTION_STATUS[type]` is a plain-object lookup, so a `<exc:type>toString</exc:type>` (or
`constructor`, `hasOwnProperty`, …) yields an `Object.prototype` member whose `code` is
`undefined`, and `carry()` then falls through to `200 OK` for an exception document (Code, by
reading; not run). The rewrite looks a type up only when it is an own key of `EXCEPTION_STATUS`
(`Object.hasOwn`); any other type gives `500 Internal Server Error`, as an unknown type does
today. Its own test rows, where the oracle is not applied: `<exc:type>toString</exc:type>`,
`<exc:type>constructor</exc:type>` and `<exc:type>__proto__</exc:type>` → 500.

### 7.2 `SECRET_HEADER_PATTERNS`

Today: a header name is redacted when any of `/authorization/i`, `/cookie/i`, `/token/i`,
`/secret/i`, `/password/i`, `/credential/i`, `/api[-_]?key/i` matches. Without the `u` flag, `/i`
never matches a non-ASCII character to an ASCII letter (Code: ECMAScript `Canonicalize`). So the
exact rewrite folds only ASCII `A–Z` to lower case (not `toLowerCase()`, which maps the Kelvin
sign U+212A to `k` and would redact more) and tests `includes` of `authorization`, `cookie`,
`token`, `secret`, `password`, `credential`, `apikey`, `api-key`, `api_key`.

Pinned names (redacted / kept), each also against the old patterns as oracle: `Authorization`,
`x-CSRF-Token`, `Cookie`, `Set-Cookie`, `X-Api-Key`, `x-apikey`, `API_KEY`, `My-Secret`,
`Proxy-Credential`, `PASSWORD` → redacted; `Accept`, `Content-Type`, `X-Api--Key`, `api.key`,
`X-Api-Key` (Kelvin sign), `sap-language` → kept.

## 8. Docs

- **README**, "RFC" section: the passport header becomes the RFC call's passport and is not a
  header field; what a failed RFC call carries (`rfc`, the message unchanged); a
  connection-ending error on the stateful conversation is `ADT_SESSION_REPLACED` with `rfc`,
  the instance is spent, a new session is a new instance; the stateless conversations are
  replaced as a reset; **a stateful session once caught by a listener stays caught for later
  calls until it ends — the connection does not reset it**.
- **docs/USAGE.md**: the same, under the RFC wire and "Session Lifecycle".
- **docs/MIGRATION-22.0.md** (new, listed in `docs/INDEX.md`): what a consumer on 21.x must do —
  read `rfc` instead of the message; expect `ADT_SESSION_REPLACED` and a spent instance after a
  connection-ending RFC error, and create a new connection; sap-rfc-lite `^0.4.0`; the sticky
  debugging state.
- **CHANGELOG.md**: the 22.0.0 entry, dated on each edit.
- `npm test` runs `check:docs`, which checks the docs' paths and examples (Code).
- CLAUDE.md ("Taking the RFC wire") is the controller's to change with the owner's approval,
  not this PR's.

## 9. Version and dependencies

- **22.0.0, breaking.** A consumer of 21.x sees different behaviour without changing code: after
  a connection-ending RFC error the instance is spent and answers `ADT_NOT_CONNECTED`, where 21.x
  with sap-rfc-lite 0.3.x went on, silently, on a new session; the `SAP-PASSPORT` header no
  longer reaches the endpoint as a header field; the RFC library's minor (0.3 → 0.4) is itself
  breaking (Code: sap-rfc-lite CHANGELOG 0.4.0). The new types are additive.
- `@mcp-abap-adt/sap-rfc-lite`: `^0.4.0`, stays an **optional** dependency as today (Code:
  `package.json` `optionalDependencies`).
- `@mcp-abap-adt/interfaces-adt-connection`: `^4.1.0` (from `^4.0.0`), regular dependency.
- Both resolve on the registry before the release; the lockfile is regenerated by npm and holds
  no link and nothing not from the registry. 0.4.0 is not on the registry yet (Measured: `npm
  view` lists up to 0.3.2), so the code is built only once both are published.

## 10. Unit tests and their mutations

On `node:test`, through `RfcTransport`'s public surface with a stand-in conversation, or through
`AdtOnPremConnector` + `RfcTransport` for the base. Each test's protecting mutation is applied
once, the test seen red, then reverted.

| Invariant | Test | Mutation that must turn it red |
|---|---|---|
| fields | an `RfcLibError`-shaped rejection reaches the caller with `rfc` equal to its four fields; an `AbapError`-shaped one too | drop `rfc`; read `key` from the message |
| fields, shape | each field missing, of the wrong type, a getter, a throwing Proxy: no `rfc`, no throw from the check | drop each conjunct of the shape test, one at a time |
| fields, closed code | a `codeString` not in `RFC_RCS` (`RFC_NOT_A_CODE`, `''`, `rfc_closed`): no `rfc`, the message as today | drop the membership test |
| fields, top-level `code` | an `rfc` error has no own `code` | set `code` from `rfc.code` |
| passport found | `sap-passport`, `SAP-PASSPORT`, `Sap-Passport` each reach `call` as the decoded `Buffer` in the third argument | compare names case-sensitively |
| passport removed | no `HEADER_FIELDS` entry and no `logWire` line names it | keep it in `HEADER_FIELDS` |
| no header, no passport | `call` receives exactly two arguments | always pass `{ passport: undefined }` |
| passport refused | odd length, empty, a non-hex character at the first, a middle and the last position: rejected, `call` not invoked, the message names the header and holds no character of the value | drop each rule; quote the value |
| passport twice | `SAP-PASSPORT` and `sap-passport`, with different and with equal values: rejected, `call` not invoked | refuse only differing values; take the first |
| passport per call | a second request without the header after one with it carries none | keep the last passport on the wire |
| session lost | stateful call rejects and leaves `alive` false → caller gets `ADT_SESSION_REPLACED` with `rfc`; the next request `ADT_NOT_CONNECTED`, no `call`, no new `open` | ignore `alive`; reopen in `send`; drop `rfc` in the base |
| session lost, concurrent | a second stateful call meeting the closed-connection error is reported the same way, no `rfc` | decide on the code instead of `alive` |
| not lost | a stateful call that rejects with `alive` still true: error with `rfc`, instance not spent | spend on any error |
| close of ours | `close()` during a call: no session-lost verdict | drop the generation check |
| stateless kept | a dead kept conversation: error with `rfc`, not spent, no `resetServerContext`/`close` on it, the next call opens a new one | reset or close the dead one; spend the instance |
| stateless throwaway | a dead throwaway is not closed; error with `rfc` | close it |
| base, no kind | a stub wire (not RFC) throwing `WireSessionLostError` spends the instance the same way | branch on `kind` |
| stale lease | a `WireSessionLostError` from a previous session is rethrown, nothing spent | drop the lease check |
| regex 7.1 | the table, and equality with the oracle | each step of the scan (wrong start, `>` search, empty capture, the closing tag) |
| own-key lookup | `toString`, `constructor`, `__proto__` → 500 | look up without `Object.hasOwn` |
| regex 7.2 | the names, and equality with the oracle | `toLowerCase()`; drop each substring |
| no regex | a source test: no regex literal or `RegExp` in `src/connection/RfcTransport.ts` | add one back |
| no timer | the existing timer counter covers the new code (Code: `packageTimers`) | — |

## 11. Live tests

- **Where.** A new block in the RFC live suite (`src/__tests__/rfc-connection.test.ts`, its env
  file and its skip rules: env lacking keys, sap-rfc-lite or the SDK missing — the reason in the
  block's title, Code). Only on-premise over RFC; never in CI.
- **The class.** The shared debugger probe `ZAC_SHR_DBG_PROBE` (runnable, created by the ADT
  clients' shared setup, never deleted by a test; Code: adt-clients `test-config.yaml.template`).
  Its source is read (`GET …/source/main`); the breakpoint line is the one holding `"BP:loop`,
  found by plain search. Absent (`404`): the test skips, naming the class and the setup that
  creates it. Nothing is created, changed or deleted.
- **The passport.** Built by a test helper from random terminal and IDE ids, the layout the ADT
  client uses (Code: adt-clients `runtime/debugger/passport.ts`), upper-case hex; never logged.
- **Instances.** One connection per role, each from `createConnection` (on-prem, RFC,
  `BasicAuthProvider`): the listener's, the checker's, the runner's, the debugger's (stateful).
  The debugger's `RfcTransport` is built over a factory that wraps `rfcConversationFrom` and
  counts the conversations it opens.
- **Caught, then terminated.**
  1. Arm the external line breakpoint (`POST /sap/bc/adt/debugger/breakpoints`, terminal mode).
  2. Listen (`POST /sap/bc/adt/debugger/listeners?…&timeout=<hold>`), not awaited.
  3. **Readiness re-check**: `GET …/listeners?…&checkConflict=true` under another IDE id,
     repeated with no pause until it answers `409`; fails if the listener's poll settles first.
     Commented as the owner-approved test-only exception to "no polling", with the reason, as
     in sap-rfc-lite's live suite (ADT offers no readiness event; a run sent before the listener
     stands is not caught — Measured there).
  4. Run (`POST /sap/bc/adt/oo/classrun/ZAC_SHR_DBG_PROBE`) with the `SAP-PASSPORT` header,
     not awaited. The listener answers a `DEBUGGEE_ID`.
  5. On the debugger's connection, stateful: attach, then `terminateDebugger`. Expect the
     rejection to carry `code` `ADT_SESSION_REPLACED` and `rfc` with `key` `RFC_CLOSED` **and**
     `codeString` `RFC_CLOSED` (both asserted; group `4`, code `6` — Measured earlier at
     debugger termination over RFC), then the next request on it
     `ADT_NOT_CONNECTED`, and the factory's count unchanged after the error.
  6. The run answers `200` with its output (the debugger freed it).
- **Not caught.** The same without the header: the listener's shorter hold ends empty and the
  run answers its output.
- **Cleanup** in `finally`: delete the listener, clear the breakpoints, `disconnect()` every
  instance. No value of the env file, no id, no passport, no lock handle is printed.

## 12. Out of scope

As the goal states; and the `abapMsg*` fields of an `AbapError` (not carried in `rfc`).
