# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # Clean + biome lint (error-level) + tsc compile
npm run build:fast     # tsc only (skip clean and lint, for rapid iteration)
npm run lint           # Biome auto-fix (src and scripts)
npm run lint:check     # Biome read-only check (src and scripts)
npm run test:shape     # The auth contract's shape check (rules 4,5,6), as a Jest test
npm test               # Jest (all tests)
npx jest --testPathPatterns=rfcTransport      # Run a single test file
SAP_ENV_FILE=e19.env npx jest --testPathPatterns=rfc-connection  # live, needs an on-prem system
```

Live suites read an env file from the repo root and skip themselves when it is
absent — which is why the same command is green on a machine that cannot reach
a system, and proves nothing there. The RFC suite also skips when
`@mcp-abap-adt/sap-rfc-lite` does not resolve: nothing here is configured at
build time the way a C package is, so the installed optional dependency IS the
choice of wire, and a machine that did not install it is not one taking RFC.

## Architecture

SAP ABAP ADT connection library: session lifecycle, auth and request handling
against an ABAP system, over HTTP or over RFC.

**Three axes, all stated by the caller, none inferred.** Nothing is worked out
from the config, the host name, or by asking the server — that is the rule the
whole design is arranged around.

```
                    which system            which credential        which wire
AbstractAbapConnection ──┬── AdtOnPremConnector   IAuthProvider ──┐   IAdtTransport ──┐
   (lifecycle only,      │      ICF session       (any; the ones     HttpTransport
    NOT exported)        └── AdtCloudConnector    shipped are in     RfcTransport
                                security session  auth-providers)
