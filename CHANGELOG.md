# Changelog

All notable changes to the `@mcp-abap-adt/connection` package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [6.1.0] - 2026-09-03

### Licence

- **This package is now `LGPL-3.0-only`.** It was MIT up to and including 6.0.1, and
  those versions stay MIT — a licence change is not retroactive, and anyone
  already using 6.0.1 under MIT keeps that grant for 6.0.1.

  The library licence of the GNU family, chosen for what it does *not* ask:
  linking it into your own program — importing it, as every consumer of an npm
  package does — does not put your program under the LGPL. What it asks is that
  changes to this library stay free and that your users can substitute their own
  build of it.

  Both texts ship in the package: `LICENSE` is the LGPL, `COPYING` is the GPL it
  is written on top of. The LGPL is a set of additional permissions over the GPL,
  so it cannot be read without both.

  Copyright © 2025–2026 Oleksii Kyslytsia.


## [6.0.1] - 2026-08-25

### Removed

- **`express` is no longer a dependency.** It was a runtime dependency for one
  thing: the localhost server in `bin/sap-abap-auth.js` that catches the OAuth2
  redirect. The library never touched it, and that file already imported
  `node:http`. Rewritten on `node:http`, which sheds 5.6MB of `node_modules` and
  the transitive tree the Dependabot bumps kept arriving for — `qs`,
  `body-parser` and `follow-redirects` were all express's.

  Two things express was doing implicitly are now stated: a request is the
  redirect only when it is a `GET` for `/callback`, so a browser fetching
  `/favicon.ico` no longer reaches the handler waiting for an authorization
  code; and the success page declares `text/html`, which `res.send()` used to
  infer. Exercised as a server: `200` with the page, `400` without a code, `404`
  for anything else including a `POST`.

  Runtime dependencies are now `@mcp-abap-adt/interfaces`, `axios`, `commander`
  and `open`. The end-to-end flow was measured against the BTP trial — see
  *Verified* below.

### Changed

- **The browser wait is the caller's to set.** `bin/sap-abap-auth.js` waited a
  fixed five minutes for the redirect, and a real BTP login does not fit in it —
  the identity provider, a password manager and whatever second factor the
  tenant asks for all happen before the redirect is issued. Measured twice, and
  both times the window closed first; the browser then had nowhere to redirect
  to, which reads as the authentication having failed rather than as a timeout.

  `--timeout <minutes>`, or `SAP_AUTH_TIMEOUT_MS` for a script that would rather
  not pass an argument, with the flag winning when both are given. Anything that
  is not a positive number is refused by name rather than silently becoming a
  default. **The default is now fifteen minutes**, which covered the login this
  was measured against with room to spare and still bounds an abandoned run.

### Verified

- **The whole chain, end to end**: `bin/sap-abap-auth.js auth` → browser
  authorization against the tenant's UAA → redirect to `localhost:3001/callback`
  → code exchanged for a token → `.env` written with `SAP_JWT_TOKEN`,
  `SAP_REFRESH_TOKEN` and the UAA fields.

- Each seam the express removal touched, measured on the real handler rather
  than a stand-in: `GET /favicon.ico` answers `404` and does not reach the
  handler waiting for a code — routing express used to do; `GET /callback` with
  no code answers `400`; the success page comes back
  `200 text/html; charset=utf-8`, the Content-Type `res.send()` used to infer
  and `node:http` will not.

- **The issued token then drove this library** against the trial:
  `AdtCloudConnector` with `CloudHttpTransport` connected, took a session
  (`SAP_SESSIONID_TRL_100`), answered a `GET /sap/bc/adt/discovery` with `200`
  and 444826 bytes of XML, and `disconnect()` left `isConnected()` false.

### Fixed

- **The live RFC suite skips a wire the machine did not install.** It asked for
  four environment variables and nothing else, so a checkout with an env file
  and no SAP NW RFC SDK ran the suite anyway and went eleven tests red, all on
  `@mcp-abap-adt/sap-rfc-lite is not available`. The dependency is `optional` —
  `npm ci` leaves it out WITHOUT failing, which is what optional means — so
  nothing warns and the next run is red for a reason unrelated to the change
  under test.

  Nothing here is configured at build time the way a C package is: the installed
  optional dependency IS the choice of wire, made at install and readable only
  at runtime. `canRun()` now reads it with `require.resolve`, asking whether the
  wire could be taken rather than loading a native addon to find out. Measured
  in both states: SDK hidden — 11 skipped, 2 passed, green; SDK present — 13
  passed.

- `RfcTransport` says why it ignores `request.timeout`. No behaviour change: the
  file contained no occurrence of the word, and that silence read as an
  oversight. It is deliberate — the SDK exposes no cancel, its per-call
  `timeout` is parsed into a commented-out branch, and an abandoned call still
  holds the conversation, so the next one would queue behind a call nobody is
  waiting for. A deadline that reports failure while the wire stays busy is
  worse than none, because the error reads as "safe to retry" when it is not.
  The server bounds the call at `rdisp/max_wprun_time`.

## [6.0.0] - 2026-08-24

The wire owns what is the wire's, and the factory and per-credential classes are
gone. See [Migration to 6.0](./docs/MIGRATION-6.0.md).

### Added — tooling

- **CI.** Until this release the only workflow ran on a tag, and `Release` went
  from build straight to `npm pack` — so nothing ran the gate before a merge,
  and the artifact a tag published had been tested nowhere but on a laptop.
  `ci.yml` runs `lint:check`, `build`, `jest --no-cache`, `check:docs` and
  `check:pack` on push and pull request, across ubuntu and windows on Node 18
  and 20. Windows is in the matrix because npm is `npm.cmd` there and Node will
  not execute a `.cmd` without a shell. `release.yml` runs the same three checks
  between build and pack, so a tag is not a route around them.

- **`check:pack`** — inspects `npm pack --dry-run --json` and refuses a tarball
  carrying a test file, a `.tsbuildinfo`, a `.ts` source, an env file or an
  npmrc. Both defects it was written for had already shipped once:
  `dist/__tests__/` and 120KB of compiler bookkeeping, neither visible from
  `files`, because it is the compiler that decides what `dist` holds.

- **`typecheck:scripts`** — `scripts/*.ts` were checked by nothing, which is how
  three live verification scripts came to sit on a constructor signature two
  releases old.

### Changed — packaging

- 111 files / 182KB → 95 / 147KB. Test helpers and the compiler's incremental
  state no longer ship.

### Added

- **The transport axis is complete and public.** `IAdtTransport` now covers
  everything true of a wire — carrying a request, addressing it, establishing
  itself, and whatever session state it keeps — and both ends are objects:
  `HttpTransport` and `RfcTransport`. `IAdtEstablishContext`, `IRfcConversation`
  and `RfcConnectionParams` are exported, so a caller handed a seam can name it.

- **`rfcConversationFrom(config)`** — the front door to the RFC wire. Derives
  `ashost` from the url and `sysnr` from the HTTP port (`80XX` → `XX`, with
  `SAP_SYSNR` overriding), and loads the SAP NW RFC SDK only when a conversation
  opens, so a machine without it fails at `connect()` rather than at
  construction.

- **`RfcTransport` supplies a default `Accept`.** axios adds one over HTTP and
  nobody had noticed; ADT refuses a request without it with
  `400 ExceptionResourceBadRequest: Accept header missing`.

### Changed

- **The on-prem connector works over RFC.** It did not, at all. Measured against
  a real system, three blockers stood one behind the other, all of them HTTP
  assumptions in the class every connector shares: the CSRF fetch handed
  `SADT_REST_RFC_ENDPOINT` an absolute URL and dumped it with
  `STRING_OFFSET_TOO_LARGE`; that endpoint returns no `x-csrf-token` however it
  is asked, so the exchange could not succeed; and the session fingerprint was a
  scan for a `SAP_SESSIONID` cookie, so a wire that issues none read as a
  connection the server had opened no session for.

  The base class did not merely check for cookies — it DEFINED a session as one.

- **`AbstractAbapConnection` keeps the lifecycle and nothing else** (1989 → ~1620
  lines): the transition queue, teardown epochs, session generations, critical
  sections, stale-request fencing, 401 classification, the identity policy, and
  the promise that `disconnect()` settles. Cookies, the cookie jar, the CSRF
  exchange, affinity headers, axios and addressing all moved to the wire that
  has them. There is no `if (transport is rfc)` anywhere.

- **A credential refused surfaces** rather than being renewed behind the caller —
  on `connect()` and on the request path alike. Renewal is the provider's, and it
  happens on an expiry the provider can see, on every call that asks for a header.
  See *Removed*, below: nothing here answers a 401 any more.

### Changed — BREAKING

