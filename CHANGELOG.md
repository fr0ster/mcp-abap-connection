# Changelog

All notable changes to the `@mcp-abap-adt/connection` package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  which is `0`. A malformed value throws before anything is torn down rather than being
  repaired into a default.

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

### Tests

- The stub in `sessionComposition.test.ts` answered every route instantly, `/sap/bc/adt/slow`
  included, so *does not wait for an in-flight request* held whenever `disconnect()` performed no
  I/O rather than because the teardown declined to wait. That route now takes 300 ms and the test
  asserts what its name says.

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
[Unreleased]: https://github.com/fr0ster/mcp-abap-connection/compare/v4.0.0...HEAD
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