```

The providers (`BasicAuthProvider`, `TokenAuthProvider`, `SamlAuthProvider`,
`CertificateAuthProvider`) live in `@mcp-abap-adt/auth-providers` (6.0.0), which this
package uses as a **dev** dependency only (tests). It has no runtime dependency
on it, and nothing here may branch on which provider it was handed.

  new AdtCloudConnector(config, credential, new CloudHttpTransport(…), logger)
  new AdtOnPremConnector(config, credential, new OnPremHttpTransport(…), logger)
  new AdtOnPremConnector(config, credential, new RfcTransport(…), logger)

The wire is required and the caller builds it: there is no default and nothing
is derived from the config. Cloud has one wire, so its type parameter admits
only `ICloudTransport` — "cloud over RFC" does not compile. On-prem has two, and
which one is the caller's to say.

**Who owns what.** This is the line to keep; it was crossed for a long time and
the RFC wire could not connect at all as a result.

- `AbstractAbapConnection` — the LIFECYCLE, and nothing about any wire: the
  connect/disconnect transition queue, teardown epochs, session generations,
  critical sections, stale-request fencing, 401 classification, the identity
  policy, and the promise that `disconnect()` always settles.
- `IAdtTransport` — everything that is true of a wire: carrying a request,
  addressing it, establishing itself, and whatever session state it keeps.
  `HttpTransport` has a cookie jar, a CSRF token, affinity headers and axios;
  `RfcTransport` has a conversation that IS the session and none of the rest.
- `IAuthProvider` (from `@mcp-abap-adt/interfaces-auth` ^7.5.0) — the credential,
  including its own renewal. The connection calls `prepare()` once before the wire
  opens, `establish(logon)` at each logon (through `IAdtSessionContext.logon`),
  `authorize(request)` before every attempt (through
  `IAdtSessionContext.authorize`), and `rejected(rejection)` on a 401 that survived
  the wire's session recovery or a refused logon. Ok means exactly one more
  attempt; a second refusal is `AuthRefusedError`, never a loop. A 403 never goes
  to the provider. The wire offers what it can carry (`ILogonTarget`: TLS material
  for HTTP, logon parameters for RFC), the provider writes, the connection decides
  the lifecycle. A wire marks a refused logon with `WireLogonError` and decides
  nothing else. The connection guards every provider call (`guarded(call, at)`):
  a throw, or an answer that is not a minted outcome, is the refusal
  `connection` / `provider-threw` ("the credential provider failed"); every
  answer passes through `classifyOutcome`, so a forged refusal's text reaches no
  message.
- **Refusals are minted, never written.** Every refusal is an
  `IAuthProviderError` built by `@mcp-abap-adt/auth-errors` (`authError[kind]`):
  the targets answer `logon-target`, connection's own are `connection`
  (`providerFailed(at)`, `refusedAgain(at)`, `NO_CREDENTIAL_TO_RENEW` in
  `authErrors.ts`). An object literal does not compile; no type assertion to a
  contract type, no spread of an error, no diagnostics — a Jest test
  (`src/__tests__/shapeCheck.test.ts`) runs the contract's shape check (rules
  4, 5, 6) through `@mcp-abap-adt/auth-errors/shape-check` over the whole
  tree, with empty site lists, and each fixture under `tools/__fixtures__` is
  refused by its rule alone. `npm test` runs it, and so does `npm run
  test:shape`, which `prepublishOnly` names in the place `lint:check` once
  ran the check; the test asserts both. There is no copy of the check here.
- **The tests run the real auth-providers 6.0.0 providers** (devDependency
  `^6.0.0`), handed to the connector unwrapped. A token provider needs
  `renewal` (`refreshThenLogin()` / `refreshOnly()`); one that needs a browser
  gets a fake `IBrowser` — no test starts a real browser or program.
  `CertificateAuthProvider` checks its material in `prepare()`: load a real
  pair (`src/__tests__/fixtures/tls`), never placeholder strings.
- The connector — which session mechanism this system uses, and nothing else.

**If you find yourself checking the transport's kind in the base, that is the
smell.** There is no `if (transport is rfc)` anywhere, and adding one means the
fact belongs on the transport instead.

**Key design decisions:**
- All external deps accessed through the contract packages —
  `@mcp-abap-adt/interfaces-adt`, `-auth`, `-auth-sap`, `-network`, `-utils` — no
  direct coupling; the one runtime beside them is `@mcp-abap-adt/auth-errors`,
  which mints and classifies auth refusals. NOT `@mcp-abap-adt/interfaces`: that umbrella is **deleted**
  as of its 52.0.0, npm serves 51.0.0 to whoever is pinned to it, and this
  package does not depend on it
- Logger is optional everywhere, all calls use `logger?.method()` pattern
- The connection hands the wire a PATH; putting a server in front of it is the
  wire's business. An absolute URL in `SADT_REST_RFC_ENDPOINT`'s request line
  dumps the FM with `STRING_OFFSET_TOO_LARGE`.
- CSRF fetch retries 3 times, falling back to `/sap/bc/adt/discovery` only when
  the primary endpoint answers 404 — a host that is not answering will not
  answer a different path either
- `RfcTransport` supplies a default `Accept`: axios adds one over HTTP, and ADT
  refuses a request without it (`400 ExceptionResourceBadRequest`)
- BASIS 7.40 is a WIRE, not a flag: `LegacyOnPremHttpTransport` never sends the
  stateful header (which on that release keeps locks in session memory instead of
  the enqueue table, so the next `PUT` comes back 423) and reports a session as
  established, because that system names none. The old `skipSessionType` option
  is gone — taking the class is how you say which deployment this is
- Timeouts: the library applies exactly two of its own — `SAP_TIMEOUT_CSRF` for
  establishing a session, and `SAP_TIMEOUT_CRITICAL` as the ceiling it raises a
  request to inside a critical section. `SAP_TIMEOUT_DEFAULT` and
  `SAP_TIMEOUT_LONG` configure `getTimeout()`, which is exported for callers to
  pass back in `makeAdtRequest`; nothing in `src/` reads either. A per-request
  deadline is the caller's choice and is honoured only by the HTTP wire — RFC
  is a synchronous call with nothing to cancel. There is no per-request
  signal (15.1.0 had one; 16.0.0 removed it): ABAP neither cancels nor rolls
  back, and the logoff is what releases the ENQUEUE locks
- `disconnect()` resolves once the logoff is WRITTEN — the node request's
  `finish`, seen through `HttpTransport.logoffRequest` and axios's `transport`
  option; over RFC, once the close call returned — never on SAP's answer,
  which SAP queues behind a request still running in the stateful ABAP
  session. Live check on E19 (2026-10-13, this build): LOCK + a long
  where-used, `await disconnect()`, exit at once — lock held 1 s later, free
  ~70 s after the exit: ICM ran the queued logoff after the connection
  closed.
  `IAdtTransport.close(context, written?)` reports it; a settled close is past
  the write. `flushGoodbye()` is the wait for the answer. `disconnect()` is
  called once per `connect()`: a second call rejects `NOT_CONNECTED` (a
  consumer that calls it twice is told, not engineered around); a failed
  `connect()` that dispatched a goodbye rejects only after it is written.
  Name the session: the **HTTP security session** (ICF, `SECURITY_CONTEXT`,
  `SAP_SESSIONID_<SID>_<CLIENT>`) is what a connect failing after
  authentication leaves alive on both wires (cloud preflight: BTP trial
  2026-10-12; on-prem: E19 2026-10-13, an authenticated 404/403 still set a
  live `SAP_SESSIONID`; ABAP code: `CL_HTTP_SERVER_NET->authentication`
  creates it before any handler, `send_response` sets the cookie whatever the
  status), and the ICF logoff ends it only when `SAP_SESSIONID` is present
  (ABAP code). Hence the rule, on both wires (`HttpTransport.
  holdsSessionCookie`, read from the jar, never from the overridable
  `sessionEstablished()`): the logoff is sent iff the wire holds a non-empty
  `SAP_SESSIONID_*` it received, whatever the status — a 404/403 at logon
  gets one, a 401's debris or a 200 with only `sap-XSRF_*` gets none. The jar
  drops a cookie whose `Set-Cookie` has a past `expires` or `Max-Age=0` (SAP's
  logoff deletes with a one-character value and a 1980 expiry, E19 trace
  2026-10-13). A core-discovery 404 is not a failed connect: the fallback
  runs in the same session, and the goodbye goes only when connect() as a
  whole fails. In short: `disconnect()` logs off iff a live `SAP_SESSIONID`
  is held; a failed `connect()` logs off itself only when the whole connect
  (core + fallback discovery) failed AND a live `SAP_SESSIONID` was received;
  a successful connect sends none. Two sessions: `SAP_SESSIONID` = HTTP
  security session (logon), `sap-contextid` (`path=/sap/bc/adt`) = ABAP
  session with the locks (`IAdtTransport.abapContext()`); a DIFFERENT
  `sap-contextid` inside a critical section is SESSION_REPLACED
  (`applyContextPolicy`; measured E19 2026-10-13: a new context leaves the
  old lock unreachable), a first-issued or deleted one is not — and the
  connection then logs the security session off at once, before forgetting
  the cookies (`ownGoodbye`; the caller's `disconnect()` waits for its write,
  `flushGoodbye()` for its answer, and a reconnect waits for its write before
  establishing). The logoff never carries `sap-contextid`
  (`logoffCookies`): measured on E19 2026-10-13, a logoff without it ended
  the context and freed the lock, one with a stale one got 400. After an
  UNLOCK the stateful context lives on, lockless, until the logoff or a
  stateless request in it. The
  **ABAP session** (`sap-contextid`, stateful context, ENQUEUE locks) ending
  with it rests on the kernel module `LocalSessionTermination`'s comment and
  the measured lock release; a failed stateful request leaving one rests only
  on the `sap-contextid` cookie seen. A failed `connect()` takes no lock.
  Tests:
  `disconnectWritten` (a real stand-in server that holds its answer; a socket
  that never takes the bytes; RFC)

**Taking the RFC wire** needs the SAP NW RFC SDK on the machine and
`@mcp-abap-adt/sap-rfc-lite` installed; `rfcConversationFrom(config)` derives
`ashost`/`sysnr` (no user or password: the provider's logon parameters are spread
over them at each open) and loads the SDK lazily, so a machine without it fails at
`connect()` rather than at construction.

## Conventions

- **Biome** enforces formatting and linting — build fails on format errors
- Single quotes, semicolons always, 2-space indent
- Node built-ins use `node:` prefix (e.g., `node:https`, `node:crypto`)
- Local imports use `.js` extension (CommonJS output, ESM-compatible paths)
- Tests in `src/__tests__/*.test.ts`, excluded from tsc compilation
- Tests use `(instance as any).method()` to access protected members
- Stub a transport UNDER what you are testing, not instead of it: replacing
  `transport.send` skips everything the wire adds to its own requests, so
  replace `transport.client` when the subject is cookies or affinity headers
- "Nothing is left unhandled" is proven under plain node, never inside Jest:
  Jest hands a test a copy of `process`, and the real one's
  `unhandledRejection` never reaches a listener on the copy, so such an
  assertion in a Jest test cannot fail. `helpers/plainNode/run.ts`
  (`runScenario`, `recordUnhandled`) runs a scenario through
  `register.cjs` (TypeScript transpiled with the repo's own `typescript`);
  each scenario has a control run that leaves one rejection unhandled on
  purpose. `connection/dispatchedGoodbye.test.ts` is the first user
- `src/__tests__/helpers/transportStub.ts` carries the session half of
  `IAdtTransport` for stubs whose subject is something else

## Verifying against a real system

Unit tests cannot tell you that SAP accepts what is being built for it, and the
on-prem half of this library is where that gap has bitten. The live suites are
the durable part of that: they read an env file from the repo root and skip
themselves when it is absent — and the RFC one also when the SDK it needs is
not installed.

`scripts/` also collects ad-hoc probes written for whatever release was being
verified at the time. They are not part of the contract — they come and go, and
they are not compiled by `tsconfig.json` — so read the file before running one
rather than trusting a command written down here.

What to look at on the system itself: an HTTP session appears in **SM05**; an
RFC conversation appears in **SMGW -> Logged on Clients** and never in SM05,
because there is no ICM in that path. Sessions are per user and shared with
every other tool logged on as them, which is **SM04**.

## Release

GitHub Actions triggers on `v*.*.*` tags — runs build, `npm pack`, creates GitHub Release with `.tgz`.

- Never change `package.json` version without explicit user request
- After changing the version in `package.json`, always run `npm install --package-lock-only` to update `package-lock.json` and include it in the same commit

## Plans and Specs

Plans under `docs/superpowers/plans/` and specs under `docs/superpowers/specs/` are kept in the tree only while active — i.e. not yet implemented and not cancelled. Once a plan/spec has been fully implemented OR cancelled, delete the file. History lives in git; these directories hold only work in progress.
