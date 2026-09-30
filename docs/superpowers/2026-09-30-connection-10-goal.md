# connection 10.0.0 — goal and path

**Status:** goal approved (#66); design agreed in discussion 2026-09-30. The
spec and then the plan come next, in this PR. This file is the anchor: it says
what they are for, and what neither may trade away.

**Three documents, one direction.** This goal, then the spec, then the plan.
The spec and the plan answer to this file, never to the code as it happens to
be. When writing either, the easy move is to describe what exists and call it
the design; that is how the reason for the whole change gets lost. If the
spec or the plan needs to depart from anything under *Holds throughout*, this
file changes first — explicitly, in review — and only then the spec.

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

## Holds throughout

The spec, the plan and the code are checked against these; none is traded for
a smaller diff.

1. **The process never asks what it was given.** No branch on `kind`, no
   `instanceof`, no narrowing of the provider. `kind` is for logs.
2. **The credential comes only from the provider.** `config` says where the
   system is (host, system number, client, language), never who logs on:
   nothing in `src/` reads `username` / `password` to authenticate.
3. **The provider's words reach the caller.** A refusal ends in the
   provider's `reason` / `hint`; the wire's error travels beside it as the
   cause, never instead of it.
4. **The wire offers, the provider writes, the lifecycle decides.** The wire
   owns its session (CSRF, cookies, affinity, conversations) and says only
   *that* a logon failed; the provider fills the targets; the lifecycle owns
   the policy — when to ask `rejected()`, and the one more attempt after Ok.
5. **One more attempt, never a loop.** After Ok from `rejected()`, exactly
   one further attempt; a second refusal is the verdict.
6. **No runtime dependency on `@mcp-abap-adt/auth-providers`.** The
   connection speaks the contract; the consumer brings the provider.
7. **Success is measured, not inferred** — the live checks under *Success*,
   on real systems.

**Stays:** the three axes — which system (the connector), which credential
(the provider), which wire (the transport) — all stated by the caller, none
inferred; the lifecycle's ownership of connect/disconnect, epochs, critical
sections and stale-request fencing; the wire's ownership of CSRF, cookies and
affinity.

## Decided in the design discussion (2026-09-30)

The spec details these; they answer the questions this file left open.

1. **Which refusal is the credential's.** The wire's own session recovery
   runs first, unchanged (a stale CSRF token on a mutation, a GET retried with
   the cookies that arrived). Only a 401 that survives it goes to
   `rejected({ at: 'request', status: 401 })`. A 403 never does.
2. **The session after a renewal.** Ok → `authorize()` again and one resend
   on the same session: locks and stateful sessions survive a renewal.
3. **A logon refusal.** HTTP: a 401 while establishing the session. RFC: any
   failure to open a conversation — the SDK reports SNC and network failures
   with the same key, and auth-providers 5.0.1 tells them apart. The wire
   marks it (`WireLogonError`, the raw error as its cause); the lifecycle asks
   `rejected({ at: 'logon', error })`, then one more logon or the verdict.
   Outward: `AuthRefusedError { refusal, at, cause }`.
4. **TLS material and the agent.** The HTTP wire builds its client lazily,
   from the material the logon offered, and rebuilds it when a later logon
   offers different material. The constructor's `agentOptions` stay for
   agent settings that are not the credential.
5. **Tests.** A recording stub provider in this repo for the lifecycle; one
   contract suite over the real providers of `@mcp-abap-adt/auth-providers`
   (a dev dependency) on every wire.

Also agreed: `prepare()` then `establish()` before the wire is opened;
`authorize()` before every attempt, the CSRF fetch, cloud preflight and
logoff included; `IAdtSessionContext.authHeaders` gives way to
`authorize(target)` / `logon(target)`; RFC calls `logon` on every
conversation it opens, the per-call ones included; a provider that writes no
logon parameters (a bearer token) cannot log on over RFC, and says so.

## Path

1. ~~`interfaces-auth` 3.0.0, `interfaces-auth-sap` 1.1.0~~ — released
   2026-09-29 (interfaces #111).
2. ~~`@mcp-abap-adt/auth-providers` 5.0.0~~ — released 2026-09-29
   (auth-providers #55, #57).
3. **This package, 10.0.0** — in this PR (#66): goal (approved) → spec →
   review → plan → review → implementation → external review → merge →
   release 10.0.0. ← now
4. `@mcp-abap-adt/auth-broker` 4.0.0 — `getProvider(destination)`: a provider
   already paired with the stores, SNC from `IConnectionConfig`'s
   `sncPartnerName`, `sncQop`, `sncLib`, `sncMyName`. Independent of step 3.
5. `mcp-abap-adt` — the provider from the broker into the connector; the
   per-auth-type construction and the broker 2.x call removed. Live check:
   basic over HTTP and RFC, a token destination, SNC over RFC — one code path.

Each step is its own PR in its own repository, merged and released before the
next that depends on it.
