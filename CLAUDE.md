# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # Clean + biome lint (error-level) + tsc compile
npm run build:fast     # tsc only (skip clean and lint, for rapid iteration)
npm run lint           # Biome auto-fix (src and scripts)
npm run lint:check     # Biome read-only check (src and scripts)
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
   (lifecycle only,      │      ICF session       BasicAuthProvider    HttpTransport
    NOT exported)        └── AdtCloudConnector    TokenAuthProvider    RfcTransport
                                security session  SamlAuthProvider
                                                  CertificateAuthProvider
```

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
- `IAuthProvider` (from `@mcp-abap-adt/interfaces`) — the credential, including
  its own renewal. A provider checks expiry and refreshes when asked for a
  header; the connection does not renew on its behalf.
- The connector — which session mechanism this system uses, and nothing else.

**If you find yourself checking the transport's kind in the base, that is the
smell.** There is no `if (transport is rfc)` anywhere, and adding one means the
fact belongs on the transport instead.

**Key design decisions:**
- All external deps accessed through interfaces from `@mcp-abap-adt/interfaces` — no direct coupling
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
  is a synchronous call with nothing to cancel

**Taking the RFC wire** needs the SAP NW RFC SDK on the machine and
`@mcp-abap-adt/sap-rfc-lite` installed; `rfcConversationFrom(config)` derives
`ashost`/`sysnr` and loads the SDK lazily, so a machine without it fails at
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
