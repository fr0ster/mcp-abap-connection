# connection 10.0.0 — goal and path

**Status:** agreed direction, before the spec. The spec and then the plan come
next, in this PR; this file fixes what they are for.

## Goal

`@mcp-abap-adt/connection` 10.0.0 is **the process** of the `IAuthProvider`
contract released in `@mcp-abap-adt/interfaces-auth` 3.0.0. It takes any
provider as it is — from `@mcp-abap-adt/auth-providers` 5.0.0 or the
consumer's own — and delegates authentication to it through the four moments,
called the same way for every provider:

```
prepare()                      once per connect, before anything is sent
establish(logon target)        every logon: HTTP session establishment, each RFC conversation open
authorize(request target)      before every request attempt, the establishing ones included
rejected(rejection)            a 401 or a refused logon — Ok: renewed, try once more; Oops: the verdict
```

The connection never asks what it was given, never narrows, never branches on
a kind. The provider does all the work of its way in; the wire only offers the
places a credential can go.

**Success:** a connector built with any `IAuthProvider` connects over every
wire that can carry that provider, with no check of what it is — and a
refusal ends in the provider's own `reason` / `hint`, not in a wire error.
Measured live: basic over HTTP and over RFC, a token over HTTP (BTP trial),
SNC over RFC (on-prem, Secure Login Client).

## What changes

- **The wires implement the targets.**
  - `ILogonTarget` — HTTP takes `tlsMaterial(…)` (into the agent) and says no
    to `logonParameters(…)`; RFC takes `logonParameters(…)` (`user`/`passwd`,
    or `snc_mode`/`snc_partnername`/`snc_qop`/`snc_lib`/`snc_myname`) into the
    conversation it opens, and says no to `tlsMaterial(…)`.
  - `IRequestTarget` — `header(…)` and `cookies(…)` on every wire; over RFC
    they travel as `SADT_REST_RFC_ENDPOINT` header fields, as request headers
    already do.
- **The lifecycle calls the four moments** — `prepare()` before the wire is
  opened (today `transport.open()` runs first), `establish()` per logon,
  `authorize()` per attempt including the CSRF fetch, the cloud preflight and
  the logoff, and `rejected()` on a 401 or a refused logon, followed by at most
  one more attempt when it answers Ok.
- **RFC logon takes its credential from the provider.** `rfcParamsFrom(config)`
  stops requiring and reading `username` / `password`; the conversation gets
  them — or SNC — from `establish()`.
- **Its own providers leave.** `BasicAuthProvider`, `TokenAuthProvider`,
  `SamlAuthProvider`, `CertificateAuthProvider` and
  `FileCertificateMaterialLoader` now live in `@mcp-abap-adt/auth-providers`
  5.0.0; this package keeps no implementation of the contract.
- **`interfaces-auth` ^3.0.0, `interfaces-auth-sap` ^1.1.0.**
  `IRenewableCredential` is gone from the contract, and with it every
  renewal path here that nothing calls.
- **What turned out dead goes** — `isUnauthorized()`, `recoverSession()` /
  `discardSession()` with no callers, `src/utils/tokenRefresh.ts`,
  `src/auth/ntlm.ts`, the comment that places renewal in a wrapper that does
  not exist, and `docs/USAGE.md`'s claim that concurrent requests share one
  renewal (nothing implements it).

**Stays:** the three axes — which system (the connector), which credential
(the provider), which wire (the transport) — all stated by the caller, none
inferred; the lifecycle's ownership of connect/disconnect, epochs, critical
sections and stale-request fencing; the wire's ownership of CSRF, cookies and
affinity.

## Open, for the spec

1. **Which refusal is the credential's.** Today a 401 feeds two retry paths
   that fetch a new CSRF token and resend (a login-form 401 on a mutation, a
   401 on a GET), and a 403 without "CSRF" is never classified. Which of them
   become `rejected({ at: 'request', status })`, which stay the wire's session
   recovery, and in what order when both apply.
2. **The session after a renewal.** When `rejected()` answers Ok, is the
   resend made on the same session, or is the session discarded first — per
   wire (cookie session, cloud security session, RFC conversation).
3. **A logon refusal.** RFC wraps a failed open as a bare `Error` with no
   status; an HTTP session establishment treats a 401 as retryable. What
   reaches `rejected({ at: 'logon', error })`, with the wire's error as it
   arrived so the provider can name it (SNC's `A2200019`, a password refused).
4. **TLS material and the agent.** The agent is built once, the material
   arrives in `establish()` per logon. Build the agent from what the first
   logon offered, or rebuild when it changes.
5. **Tests without the old providers.** Recording targets and a stub provider
   inside this repo, or `@mcp-abap-adt/auth-providers` as a dev dependency.

## Path

1. ~~`interfaces-auth` 3.0.0, `interfaces-auth-sap` 1.1.0~~ — released
   2026-09-29 (interfaces #111).
2. ~~`@mcp-abap-adt/auth-providers` 5.0.0~~ — released 2026-09-29
   (auth-providers #55, #57).
3. **This package, 10.0.0** — goal → spec → plan → implementation, in this
   PR. ← now
4. `@mcp-abap-adt/auth-broker` 4.0.0 — `getProvider(destination)`: a provider
   already paired with the stores, SNC from `IConnectionConfig`'s
   `sncPartnerName`, `sncQop`, `sncLib`, `sncMyName`. Independent of step 3.
5. `mcp-abap-adt` — the provider from the broker into the connector; the
   per-auth-type construction and the broker 2.x call removed. Live check:
   basic over HTTP and RFC, a token destination, SNC over RFC — one code path.

Each step is its own PR in its own repository, merged and released before the
next that depends on it.