- **The base classes ask nothing.** `AbstractAbapConnection` and
  `CredentialAbapConnection` contain no config-driven conditional, no optional-member
  call, and no dispatch on a type or a shape. What a collaborator can do is stated by
  its type, not discovered at runtime:

  - `IAdtTransport.open()` / `close()` are required — a wire with nothing to open
    writes an empty method, which is true of it;
  - `IAuthProvider.prepare()`, `cookies()` and `transportMaterial()` are required for
    the same reason (needs `@mcp-abap-adt/interfaces` 20.0.0);
  - `establish()` is the transport's, and the connection delegates to it without
    asking anything first. The credential contributes a header, cookies and TLS
    material; earning a CSRF token is the wire's work, because the wire is what
    holds the session the token is bound to (needs `@mcp-abap-adt/interfaces`
    21.0.0, where the two credential atoms leave the contract — nothing
    implemented them);
  - `skipSessionType` is gone: it described BASIS 7.40, and a deployment is a wire, so
    it is `LegacyOnPremHttpTransport`;
  - whether a session exists is `IAdtTransport.sessionEstablished()` — a verdict each
    wire gives about itself, instead of the connection reading a fingerprint and a flag
    and deciding for all of them at once.

  A credential you wrote gains three usually-empty members; see
  [the migration guide](./docs/MIGRATION-6.0.md#writing-your-own-credential).

### Removed

- **The connection no longer answers a `401` for you.** It called `renew()` on the
  credential, compared the header against the previous one, and rebuilt the session
  if it had changed — a credential lifetime managed from inside the connection.
  Renewal on an expiry the provider can SEE still happens, inside
  `authorizationHeader()`, which is asked per request; the other case — a token the
  provider still believes in and the server refuses — is a judgement made with what
  the caller knows, so the refusal surfaces. A refused credential is not a lost
  session, so the connection stays usable. `TokenAuthProvider` declares
  `IRenewableCredential` (interfaces 19.0.0), which is what a consumer narrows to
  before calling `renew()` itself.

- **`disconnect({ deadlineMs })`** takes no arguments, and `SAP_RELEASE_DEADLINE_MS`
  is gone with it. The parameter bounded a wait for the goodbye to be *answered*,
  and the method does not act on that answer: it tells the server the session is
  finished, and whether and when the session is freed is the server's affair. The
  default was already `0`. Waiting bought a caller nothing while being the one
  thing that could make a teardown unbounded — the goodbye carries no request
  timeout by design, so a server that never answered would have held the teardown
  for the whole deadline. Needs `@mcp-abap-adt/interfaces` 18.0.0, where the
  parameter leaves the contract. Verified against a live BTP trial before the
  contract moved: `disconnect()` returned in 1 ms and the goodbye still went out.

- **`SessionStrategy`** and its two implementations. A session mechanism only some
  wires have, described from inside the class every wire shares and driven by the
  connection — a second wire abstraction beside `IAdtTransport`. It is the
  transport's `open()`/`close()` now, which is also what made `connect()` possible
  over RFC at all.

- **`createAbapConnection()`** and the connection classes it built:
  `BaseAbapConnection` (`OnPremAbapConnection`), `JwtAbapConnection`
  (`CloudAbapConnection`), `SamlAbapConnection`, `CertificateAbapConnection`,
  `KerberosAbapConnection`, `RfcAbapConnection` — 1597 lines. Take a connector,
  hand it a credential, and hand it a transport — which has no default, because
  which wire you are on is not something to guess.

- `adaptTransport()`, which dressed a transport in an axios shape so six call
  sites did not have to be rewritten. They were rewritten.

- `connectionType: 'rfc'` as a way to reach the RFC wire. The wire is an
  argument now.

  **Kerberos has no direct replacement.** It was single-leg only and untested
  against a live KDC (#35); a `KerberosAuthProvider` belongs on the credential
  axis and should be added with a system to test it against.

### Fixed

- Credential cookies are merged into the establishing request rather than
  overwritten by the wire's own — a SAML session IS that cookie, and replacing
  it sent the exchange out unauthenticated.
- The CSRF fallback endpoint is tried only when the primary answers 404. A host
  that is not answering will not answer a different path, and asking doubled the
  wait before the real error surfaced.
- A CSRF token arriving on a refused response (405, or any refusal carrying the
  header) is kept instead of thrown away by the retry.

## [5.0.0] - 2026-08-21

A connection now says which system it is, closes what it opens, and is handed its
credential instead of being one. See [Migration to 5.0](./docs/MIGRATION-5.0.md).

### Added

- **`AdtOnPremConnector` and `AdtCloudConnector`.** The class you take states which SYSTEM you
  are dialling; the auth provider states how you authenticate there. The two are independent, and
  both were reachable combinations that the old shape got wrong: a communication user against
  ABAP Cloud, and a bearer token against an on-prem system.

  Nothing is detected. `/sap/bc/adt/core/http/sessions` answers on **on-prem too**, publishing
  both the session resource and the ICF logoff in one document, and its `DELETE` there leaves the
  session listed while the logoff removes it — a probe would have chosen the mechanism that
  releases nothing.

- **Auth providers** — `BasicAuthProvider`, `TokenAuthProvider`, `SamlAuthProvider`,
  `CertificateAuthProvider` — and `IAuthProvider`, the contract they satisfy. A token provider
  renews on its own, so nothing is cached here: the header is asked for per request, and on a
  `401` the provider is told its answer was refused (`refreshToken()`) before being asked again.

- **`createAbapConnection(..., { system })`** builds the connector you name, with a provider from
  the config. Without it, the old choice by `authType`, warned about once per call.

- **`disconnect({ deadlineMs })`** — the parameter `ISessionLifecycleAware` published and nothing
  implemented. It bounds the **wait**, never the request: handed to axios it would abort the
  socket and cancel the release it was waiting for.

### Changed — BREAKING

- **`connect()` fails when the server opened no session**, where it used to warn and hand the
  connection back. A lock is held by the ABAP session, so a connection without one can read but
  can hold nothing, and the failure surfaced a request later as `400 Session not found` with the
  object half-edited. Verified rather than inferred: a connection that received no
  `SAP_SESSIONID` is listed in the server's session list as nothing at all.

- **`disconnect()` makes a network call**, telling the server the session is finished. It does
  not wait by default — `SAP_RELEASE_DEADLINE_MS` is `0` — because waiting is for steps whose
  successor needs the server to have caught up, and a teardown has none. Requests still in flight
  are running on the session being released and will start failing; that is the caller having
  asked to disconnect.

- **The five auth connection classes are deprecated** and keep working.

### Removed — BREAKING

- **`reset()`**, from `AbstractAbapConnection` and `RfcAbapConnection`. There is no local-only
  discard because there is no local-only session: it lives on the server, and dropping the cookie
  leaves it there. `await disconnect()`, then `connect()` again.

### Fixed

- **Requests stay on the server the session lives on.** A session belongs to one application
  server, so on a multi-node system a request landing elsewhere gets a different session and any
  lock held on the first dies — no inactivity, nobody at fault. `sap-adt-saplb` is asked for and
  sent back, as Eclipse does.

- **A late `401` no longer tears down a healthy session.** The comparison is bound to the session
  the request went out on, so a refusal answered by a session that has since been replaced is
  retried rather than acted on.

- **A credential that is cookies reaches the wire.** A SAML provider's cookies are part of the
  contract and merged with the session jar rather than written over by it — one says who we are,
  the other which session we are in.

- **A session opened before a failed `connect()` is not abandoned**, and the logoff does not cut
  a lock chain held open with `beginCriticalSection()`.

### Measured

- 25 connects in a row on-prem: **24-25** given a session with the logoff, **2** without.
- The server's session list shows the row appear at the second of the call, and go on
  `disconnect()`; without one it would sit for 30 more minutes.
- The timeout is **idle-based**: 45 small requests a minute apart held one session straight
  through a 30-minute window, identity unchanged. There is no keepalive timer here on purpose.
- Cloud: `AdtCloudConnector` with a token provider — session opened through ADT, three stateful
  requests holding it, closed by `DELETE` on the address the server published.

### Fixed

- **Every session of a reconnect cycle is released, not only the first.** A release already on
  its way was treated as "the release still owed" whoever it belonged to, so an in-flight logoff
  for a previous session suppressed the current one's entirely: `connect → disconnect → connect →
  disconnect` sent **one** logoff and left the second session open. Not an edge case — the
  default deadline is `0`, so `disconnect()` does not wait for the logoff and a release is
  routinely still in flight when the next `connect()` happens, which made this the normal path on
  any server that does not answer instantly. Releases are now keyed by the session they belong
  to, and both completion handlers clear by that key, so a late answer about one session cannot
  discard what is owed for another. Sessions still owed are kept as a set rather than one slot,
  because more than one can be outstanding and the older was being overwritten.

### Removed — BREAKING

- **`reset()` is gone**, from `AbstractAbapConnection` and `RfcAbapConnection`. There is no
  local-only discard, because there is no local-only session: the session lives on the server,
  and dropping the cookie leaves it there. The lifecycle is `connect()` / `disconnect()`,
  repeatable, and both say what they do to the server.

  It carried nothing `disconnect()` lacks — it cleared the fingerprint at the start of teardown
  rather than at its end, did not join the transition tail, and returned `void`. That last one
  is the point: a teardown that reports nothing cannot tell the caller whether the session was
  released, which is the whole subject of this release.

  No callers outside tests, and it is in neither `IAbapConnection` nor `ISessionLifecycleAware`,
  so consumers programming against the published contracts are unaffected. `RfcAbapConnection`
  keeps `close()`, which is its own teardown and always was.

  **Migration:** `conn.reset()` → `await conn.disconnect()`, and `connect()` again to carry on —
  the connection is reusable. A caller that does not want to wait simply does not `await` it,
  which is what `reset()` was really used for.

### Fixed

- **`disconnect()` tells the server the session is done, not only the client.** Dropping the cookie
  left the ABAP session alive until its own timeout — default `http/security_session_timeout`,
  1800 s — so a process that connects repeatedly left one behind every time. Measured on S/4HANA
  on-prem: 25 connects in a row with the logoff, 24–25 of them were given a session; without it,
  2. The server-side view is unambiguous — SM04 showed 25 HTTP sessions for the same user, one per
  `connect()`, each holding ~12.8 MB, all of them opened by `P=/sap/bc/adt/discovery`, which is the
  establishing call.

  The logoff says the session is no longer needed; **when the server reclaims it is the
  server's business** — possibly not until the next `connect()` asks for one — and nothing
  here waits on that or depends on it. So `disconnect()` **does not wait by default**:
  waiting is for steps whose successor needs the server to have caught up, and a teardown
  has no successor. A caller that wants a bounded wait passes it —
  `disconnect({ deadlineMs })`, the parameter `ISessionLifecycleAware` has published all
  along and which nothing implemented; the default comes from `SAP_RELEASE_DEADLINE_MS`,
  which is `0`.

  **The deadline bounds the wait, never the request.** When it expires the waiting stops and
  the logoff carries on to the server — the contract's word is *detach*. Handed to axios as a
  request timeout instead, it would abort the socket and cancel the very release it was waiting
  for: `deadlineMs: 200` against a server answering in 500 ms left the session open, and the
  default of `0` was more reliable than any small positive value.

  **Each caller waits its own deadline.** Concurrent disconnects join one transition and share
  its promise, so a wait placed inside it was the first caller's wait imposed on everyone — a
  caller passing `0` sat through another's 30-second budget, the one guarantee the parameter
  exists to make. The transition now carries only what must happen once: dispatching the logoff
  and clearing the local state.

  **A repeat call finishes what is still owed**, as `ISessionLifecycleAware` promises. It could
  not: `clearSessionState()` drops the cookies, so a second call found nothing to send and the
  session lived out its 1800 s. The cookies of an incomplete release are kept aside for exactly
  that retry and dropped as soon as one succeeds; a release already on its way is joined rather
  than duplicated.

  **The logoff does not cut a lock chain in flight.** It ends the session that chain is running
  on, so a consumer's `finally` firing on shutdown mid-unlock would leave the object locked and
  inactive — the damage this release exists to prevent, caused by the release itself.
  `beginCriticalSection()` is honoured here as it already is for timeouts: the local teardown
  still happens, the session is recorded as still owed, and calling `disconnect()` again once
  the chain has finished releases it.

- **A malformed `SAP_RELEASE_DEADLINE_MS` is refused at construction, not at teardown.** It
  reached `parseInt`, came out `NaN`, and threw from **every** `disconnect()` in the process —
  blaming a `deadlineMs` argument nobody had passed. It is a startup fault: the same on every
  call, not the caller's argument, and worth refusing a connection over. `Number()` rather than
  `parseInt()`, which read `"5s"` as `5` and travelled on as a silently wrong bound.

  And `disconnect()` no longer throws at all, which is what it and the interface both promise.
  Its place is a `finally` — a connection that was connected must be disconnected — and an
  exception raised there replaces the error that sent the caller into it. A nonsense per-call
  `deadlineMs` is reported and the default used instead.

  It surfaces as anything but a session problem: once the server stops issuing sessions it still
  authenticates every request, so stateless reads and writes keep working and only the
  lock-bound write fails — `200` for the LOCK, a handle, then `400 Session not found` on the next
  request and a half-edited object.

  ICF rather than ADT because ADT publishes no session-close: its discovery document lists none on
  any reachable system — on-prem, cloud, or legacy — and the ADT logon is the discovery call
  itself. Best effort and never throwing: `disconnect()` must always settle, and a session we
  could not close beats a teardown that hangs.

  How many sessions a system tolerates is the server's business and is not guessed at here. Using
  few connections, and reusing them, stays the consumer's decision.

- **A connection the server gave no session now warns.** `sessionFingerprint()` tracks
  `SAP_SESSIONID*` only, so a server that issued none leaves it empty — and an empty fingerprint
  can never be classified `replaced`: `observe()` returns `established` or `unchanged` forever,
  `applyIdentityPolicy()` never fires, `getSessionIdentity()` names nothing. Refusing to connect
  would be the honest answer and is deliberately not done yet: whether cloud ABAP issues this
  cookie is unverified, and a rule that wrong would break every cloud consumer to fix an on-prem
  fault.

### Documentation

- **The guides stop recommending `reset()`**, which this release removes. `USAGE.md` had a
  runnable `connection.reset()` under *Connection Reset*, `STATEFUL_SESSION_GUIDE.md` offered it
  as the remedy for CSRF errors, and `MIGRATION-2.0.md` described its teardown — anyone following
  them got `connection.reset is not a function`. They now say what replaces it and why: starting
  over means telling the server, and dropping a cookie does not.
- A doc block left dangling by the same removal had `close()` in `RfcAbapConnection` documented as
  "Reset the connection … Provides interface compatibility with HTTP connections" — an API that no
  longer exists.

### Tests

- The stub in `sessionComposition.test.ts` answered every route instantly, `/sap/bc/adt/slow`
  included, so *does not wait for an in-flight request* held whenever `disconnect()` performed no
  I/O rather than because the teardown declined to wait. That route now takes 300 ms and the test
  asserts what its name says.
- `sessionTeardown.test.ts` covers the teardown contract from the caller's side: the logoff goes
  out with the session cookies and without a request timeout at any budget; it is detached rather
  than aborted when a deadline expires; a failing logoff still disconnects; a repeat call re-sends
  what is owed and sends nothing once it succeeded; two concurrent disconnects share one logoff
  and keep separate deadlines; a critical section defers it; and a malformed
  `SAP_RELEASE_DEADLINE_MS` refuses construction.

### Fixed

- **`disconnect()` releases the session this connection holds, and nothing else.** What grew
  around that sentence — a map of owed sessions, a map of releases in flight, an attempt counter,
  a give-up rule, a retry across reconnects, and the waiting rules to go with them — is gone. Four
  review rounds found a defect in each round's own fix, every one of them in that machinery, and
  none of it was needed: **a connection holds one session**. `connect()` opens it, `disconnect()`
  closes it, a repeat `connect()` is a NEW session with a new `SAP_SESSIONID`, and an earlier
  session is not this connection's business — its logoff is already on the wire, or the system
  times it out.

  Nothing retries, counts, limits or keeps a list. How many connections to run, how frugally, and
  what to do when a release did not land are the caller's, and were never knowable from inside a
  single connection.

  The session a release belongs to is now its `SAP_SESSIONID`, not the cookie header it is sent
  with. The header also carries `sap-XSRF_*`, which rotates within one and the same session, so
  comparing headers made a session stop recognising itself after a token refresh.

- **A logoff that cannot even be assembled no longer escapes the teardown.** Building it can throw
  on its own — a certificate connection whose material is not loaded throws while building the
  agent — and `disconnect()` is documented never to throw and is called from a `finally`, where a
  throw replaces the error that sent the caller there.

### Documentation

- **The cookies are the session, and a logoff ends it for everyone holding them.** A second
  connection given the same cookie jar works in the same ABAP session and can use the locks taken
  in it; `disconnect()` closes that session for all of them, and no connection can see the copies.
  Written down in `STATEFUL_SESSION_GUIDE.md` and on `disconnect()` itself.

### Changed — BREAKING

- **`connect()` fails when the server opened no session**, instead of warning and handing back a
  connection whose first lock would be dead on arrival. Locks are held by the ABAP session, so a
  connection without one can read but can hold nothing; the failure used to surface a request
  later, as `400 Session not found` with the object half-edited.

  Verified rather than inferred: a connection that received no `SAP_SESSIONID` was held open
  against an on-prem system and the session list showed **nothing** for it, while one that
  received the cookie appeared there. No cookie, no session.

  Reported, not decided on. The message says what the server did, what still works, what does
  not, the usual cause — sessions are limited per user and shared with every other tool logged on
  as them — and that nothing is retried here, because whether to wait, retry, or release sessions
  the user still holds depends on what only the caller knows.

  Every transport, not only basic: splitting by authentication type would encode a guess about
  cloud ABAP, whose ADT endpoint would not answer the bearer obtainable here. If a cloud system
  turns out to hold sessions without issuing this cookie, this is the rule to revisit.

### Documentation

- **`STATEFUL_SESSION_GUIDE.md` gains "A Lock Lives In The Session".** That a lock dies with the
  session that took it; that the timeout is an idle one, spent by silence rather than by elapsed
  time — one small request a minute kept a session alive for 45 minutes past a 30-minute window,
  identity unchanged; and that any request in the session resets it, which is why this package
  holds no keepalive timer. Holding a session alive holds a scarce shared slot, and that is the
  caller's decision to make.

## [4.0.0] - 2026-08-16

A JWT connection stops answering with an error of its own making. See
[docs/MIGRATION-4.0.md](docs/MIGRATION-4.0.md).

### Breaking

- **A 403 no longer triggers a token refresh.** It means the server authenticated the caller and
  refused the action anyway, so a new token is the same caller and cannot change the answer.
- **`Error('JWT token has expired. Please re-authenticate.')` is gone.** Both a 401 and a 403 were
  reported with it, and the original `AxiosError` was discarded along with the status and the
  body. The server's error now reaches the caller unchanged. Code matching on that message must
  branch on `error.response.status` instead — which it can now do.

### Fixed

- The substring guard meant to let permission failures past matched three literal strings and SAP
  sends none of them: the type is `ExceptionResourceNoAuthorization`, not `...NoAccess`, and the
  message reads "not authorized", not "No authorization". The list is deleted rather than
  extended — it enumerated prose, so the next unlisted wording would have been the same defect
  ([#30](https://github.com/fr0ster/mcp-abap-connection/issues/30)).
- A 401 that survives a renewal is now logged at ERROR. The previous log fired only when the
  renewal never happened, so the case the deleted message was actually about passed silently.
- `establishSession` no longer refreshes or recurses into itself. `fetchCsrfToken` owns recovery
  during establishment; a second refresh at the outer level asked the same refresher the same
  question, and the recursion was unbounded whenever the refresher kept resolving.
- `JwtAbapConnection.fetchCsrfToken` declared three parameters where the base declares four and
  called `super` with three, silently dropping the `generation` that fences response effects.
  TypeScript accepts that — fewer parameters are assignable to more. Latent rather than live:
  both call sites that pass one are gated on basic auth.

### Changed

- **One credential renewal per caller-visible operation, session included.** Concurrent requests
  meeting the same expired token now share a single token fetch *and* a single session
  re-establishment. Previously each ran its own teardown and recovery — and since `recover` and
  `cleanup` never join, one request's cleanup could tear down the session another had just
  rebuilt, leaving its retry at a closed door.
- The renewal decision is made against the credential state the operation started with, carried
  in a per-connection `AsyncLocalStorage`. A nested token-only refresh no longer passes for a
  session recovery.
- A retry is abandoned with `ADT_NOT_CONNECTED` if the connection was torn down between the last
  lifecycle check and the retry itself.
- `establishSession` takes its CSRF retry defaults from `CSRF_CONFIG` at all four authentication
  types instead of repeating `3, 1000` in each.

### Documentation

- New [MIGRATION-4.0.md](docs/MIGRATION-4.0.md), linked from the README and the docs index, which
  now has an *Upgrading* section — the 2.0 migration guide was in the tree but linked from
  nowhere but a directory listing.
- `USAGE.md` gains the classification table; `STATEFUL_SESSION_GUIDE.md` notes that a 401-driven
  refresh replaces the SAP session and surfaces as `ADT_SESSION_REPLACED` inside a lock window,
  while a 403 tears down nothing; the README and both examples no longer promise a refresh on
  403.

### Known

- Whether some BTP setup answers an *invalid* token with 403 rather than 401 is unobserved and
  tracked in [#32](https://github.com/fr0ster/mcp-abap-connection/issues/32). Preserving the
  original error is what makes the assumption safe to be wrong about.

## [3.0.0] - 2026-08-03

Undoes two mistakes from 2.0.0, four days old. Everything else that release
carried — mandatory `connect()`, replaced-session detection, session verdicts
surviving the retry layers, the Kerberos diagnosis — is unchanged.

### Changed — BREAKING
- **`disconnect()` returns `Promise<void>` and waits for nothing.** It used to
  drain in-flight requests before clearing anything, and that drain had an
  unbounded tail: a request whose caller chose no timeout — a legitimate choice
  for a long poll — could hold a teardown open forever. Because lifecycle
  transitions are serialized, every later `connect()` queued behind it. We
  published a `disconnect()` that resolves; that path could not.

  Deciding when to disconnect is the caller's, and so is preparing for it.
  Requests in flight now run to completion untouched — nothing is aborted — and
  the session state is cleared at once. Requires `@mcp-abap-adt/interfaces`
  **^12.0.0**.
- **A replaced session is always fatal.** It used to be tolerated when no lock
  window was open. Windows are gone (below), and this layer does not know that a
  lock exists, what object it covers or what would release it — so the rule is
  written from what it can know: the ABAP session we were speaking to is not the
  one we are speaking to now, and anything held against the old one is dead.
  Being wrong in this direction costs a reconnect; being wrong the other way
  costs a lock nobody can find.

### Removed — BREAKING
- **`beginWindow()` / `endWindow()`**, and the window accounting in
  `SessionLifecycle`. They were added in 2.0.0 and never worked: `beginWindow()`
  put a label in a map and touched no timeout. The protection they were assumed
  to provide — a span where a short per-request timeout must not abort a
  request — is `beginCriticalSection()` / `endCriticalSection()`, which has done
  it since 1.9.0, is reference-counted, and is **unchanged by this release**. Two
  mechanisms for one idea, and the one promoted into the public API was the
  no-op. Nothing called it: zero callers across every repository that depends on
  this package.

### Added
- **Session-generation fencing.** Removing the wait means a request can settle
  after a later `connect()` established a new session, and the response path
  mutates shared state — cookies, the identity policy, the CSRF cache. A stale
  response would write over the new session and could be read as a replacement,
  tearing down a session that is perfectly healthy. Every lease now carries the
  generation it was admitted under, and a response whose generation is not
  current has its effects skipped. It still resolves normally to its own caller:
  fencing suppresses effects, not results.

  Deliberately not the teardown epoch. Only a caller-initiated teardown moves the
  epoch — a recovery must not cancel itself — so after a session loss and a
  successful recovery, requests from the dead session carry the same epoch as the
  new one and pass straight through a fence built on it.

  The fence sits at the **top of the error path**, before anything reads or
  writes shared state — not merely before the response headers are applied.
  Everything below it acts on the connection rather than on the request: a late
  400 "session not found" would tear down the healthy session established since,
  and a late 401/403 would clear the live session's state, fetch a fresh CSRF
  token and **retry** — replaying a mutation from a dead session inside the live
  one. A stale request now gets its error back and nothing else happens.

### Fixed
- **Our own re-establishment no longer reads as someone else's replacement.**
  With a replacement now always fatal, a deliberate re-authentication would have
  torn the connection down: `invalidateSession()` dropped the cookies but kept
  the tracked identity, so the next cookie looked foreign. Both it and the
  establishment path now forget the identity first. The distinction that matters
  is not "was a lock held" but "did we cause this".

## [2.0.0] - 2026-07-29

The connection owns its session now, and says so. Before this release a stateful
ADT session could be replaced underneath a caller holding a lock — silently,
under an unchanged `sap-adt-connection-id`, with no way for either side to
notice. That is what orphans an edit lock and leaves an object inactive and
locked with nobody able to say whether the connector changed or the session
broke. Migration guide: [`docs/MIGRATION-2.0.md`](docs/MIGRATION-2.0.md).

### Changed — BREAKING
- **`connect()` is mandatory, and it rejects when it fails.** `makeAdtRequest()` now refuses with `ADT_NOT_CONNECTED` unless the connection was explicitly connected, and `connect()` no longer swallows a failed establishment: it used to log a warning, resolve anyway and defer establishment to the first request, which was coherent only while that lazy path existed. Removing it means a swallowed failure would leave a connection reporting success while holding nothing. A caller that never checked `connect()` now fails at startup rather than at the first request — the better failure, but a new one.
- **Consumers must call `connect()` before the first request.** Requests are also refused after `disconnect()` and after `reset()`, until the next `connect()`. An in-flight request is not cut off: a teardown drains before it clears anything.

### Added
- **`disconnect(): Promise<ITeardownReport>`.** Resolves rather than throws, and reports what the teardown could not finish: `abandonedWindows` names the lock windows still open when the bounded wait gave up, `releasePending` says a transport release is still outstanding. A caller learns which locks it must clean up by hand instead of discovering them on the next developer's screen.
- **`isConnected()` and `getSessionIdentity()`.** The session is observable now: whether a caller may work, and which ABAP session it would work over. The identity is derived from the `SAP_SESSIONID*` cookies and deliberately excludes `sap-XSRF_*`, which rotates on a token refresh *within* one session — folding it in would report an ordinary refresh as a new session.
- **`beginWindow(label)` / `endWindow(token)`.** Marks a span that must not lose its session, such as the interval between LOCK and UNLOCK. A teardown requested during an open window waits for it, bounded by an absolute ceiling measured from the request; on expiry the window is reported as abandoned rather than silently dropped.
- **The session lifecycle is on the shared contract, as capability atoms.** `AbstractAbapConnection` now declares `implements ISessionLifecycleAware, ILockWindowAware` from `@mcp-abap-adt/interfaces` 11.5.0, and `ITeardownReport`, `WindowToken`, `ADT_SESSION_ERROR` and `AdtSessionErrorCode` come from there. **Import them from `@mcp-abap-adt/interfaces`, not from this package** — it deliberately does not re-export them, because a contract type with two names is a contract type that can drift.

  Atoms rather than five more methods on `IAbapConnection`: that interface is the minimum every transport can honour, and `RfcAbapConnection` owns no HTTP session and can open no lock window. Requiring these of every connection would force a transport with no session to implement a lie. Narrow to the atom you need — `IAbapConnection & ILockWindowAware` — and the compiler rejects an RFC connection at the call site instead of failing at runtime.

### Fixed
- **A replaced session is now detected and raised instead of absorbed.** Responses are observed through one path that updates the cookies *and* applies the identity policy together; ten call sites used to update the cookies alone, which mutated the fingerprint and made a replacement indistinguishable from the session it replaced. A lost session raises `ADT_SESSION_REPLACED` and tears down, rather than letting the next request run against a session the caller never opened.
- **Session verdicts survive the retry layers.** Three nested catches — the CSRF retry, the 401-on-GET path and the endpoint fallback — used to swallow a session verdict and retry into a *new* session, where the replacement read as `unchanged` and the loss was gone for good.
- **A failed establishment leaves nothing behind.** A rejecting response could still carry a `Set-Cookie`, and every auth subclass treats a cookie as proof that auth is settled, so the *next* `connect()` went out with no credentials at all and failed for an unrelated reason. Transport state and the session identity are both dropped when `establishSession()` throws; `getSessionIdentity()` no longer names a session that was never established.
- **Kerberos: the first challenge is diagnosed, not the fourth.** The connect-time CSRF fetch inherited a 3-retry default while a GSS token is one-shot, so the diagnosis was drawn from a replayed — or credential-less — request. Multi-leg SPNEGO (RFC 4559) is still unsupported, but a landscape that needs it now fails at `connect()` saying so, instead of being misreported as rejected credentials.
- **The CSRF token fetch stays inside the ADT conversation** (also released in 1.10.1).
- **The test suite is green on a clean install.** `rfc-params.test.ts` called `jest.mock()` on `@mcp-abap-adt/sap-rfc-lite`, an **optional** dependency with a native build against the SAP NW RFC SDK. On any machine without that SDK npm skips it silently and `jest.mock()` cannot resolve it, so the suite failed — for everyone but whoever had a `node_modules` left over from an install that succeeded. Mocked `{ virtual: true }` now: the test replaces the module entirely and never wanted the real one.

### Security
- Production audit is clean. `brace-expansion` remains reachable only through `jest` and is pinned by an override; it never ships.

### Dependencies
- `@mcp-abap-adt/interfaces` 7.2.0 → **11.5.0**, now a real requirement rather than a version bump: this release imports the connection capability atoms from it. Crossing 8–11 was a no-op — those breaking changes are all in ADT object capability types, which the connector never imports — and it also closes the drift against `adt-clients` and `auth-providers`, both already on 11.x.

## [1.10.2] - 2026-07-27

### Added
- **`SessionLifecycle` — the session-lifecycle core, internal for now.** Owns what the connection cannot express today: session state and identity, a serializing tail for lifecycle transitions, admission accounting with a teardown epoch, lock windows counted per occurrence, and a drain bounded by an absolute ceiling. It knows nothing of SAP, HTTP, RFC or cookies — identities are opaque `name → value` maps, windows are opaque labels — which is why its 29 tests need no server. **Not exported from the package index and not yet used by any connection**, so this release changes no behaviour and no public API; it lands the piece that the rest of the session work (fr0ster/mcp-abap-connection#15) will be composed from. Design: `docs/superpowers/specs/2026-07-27-session-lifecycle-design.md` in `@mcp-abap-adt/adt-clients`.

## [1.10.1] - 2026-07-27

### Fixed
- **CSRF token fetch now stays inside the ADT conversation.** `makeAdtRequest` sends `sap-adt-connection-id` on every request, for all session types, but the token fetch assembled its own headers (auth + `x-csrf-token: fetch` + `Accept` + `Cookie`) and omitted it. A fetch triggered while a lock was held therefore reached the server as a caller that merely presented the same cookies, with no way for either side to relate it to the conversation that opened the session. The fetch now carries the connection id like every other request.

## [1.10.0] - 2026-07-16

### Added
- **Uninterruptible critical sections for lock → modify → unlock chains.** A short per-request timeout was aborting requests mid-flight during a stateful lock → PUT/activate → unlock chain; aborting the socket drops the stateful ADT session and orphans the lock handle, leaving the object **locked and inactive**. New connection methods `beginCriticalSection()` / `endCriticalSection()` (reference-counted) plus `isInCriticalSection()`: while in a critical section, `makeAdtRequest` raises the effective timeout to a large ceiling (`getCriticalSectionTimeout()`, env `SAP_TIMEOUT_CRITICAL`, default `600000` ms) instead of the short per-request timeout, so slow PUT/activate/unlock requests run to completion rather than being interrupted. Consumers wrap a mutating operation with `beginCriticalSection()` before locking and `endCriticalSection()` in a `finally` after unlocking. Additive and backward-compatible (no behavior change outside a critical section).

## [1.9.1] - 2026-05-24

### Added
- **NTLM hard-reject for Kerberos auth.** When `KerberosAbapConnection` receives a 401/403 whose `WWW-Authenticate` header indicates NTLM (direct `NTLM` scheme, or an NTLM token tunneled via `Negotiate` — base64 prefix `TlRMTVNTUAA` = `NTLMSSP\0`), it now throws a clear error instead of swallowing it. Prevents a silent downgrade to weaker NTLM; only Kerberos/SPNEGO is accepted. New `isNtlmChallenge()` helper (`src/auth/ntlm.ts`).

## [1.9.0] - 2026-05-24

### Added

- **Certificate (mTLS) authentication** — `CertificateAbapConnection` injects client-cert material into the axios `https.Agent` via a new protected `getHttpsAgentOptions()` hook on `AbstractAbapConnection`. Material loaded from PEM (`certPath`+`certKeyPath`) or PFX (`certPfxPath`+`certPassphrase`) by the injectable `FileCertificateMaterialLoader` (`ICertificateMaterialLoader`).
- **Kerberos / SPNEGO authentication** — `KerberosAbapConnection` generates a single-leg Negotiate token locally via `generateSpnegoToken()` (lazy wrapper over the optional `kerberos` native package, declared in `optionalDependencies`), sends `Authorization: Negotiate <token>` on the first request, then reuses the SAP session cookie.
- `createAbapConnection()` routes `authType: 'certificate'` and `'kerberos'`; both reject `connectionType: 'rfc'`. New optional `certLoader` factory option.
- `sapConfigSignature()` includes cert paths / SPN (secrets never embedded — passphrase recorded as `'set'`/null only).

### Notes

- Certificate and Kerberos are connection-layer auth types (on-prem HTTP); they bypass the auth-broker and auth-providers. Requires `@mcp-abap-adt/interfaces@^7.2.0`.
- Both connections require `connect()` before the first request; calling a request first fails loudly (cert: throws on missing material; kerberos: throws on missing token).

## [1.7.0] - 2026-04-14

### Changed

- Update `@mcp-abap-adt/interfaces` to `^7.0.0` (adds `ServiceBindingVariant` type and `connect()` method in `IAbapConnection`)

## 1.5.3 - 2026-03-12

### Added
- **RFC stateful session support**: `setSessionType('stateful')` now injects `x-sap-adt-sessiontype: stateful` header and captures `set-cookie` from LOCK responses for cookie replay in subsequent requests (PUT, UNLOCK). This enables lock/update/unlock workflows for package objects over RFC, which require HTTP session ownership validation. `setSessionType('stateless')` clears the captured cookie.

## 1.5.2 - 2026-03-12

### Added
- **RFC debug logging**: `RfcAbapConnection` now logs full request headers, request body, response headers, and response body at `debug` level. Enable with `DEBUG_CONNECTORS=true` and `AUTH_LOG_LEVEL=debug`.

## [1.5.1] - 2026-03-09

### Fixed
- **RFC query params encoding**: `RfcAbapConnection.makeAdtRequest` now encodes `params` into the URI query string. Previously `params` were silently ignored, causing failures for package validation, transport checks, and any ADT operation using query parameters over RFC connections.

## [1.4.2] - 2026-03-06

### Added
- `reset()` method on `RfcAbapConnection` — delegates to `close()` for interface compatibility with HTTP connections.

## [1.4.1] - 2026-03-06

### Fixed
- Fix RFC STATUS_LINE parsing: use correct field names `STATUS_CODE`/`REASON_PHRASE` (not `CODE`/`REASON`). STATUS_CODE is returned as string — now parsed with `parseInt`.
- Remove `sap-client` URI parameter from RFC requests — the RFC session is already logged into the correct client via connection parameters. Adding `sap-client` caused "object not found" on some systems.
- Add fallback exception XML detection: when STATUS_LINE is empty (legacy systems), parse `<exc:exception>` body to derive HTTP status codes (404, 403, 409, 423, etc.).

## [1.4.0] - 2026-03-06

### Added
- `RfcAbapConnection` — RFC-based connection for legacy SAP systems (BASIS < 7.50) that don't support stateful HTTP sessions. Uses standard `SADT_REST_RFC_ENDPOINT` FM (the same FM that Eclipse ADT uses via JCo) to tunnel ADT REST requests over RFC. Solves HTTP 423 "invalid lock handle" on older systems.
- `authType: 'rfc'` support in `createAbapConnection()` factory.
- RFC connection parameters (ashost, sysnr) are derived from the existing `config.url` field — no config changes needed.

### Changed
- Updated dependency `@mcp-abap-adt/interfaces` to `^2.7.0` (adds `'rfc'` to `SapAuthType` union).

### Notes
- `node-rfc` is **not** a declared dependency. Users who need RFC connections must install it manually (`npm install node-rfc`) along with SAP NW RFC SDK.
- RFC connections are inherently stateful — `setSessionType()` is a no-op.

## [1.1.0] - 2026-02-13

### Added
- Added generic `GenericWebSocketTransport` implementation with injected WS factory and message envelope handling.
- Re-exported WebSocket transport interfaces from `@mcp-abap-adt/interfaces` and transport class from package root.

### Changed
- Updated dependency `@mcp-abap-adt/interfaces` to `^2.4.0`.

## [1.0.1] - 2026-02-10

### Changed
- Dependency updates: `axios`, `commander`, `@biomejs/biome`, `@types/node`.

## [1.0.0] - 2026-02-10

### Added
- `SamlAbapConnection` for cookie-based SAML sessions and `createAbapConnection` support for `authType: 'saml'`.
- SAML session cookie support in `SapConfig` and `sapConfigSignature()`.
- Unit tests for SAML connection, connection factory routing, and config signature.

### Changed
- **Conditional Logging Support**: Connection package now fully supports conditional logging via `undefined` logger
  - When `undefined` is passed as logger parameter, connection operates silently (no logging output)
  - This enables test environments to control logging verbosity via environment variables
  - Tests can now pass `undefined` logger when `DEBUG_CONNECTION`, `DEBUG_CONN`, or `DEBUG_CONNECTORS` are not set
  - Connection uses optional chaining (`logger?.info()`, `logger?.debug()`, etc.) for all logging calls
  - No breaking changes - existing code with logger continues to work as before

## [0.2.8] - 2025-12-24

### Changed
- **Dependencies**: Updated `@mcp-abap-adt/interfaces` from `^0.2.5` to `^0.2.13`

## [0.2.7] - 2025-12-23
### Fixed
- Fixed LICENSE file - corrected copyright attribution (removed incorrect fork author)

## [0.2.6] - 2025-12-22

### Changed
- **Biome Migration**: Migrated from ESLint/Prettier to Biome for linting and formatting
  - Added `@biomejs/biome` as dev dependency
  - Added `lint`, `lint:check`, and `format` scripts to package.json
  - Integrated Biome check into build process (`npx biome check src --diagnostic-level=error`)
  - Updated Node.js imports to use `node:` protocol (`crypto`, `https`)
- **Type Safety**: Improved type safety by replacing `any` with `unknown`
  - `AbstractAbapConnection.ts`: `updateCookiesFromResponse` method parameter changed from `Record<string, any>` to `Record<string, unknown>`
  - `tokenRefresh.ts`: `error` parameter in catch block changed from `any` to `unknown` with added type guards

### Fixed
- Fixed computed property access by using literal keys where possible (`Authorization`, `Accept`, `Cookie` headers)
- Fixed non-null assertions by adding proper null checks (`JwtAbapConnection.ts`)
- Fixed optional chaining usage in `tokenRefresh.ts`
- Removed unused imports (`AbapConnection.ts`)
- Improved error handling with proper type guards for `unknown` error types

## [0.2.5] - 2025-12-21

### Added
- **connectionFactory tokenRefresher**: `createAbapConnection()` now accepts optional 4th parameter `tokenRefresher`
  - Passes through to `JwtAbapConnection` for automatic token refresh DI
  - Enables external token management via `AuthBroker.createTokenRefresher()`

## [0.2.4] - 2025-12-21

### Added
- **ITokenRefresher Support**: `JwtAbapConnection` now supports automatic token refresh via dependency injection
  - New optional `tokenRefresher` parameter in constructor
  - If provided, 401/403 errors trigger automatic token refresh and request retry
  - If not provided, legacy behavior (throw error on expired token)
  - Works with `AuthBroker.createTokenRefresher(destination)` from `@mcp-abap-adt/auth-broker`

### Changed
- **Dependencies**: Updated `@mcp-abap-adt/interfaces` to `^0.2.5`
  - New `ITokenRefresher` interface for token management DI
  - Simplified `IAbapConnection` interface

### Usage Example
```typescript
import { JwtAbapConnection } from '@mcp-abap-adt/connection';
import { AuthBroker } from '@mcp-abap-adt/auth-broker';

// Create token refresher from broker
const tokenRefresher = broker.createTokenRefresher('TRIAL');

// Inject into connection - 401/403 handled automatically
const connection = new JwtAbapConnection(config, logger, sessionId, tokenRefresher);
```

## [0.2.3] - 2025-12-19

### Fixed
- **Network Error Detection**: Add proper detection and handling of network-level errors in `AbstractAbapConnection.makeAdtRequest()`
  - Detect network errors: `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `ECONNRESET`, `ENETUNREACH`, `EHOSTUNREACH`
  - Skip retry logic for network errors (CSRF token retry, 401 cookie retry)
  - Throw network errors immediately with clear error message
  - Prevents confusing error messages when VPN is down or server is unreachable
  - Network errors now clearly indicate infrastructure issues vs application errors

### Changed
- **Error Handling**: Improved error handling logic to distinguish between network errors and HTTP errors
  - Network errors (connection issues) are now handled separately from HTTP errors (401, 403, 404)
  - No retry attempts for network errors (retries cannot fix infrastructure issues)
  - Better error logging with network error context

### Documentation
- Added "Network Error Detection" section to `docs/USAGE.md` with examples and best practices
- Documented all detected network error codes and their meanings
- Added error handling examples showing how to handle network vs HTTP errors

## [0.2.2] - 2025-12-13

### Fixed
- Add missing `ILogger` import from `@mcp-abap-adt/interfaces` to restore TypeScript build

## [0.2.1] - 2025-12-13

### Changed
- Dependency bump: `@mcp-abap-adt/interfaces` → `^0.1.16` to align with latest interfaces release
- Repository metadata: point package links to `fr0ster/mcp-abap-connection` (correct repo)

## [0.2.0] - 2025-12-08

### Breaking Changes

- **Token Refresh Removed**: Token refresh functionality has been completely removed from this package
  - `refreshToken()` method removed from `JwtAbapConnection`
  - `canRefreshToken()` method removed from `JwtAbapConnection`
  - All automatic token refresh logic removed from connection classes
  - Token refresh is now handled exclusively by `@mcp-abap-adt/auth-broker` package
  - This is a breaking change - code that relied on connection-level token refresh will need to use auth-broker instead

- **Logger is Optional**: Logger parameter is now optional in all connection constructors
  - `BaseAbapConnection`, `JwtAbapConnection`, and `createAbapConnection()` now accept `logger?: ILogger | null`
  - All logger calls use optional chaining (`logger?.info()`, `logger?.debug()`, etc.)
  - If no logger is provided, no logging output is produced (no-op behavior)
  - This allows using connections without requiring a logger instance

- **Session Storage Removed**: Session storage functionality has been completely removed from this package
  - `sessionStorage` parameter removed from all connection constructors (`BaseAbapConnection`, `JwtAbapConnection`, `createAbapConnection()`)
  - All session storage methods removed: `setSessionStorage()`, `getSessionStorage()`, `loadSessionState()`, `saveSessionState()`, `clearSessionState()`, `getSessionState()`, `setSessionState()`
  - `FileSessionStorage` utility class removed
  - Session state persistence is now handled exclusively by `@mcp-abap-adt/auth-broker` package
  - Connection package now handles only HTTP communication and session headers (cookies, CSRF tokens) without persistence
  - This is a breaking change - code that relied on connection-level session storage will need to use auth-broker instead

### Changed

- **Connection Package Scope**: Package now focuses solely on HTTP connection management
  - Removed all token refresh logic from `JwtAbapConnection`
  - Removed all token refresh logic from `connect()`, `makeAdtRequest()`, and `fetchCsrfToken()` methods
  - Removed all session storage and state persistence logic
  - Connection package now handles only HTTP communication and session headers (cookies, CSRF tokens)
  - Token lifecycle management and session state persistence are delegated to auth-broker package

### Removed

- **Token Refresh Methods**: 
  - `refreshToken()` method removed from `JwtAbapConnection`
  - `canRefreshToken()` method removed from `JwtAbapConnection`
  - `tokenRefreshInProgress` private field removed
  - Import of `refreshJwtToken` utility removed

- **Token Refresh Tests**:
  - `auto-refresh.test.ts` removed
  - Replaced with simplified `jwt-connection.test.ts` that tests only configuration validation

- **Session Storage Components**:
  - `FileSessionStorage` utility class removed
  - `ISessionStorage` and `SessionState` type exports removed
  - All session storage related imports and exports removed

### Migration Guide

If you were using token refresh functionality:

**Before (0.1.x)**:
```typescript
const connection = new JwtAbapConnection(config, logger);
if (connection.canRefreshToken()) {
  await connection.refreshToken();
}
```

**After (0.2.0)**:
```typescript
// Token refresh is now handled by auth-broker
// Connection package only handles HTTP communication
const connection = new JwtAbapConnection(config, logger);
// No refreshToken() or canRefreshToken() methods available
```

**Logger Usage**:
```typescript
// Logger is now optional
const connection = new JwtAbapConnection(config); // No logger - no logging output
const connection = new JwtAbapConnection(config, logger); // With logger - logging enabled
const connection = new JwtAbapConnection(config, null); // Explicitly no logger
```

If you were using session storage functionality:

**Before (0.1.x)**:
```typescript
import { FileSessionStorage } from '@mcp-abap-adt/connection';

const sessionStorage = new FileSessionStorage();
const connection = new JwtAbapConnection(config, logger, sessionStorage);
await connection.saveSessionState();
const state = await connection.getSessionState();
```

**After (0.2.0)**:
```typescript
// Session storage is now handled by auth-broker
// Connection package only handles HTTP communication
const connection = new JwtAbapConnection(config, logger);
// No sessionStorage parameter, no saveSessionState() or getSessionState() methods
```

## [0.1.15] - 2025-12-05

### Changed
- **Logger Interface Migration**: Migrated from specialized logger methods to standard `ILogger` interface
  - Replaced `logger.csrfToken()` calls with standard `debug()` and `error()` methods
  - Replaced `logger.tlsConfig()` calls with standard `debug()` method
  - Now uses only `ILogger` interface from `@mcp-abap-adt/interfaces` without dependency on concrete logger implementation
  - Follows Dependency Inversion Principle - depends on interface, not implementation

### Added
- **npm Configuration**: Added `.npmrc` file with `prefer-online=true` to ensure packages are installed from npmjs.com registry instead of local file system dependencies

## [0.1.14] - 2025-12-04

### Added
- **Interfaces Package Integration**: Migrated to use `@mcp-abap-adt/interfaces` package for all interface definitions
  - All interfaces now imported from shared package
  - Backward compatibility maintained with type aliases
  - Dependency on `@mcp-abap-adt/interfaces@^0.1.0` added

### Changed
- **Interface Renaming**: Interfaces renamed to follow `I` prefix convention:
  - `SapConfig` → `ISapConfig` (type alias for backward compatibility)
  - `AbapConnection` → `IAbapConnection` (type alias for backward compatibility)
  - `AbapRequestOptions` → `IAbapRequestOptions` (type alias for backward compatibility)
  - `SessionState` → `ISessionState` (type alias for backward compatibility)
  - `TokenRefreshResult` → `ITokenRefreshResult` (type alias for backward compatibility)
  - `TimeoutConfig` → `ITimeoutConfig` (type alias for backward compatibility)
  - Old names still work via type aliases for backward compatibility

### Documentation
- **Responsibilities and Design Principles**: Added comprehensive documentation section explaining package responsibilities and design principles

## [0.1.13] - 2025-12-01

### Added
- **CSRF Configuration Export**: Exported `CSRF_CONFIG` and `CSRF_ERROR_MESSAGES` constants for consistent CSRF token handling across different connection implementations
  - `CSRF_CONFIG`: Centralized constants for CSRF token fetching (retry count, delay, endpoint, headers)
  - `CSRF_ERROR_MESSAGES`: Standardized error messages for CSRF token operations
  - Enables other projects (e.g., Cloud SDK-based connections) to use the same CSRF configuration
  - Rationale in commit `ba12a42`; the standalone proposal document it linked is no longer in the tree

### Changed
- **CSRF Token Endpoint**: Updated CSRF token fetching to use `/sap/bc/adt/core/discovery` endpoint instead of `/sap/bc/adt/discovery`
  - Lighter response payload
  - Available on all SAP systems (on-premise and cloud)
  - Standard ADT discovery endpoint

## [0.1.12] - 2025-11-28

### Changed
- **BREAKING**: Removed all file reading functionality from connection package:
  - Connection package no longer reads `.env` files or any configuration files
  - Connection package no longer depends on `dotenv` or file system operations for configuration
  - Consumers must now pass `SapConfig` directly to connection constructors
  - This change improves separation of concerns: connection layer is now purely about connection logic, not configuration management

### Removed
- `loadEnvFile(envPath?: string): boolean` - Function that loaded `.env` files
- `loadConfigFromEnvFile(envPath?: string): SapConfig` - Convenience function that combined file loading and config reading
- `getConfigFromEnv(): SapConfig` - Function that read configuration from `process.env`
- All file system dependencies (`fs`, `path`) from `sapConfig.ts`
- All `dotenv` usage and dependencies from the package

### Fixed
- Resolved `stdio` mode output corruption issues by removing `dotenv` dependency
- Connection package is now cleaner and more focused on connection logic only
- Configuration management is now the responsibility of consumers (e.g., `mcp-abap-adt`)

### Migration Guide
If you were using `getConfigFromEnv()` or `loadConfigFromEnvFile()`:
1. Read environment variables in your application code (using `dotenv` or manual parsing)
2. Create `SapConfig` object from environment variables
3. Pass `SapConfig` directly to `createAbapConnection()` or connection constructors

Example:
```typescript
// Before (0.1.11 and earlier):
import { loadConfigFromEnvFile, createAbapConnection } from '@mcp-abap-adt/connection';
const config = loadConfigFromEnvFile();
const connection = createAbapConnection(config, logger);

// After (0.1.12+):
import { SapConfig, createAbapConnection } from '@mcp-abap-adt/connection';
// Load .env file in your application (using dotenv or manual parsing)
const config: SapConfig = {
  url: process.env.SAP_URL!,
  authType: 'jwt',
  jwtToken: process.env.SAP_JWT_TOKEN!,
  // ... other config
};
const connection = createAbapConnection(config, logger);
```

## [0.1.11] - 2025-11-25

### Changed
- Updated documentation:
  - `docs/JWT_AUTH_TOOLS.md`: Added examples showing token expiry information in generated `.env` files, explained automatic expiry detection feature
  - `docs/INSTALLATION.md`: Updated JWT authentication section with token expiry examples, added manual setup option, updated version to 0.1.10
  - Documentation now reflects the new token expiry feature introduced in 0.1.10 and provides clear guidance for users

## [0.1.10] - 2025-11-25

### Added
- Token expiry information in `.env` file generated by `sap-abap-auth` CLI:
  - Automatic JWT token expiry date extraction and display
  - Automatic refresh token expiry date extraction and display
  - Human-readable expiry dates in UTC timezone
  - ISO 8601 formatted expiry timestamps
  - Comments added at the beginning of `.env` file for easy reference
- `getTokenExpiry()` utility function in `sap-abap-auth.js`:
  - Decodes JWT tokens to extract expiration information
  - Handles base64url encoding/decoding
  - Returns structured expiry information (timestamp, date, readable format)
  - Gracefully handles invalid or non-standard JWT tokens

### Changed
- Enhanced `updateEnvFile()` function in `sap-abap-auth.js`:
  - Now includes token expiry comments at the beginning of `.env` files
  - Provides clear visibility into when tokens will expire
  - Helps users proactively refresh tokens before expiration

## [0.1.9] - 2025-11-23

### Changed
- Updated documentation in README.md:
  - Added information about new API methods (`getSessionId()`, `setSessionType()`)
  - Enhanced `AbapConnection` interface documentation
  - Added Changelog section with link to CHANGELOG.md
  - Fixed documentation links to use `docs/` directory
  - Specified current version (0.1.8) with key features
- Updated CHANGELOG.md:
  - Added detailed descriptions for all versions (0.1.1-0.1.8)
  - Fixed version ordering (newest to oldest)
  - Added proper version links for all releases
  - Documented all features, changes, and fixes for each version

### Added
- Comprehensive version history documentation
- Version comparison links in CHANGELOG

## [0.1.8] - 2025-11-22

### Changed
- Refactored base URL handling in `AbstractAbapConnection`:
  - Removed deprecated `setBaseUrl()` and `getBaseUrl()` methods
  - Base URL now managed internally via constructor
  - Improved URL construction consistency
- Enhanced session management:
  - Added `getSessionId()` method to retrieve current session ID
  - Added `setSessionType()` method to switch between stateful/stateless modes
  - Session ID now auto-generated if not provided
  - Improved session state management in `AbstractAbapConnection`

### Added
- cSpell configuration for custom words in settings.json
- Automatic session ID generation when not explicitly provided
- GitHub Actions workflow for automated release process
- Environment file loading and configuration utilities
- `getSessionId()` and `setSessionType()` public methods for better session control

### Removed
- Deprecated `setBaseUrl()` and `getBaseUrl()` methods from `AbstractAbapConnection`
  - Use constructor parameter instead for setting base URL

### Fixed
- Session ID generation now more robust
- Base URL handling more consistent across connection types

## [0.1.7] - 2025-11-22

### Changed
- Refactored base URL handling in `AbstractAbapConnection`:
  - Base URL construction now centralized and consistent
  - Improved URL parsing and validation
  - Removed deprecated URL handling methods

### Removed
- Deprecated methods for base URL manipulation
  - Use constructor-based URL configuration instead

## [0.1.6] - 2025-11-22

### Added
- `getSessionId()` method to retrieve current session ID
- `setSessionType()` method to programmatically switch between stateful/stateless modes
- Better session management API for external control

### Changed
- Enhanced session management with more granular control
- Session type can now be changed after connection creation

## [0.1.5] - 2025-11-22

### Changed
- Refactored session ID generation and state management in `AbstractAbapConnection`
- Improved session state persistence logic
- Better handling of session lifecycle

### Fixed
- Session state management edge cases
- Session ID consistency across connection lifecycle

## [0.1.4] - 2025-11-21

### Added
- Automatic session ID generation when not explicitly provided
- Session ID now auto-generated using UUID if not specified
- Improved session management for stateful connections

### Changed
- Session creation logic simplified - no manual ID required
- Default session behavior more intuitive

## [0.1.3] - 2025-11-20

### Added
- GitHub Actions workflow for automated release process
- Automated npm publishing on version tags
- CI/CD pipeline for package releases

### Changed
- Release process now automated via GitHub Actions
- Version tagging triggers automatic npm publish

## [0.1.2] - 2025-11-20

### Changed
- Updated dependencies to latest versions
- Enhanced TypeScript configuration for better type safety
- Improved build output structure

### Added
- Better TypeScript compiler options
- Stricter type checking enabled

## 0.1.0 - 2024-11-14

### Changed
- **BREAKING**: Architecture refactoring for proper separation of concerns:
  - `connect()` method changed from concrete to **abstract** in `AbstractAbapConnection`
  - Each authentication type now implements its own `connect()` logic:
    - `BaseAbapConnection`: Basic auth with CSRF token fetch, logs warnings on errors
    - `JwtAbapConnection`: JWT auth with automatic token refresh on 401/403 errors
  - `fetchCsrfToken()` changed from `private` to `protected` for use by concrete implementations
  - Added protected getters/setters: `getCsrfToken()`, `setCsrfToken()`, `getCookies()`
  - Removed ALL JWT-specific logic from `AbstractAbapConnection`:
    - Removed JWT expiration checks from `connect()`
    - Removed JWT error handling from base class
    - Base class is now completely auth-agnostic
  - `JwtAbapConnection.connect()` now handles:
    - Token expiration detection (401/403 errors)
    - Permission vs auth error distinction (`ExceptionResourceNoAccess` check)
    - Automatic token refresh and retry
  - `JwtAbapConnection.makeAdtRequest()` override handles JWT refresh for regular requests
  - Previous architecture cleanup (from earlier versions):
    - `BaseAbapConnection` (abstract) → `AbstractAbapConnection` 
    - `OnPremAbapConnection` → `BaseAbapConnection`
    - `CloudAbapConnection` → `JwtAbapConnection`

### Added
- Automatic JWT token refresh functionality for cloud connections
  - Auto-refresh on 401/403 errors in both `connect()` and `makeAdtRequest()`
  - Permission error detection: skips refresh for "ExceptionResourceNoAccess", "No authorization", "Missing authorization"
  - `canRefreshToken()` method to check if refresh credentials available
  - `refreshToken()` method to refresh JWT using UAA OAuth2 endpoint
  - Concurrent refresh protection (prevents multiple simultaneous refresh attempts)
- Protected helper methods in `AbstractAbapConnection` for subclass use:
  - `fetchCsrfToken()` - CSRF token fetching with retry logic
  - `getCsrfToken()`, `setCsrfToken()` - CSRF token management
  - `getCookies()` - Cookie access for concrete implementations
- Unit tests for auto-refresh logic (`src/__tests__/auto-refresh.test.ts`)
- Documentation structure:
  - `docs/INSTALLATION.md` - Installation guide
  - `docs/USAGE.md` - Usage examples and API documentation
  - `docs/CUSTOM_SESSION_STORAGE.md` - Custom session storage implementation
- Example files:
  - `examples/basic-connection.js` - Simple connection example
  - `examples/session-persistence.js` - FileSessionStorage usage
  - Updated `examples/README.md` with all examples

### Removed
- JWT-specific logic from `AbstractAbapConnection`:
  - Removed `isJwtExpiredError()` helper method
  - Removed JWT refresh logic from base `connect()` method
  - Removed JWT error messages from abstract class
- `AbstractAbapConnection` from public exports (internal use only)
  - Only `BaseAbapConnection` and `JwtAbapConnection` are exported publicly
- `AUTO_REFRESH_IMPROVEMENTS.md` (temporary document, content moved to CHANGELOG)
- `CONNECTION_LAYER_ROADMAP.md` (roadmap belongs in root project)
- `PUBLICATION_ROADMAP.md` (roadmap belongs in root project)

### Fixed
- JWT token refresh now properly handles connection errors (401/403 during initial connect)
- Permission errors (403 with "ExceptionResourceNoAccess") no longer trigger JWT refresh loops
- Proper separation: base class handles HTTP/session, concrete classes handle auth-specific errors
- Auto-refresh not triggering due to `canRefreshToken()` returning false
  - Root cause: Test configuration not reading UAA credentials from environment
  - Fixed in `packages/adt-clients` by updating `getConfig()` to read UAA variables

## 0.1.0 - 2024-11-14

### Changed
- **BREAKING**: Architecture refactoring for proper separation of concerns:
  - `connect()` method changed from concrete to **abstract** in `AbstractAbapConnection`
  - Each authentication type now implements its own `connect()` logic:
    - `BaseAbapConnection`: Basic auth with CSRF token fetch, logs warnings on errors
    - `JwtAbapConnection`: JWT auth with automatic token refresh on 401/403 errors
  - `fetchCsrfToken()` changed from `private` to `protected` for use by concrete implementations
  - Added protected getters/setters: `getCsrfToken()`, `setCsrfToken()`, `getCookies()`
  - Removed ALL JWT-specific logic from `AbstractAbapConnection`:
    - Removed JWT expiration checks from `connect()`
    - Removed JWT error handling from base class
    - Base class is now completely auth-agnostic
  - `JwtAbapConnection.connect()` now handles:
    - Token expiration detection (401/403 errors)
    - Permission vs auth error distinction (`ExceptionResourceNoAccess` check)
    - Automatic token refresh and retry
  - `JwtAbapConnection.makeAdtRequest()` override handles JWT refresh for regular requests
  - Previous architecture cleanup (from earlier versions):
    - `BaseAbapConnection` (abstract) → `AbstractAbapConnection` 
    - `OnPremAbapConnection` → `BaseAbapConnection`
    - `CloudAbapConnection` → `JwtAbapConnection`

### Added
- Initial release of `@mcp-abap-adt/connection` package
- Support for Basic Auth (on-premise systems)
- Support for JWT/OAuth2 (SAP BTP cloud systems)
- CSRF token management
- Cookie-based session management
- `FileSessionStorage` for session persistence
- `ISessionStorage` interface for custom session storage
- CLI tool (`sap-abap-auth`) for browser-based authentication
- TypeScript type definitions
- Configurable timeouts for different operation types
- Custom logger interface (`ILogger`)
- Connection factory (`createAbapConnection()`)
- `BaseAbapConnection` for basic auth (formerly `OnPremAbapConnection`)
- `JwtAbapConnection` for JWT auth (formerly `CloudAbapConnection`)
- Session state management (`getSessionState()`, `setSessionState()`)
- Automatic JWT token refresh functionality for cloud connections
  - Auto-refresh on 401/403 errors in both `connect()` and `makeAdtRequest()`
  - Permission error detection: skips refresh for "ExceptionResourceNoAccess", "No authorization", "Missing authorization"
  - `canRefreshToken()` method to check if refresh credentials available
  - `refreshToken()` method to refresh JWT using UAA OAuth2 endpoint
  - Concurrent refresh protection (prevents multiple simultaneous refresh attempts)
- Protected helper methods in `AbstractAbapConnection` for subclass use:
  - `fetchCsrfToken()` - CSRF token fetching with retry logic
  - `getCsrfToken()`, `setCsrfToken()` - CSRF token management
  - `getCookies()` - Cookie access for concrete implementations
- Unit tests for auto-refresh logic (`src/__tests__/auto-refresh.test.ts`)
- Documentation structure:
  - `docs/INSTALLATION.md` - Installation guide
  - `docs/USAGE.md` - Usage examples and API documentation
  - `docs/CUSTOM_SESSION_STORAGE.md` - Custom session storage implementation
  - `docs/STATEFUL_SESSION_GUIDE.md` - Session state management guide
- Example files:
  - `examples/basic-connection.js` - Simple connection example
  - `examples/session-persistence.js` - FileSessionStorage usage
  - `examples/README.md` with all examples

### Removed
- JWT-specific logic from `AbstractAbapConnection`:
  - Removed `isJwtExpiredError()` helper method
  - Removed JWT refresh logic from base `connect()` method
  - Removed JWT error messages from abstract class
- `AbstractAbapConnection` from public exports (internal use only)
  - Only `BaseAbapConnection` and `JwtAbapConnection` are exported publicly

### Fixed
- JWT token refresh now properly handles connection errors (401/403 during initial connect)
- Permission errors (403 with "ExceptionResourceNoAccess") no longer trigger JWT refresh loops
- Proper separation: base class handles HTTP/session, concrete classes handle auth-specific errors
[Unreleased]: https://github.com/fr0ster/mcp-abap-connection/compare/v6.0.1...HEAD
[6.0.1]: https://github.com/fr0ster/mcp-abap-connection/compare/v6.0.0...v6.0.1
[6.0.0]: https://github.com/fr0ster/mcp-abap-connection/compare/v5.0.0...v6.0.0
[5.0.0]: https://github.com/fr0ster/mcp-abap-connection/compare/v4.0.0...v5.0.0
[4.0.0]: https://github.com/fr0ster/mcp-abap-connection/compare/v3.0.0...v4.0.0
[3.0.0]: https://github.com/fr0ster/mcp-abap-connection/compare/v2.0.0...v3.0.0
[2.0.0]: https://github.com/fr0ster/mcp-abap-connection/compare/v1.10.2...v2.0.0
[1.10.2]: https://github.com/fr0ster/mcp-abap-connection/compare/v1.10.1...v1.10.2
[1.10.1]: https://github.com/fr0ster/mcp-abap-connection/compare/v1.10.0...v1.10.1
[1.10.0]: https://github.com/fr0ster/mcp-abap-connection/compare/v1.9.1...v1.10.0
[1.9.1]: https://github.com/fr0ster/mcp-abap-connection/compare/v1.9.0...v1.9.1
[1.9.0]: https://github.com/fr0ster/mcp-abap-connection/compare/v1.7.0...v1.9.0
[1.7.0]: https://github.com/fr0ster/mcp-abap-connection/compare/v1.5.1...v1.7.0
[1.5.1]: https://github.com/fr0ster/mcp-abap-connection/compare/v1.4.2...v1.5.1
[1.4.2]: https://github.com/fr0ster/mcp-abap-connection/compare/v1.4.1...v1.4.2
[1.4.1]: https://github.com/fr0ster/mcp-abap-connection/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/fr0ster/mcp-abap-connection/compare/v1.1.0...v1.4.0
[1.1.0]: https://github.com/fr0ster/mcp-abap-connection/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/fr0ster/mcp-abap-connection/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/fr0ster/mcp-abap-connection/compare/v0.2.8...v1.0.0
[0.2.8]: https://github.com/fr0ster/mcp-abap-connection/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/fr0ster/mcp-abap-connection/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/fr0ster/mcp-abap-connection/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/fr0ster/mcp-abap-connection/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/fr0ster/mcp-abap-connection/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/fr0ster/mcp-abap-connection/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/fr0ster/mcp-abap-connection/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/fr0ster/mcp-abap-connection/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/fr0ster/mcp-abap-connection/compare/v0.1.15...v0.2.0
[0.1.15]: https://github.com/fr0ster/mcp-abap-connection/compare/v0.1.14...v0.1.15
[0.1.14]: https://github.com/fr0ster/mcp-abap-connection/compare/v0.1.13...v0.1.14
[0.1.13]: https://github.com/fr0ster/mcp-abap-connection/compare/v0.1.12...v0.1.13
[0.1.12]: https://github.com/fr0ster/mcp-abap-connection/compare/v0.1.11...v0.1.12
[0.1.11]: https://github.com/fr0ster/mcp-abap-connection/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/fr0ster/mcp-abap-connection/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/fr0ster/mcp-abap-connection/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/fr0ster/mcp-abap-connection/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/fr0ster/mcp-abap-connection/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/fr0ster/mcp-abap-connection/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/fr0ster/mcp-abap-connection/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/fr0ster/mcp-abap-connection/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/fr0ster/mcp-abap-connection/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/fr0ster/mcp-abap-connection/releases/tag/v0.1.2
