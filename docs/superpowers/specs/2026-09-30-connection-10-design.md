# connection 10.0.0 — the process on the `IAuthProvider` contract (design)

**Answers to:** `docs/superpowers/2026-09-30-connection-10-goal.md`. Every
section below names the goal's *Holds throughout* rules it serves (H1–H7); a
section that cannot is a change to the goal first, not to this file.

**Status:** draft for review in #66.

## 1. The contract being implemented

From `@mcp-abap-adt/interfaces-auth` 3.0.0:

```ts
interface IAuthProvider {
  readonly kind: string;                                     // logs only (H1)
  prepare(): Promise<AuthOutcome>;                           // once per connect
  establish(logon: ILogonTarget): Promise<AuthOutcome>;      // every logon
  authorize(request: IRequestTarget): Promise<AuthOutcome>;  // every request attempt
  rejected(rejection: IAuthRejection): Promise<AuthOutcome>; // the system said no
}
type AuthOutcome = { ok: true } | { ok: false; refusal: { reason: string; hint?: string } };
interface IAuthRejection { at: 'logon' | 'request'; status?: number; error: unknown }
interface ILogonTarget {
  tlsMaterial(material: ICertificateMaterial): AuthOutcome;
  logonParameters(parameters: Readonly<Record<string, string>>): AuthOutcome;
}
interface IRequestTarget { header(name: string, value: string): void; cookies(value: string): void }
```

A provider never throws across it; the connection still guards every call (a
consumer's provider may be buggy) and treats a throw as Oops with the fixed
reason "the credential provider failed" and the throw as the cause.

## 2. Errors the connection raises

Two exported classes, `src/connection/authErrors.ts`:

```ts
/** The credential said no, or the system refused it and the provider's answer is final. */
class AuthRefusedError extends Error {
  readonly refusal: IAuthRefusal;             // the provider's words (H3)
  readonly at: 'prepare' | 'logon' | 'request';
  readonly cause?: unknown;                   // the wire's error, as it arrived
  // message: `${refusal.reason}` + (hint ? ` — ${refusal.hint}` : '')
}

/** A wire's mark: this failure is a refused logon. It decides nothing (H4). */
class WireLogonError extends Error {
  readonly status?: number;                   // HTTP, when there is one
  readonly cause: unknown;                    // the raw error — never re-wrapped
}
```

`WireLogonError` is exported because a consumer's own wire must be able to
say the same thing. `AuthRefusedError` is what a caller catches; `refusal`
is the provider's, `cause` keeps the network failure visible even when a
provider words it as a credential problem.

**After Ok, refused again** (H5): the second refusal is the verdict, and the
provider is not asked again — asking would invite a second renewal. The
caller gets `AuthRefusedError` with the fixed refusal
`{ reason: 'the credential was refused again after the provider renewed it' }`,
`cause` the second wire error. This is the one refusal the connection words
itself, because the provider's last word was Ok.

## 3. The lifecycle (`AbstractAbapConnection`, `CredentialAbapConnection`)

### 3.1 Connect

```
connect()
  1. provider.prepare()                  Oops → AuthRefusedError(at 'prepare'); nothing was sent
  2. transport.open(context)             the wire logs on inside, through context.logon (§4)
  3. session establishment               HTTP: the CSRF fetch; RFC: nothing to do
     └ a WireLogonError from 2 or 3 →  provider.rejected({ at: 'logon', status?, error: cause })
                                          Ok   → transport.close, then 2–3 once more
                                          Oops → AuthRefusedError(at 'logon', cause)
                                          refused again → AuthRefusedError (§2, after Ok)
```

`prepare()` runs before the wire is opened — today `transport.open()` comes
first. The existing epochs, teardown and "disconnect() always settles" are
untouched; a failed connect still closes the wire and marks the connection
disconnected.

### 3.2 The session context the wire receives

`IAdtSessionContext.authHeaders` is removed. In its place:

```ts
interface IAdtSessionContext {
  baseUrl: string;
  /** Fill the credential into a request the wire itself originates (CSRF fetch, preflight, logoff). */
  authorize(headers: Record<string, string>): Promise<void>;
  /** Called by the wire at each of its logons. */
  logon(target: ILogonTarget): Promise<void>;
  extraHeaders?: Record<string, string>;
  observe: (headers: unknown) => void;
}
```

- `authorize(headers)` builds the request target over `headers` (§3.4),
  calls `provider.authorize`, and on Oops throws `AuthRefusedError(at
  'request')` — the request is not sent.
- `logon(target)` calls `provider.establish(target)`; on Oops throws
  `AuthRefusedError(at 'logon')`. An Oops from `establish` is the provider's
  verdict on this logon (e.g. SNC with no library, a certificate the wire
  cannot take) and does **not** go to `rejected()` — nothing was refused by
  the system.

### 3.3 A request

```
makeAdtRequest → performRequest
  headers = base headers (client, accept, …)
  authorize(headers)                          per attempt (H4)
  send
  on error:
    stale lease / session lost / network     unchanged
    (a) CSRF / login-form 401 on a mutation  unchanged — but authorize(headers) again before its resend
    (b) 401 on a GET, cookies available      unchanged — but authorize(headers) again before its resend
    WireLogonError (RFC per-call conversation) ┐
    a 401 that survived (a) and (b)            ┴→ provider.rejected({ at, status?, error })
         at = 'logon' for WireLogonError, 'request' for a 401
         Ok   → authorize(headers) again, ONE resend on the same session (H5)
         Oops → AuthRefusedError(at, cause)
         refused again → AuthRefusedError (§2, after Ok)
    403 and every other status               thrown unchanged — never to rejected()
```

- **Order.** The wire's session recovery runs first because it cures
  session faults, not credential faults; a stale CSRF token under Basic must
  not become "the user or password was refused".
- **Every resend is re-authorized.** Today (a) and (b) resend with the
  `Authorization` read once before the first attempt.
- **Concurrency.** Many requests meeting the same expired token each call
  `rejected()`; the connection adds no single-flight of its own. Providers
  that renew share one renewal in flight (auth-providers `BaseTokenProvider`,
  `TokenAuthProvider.from` through its refresher), and a provider whose
  presented token is already superseded answers Ok without renewing.
- **Critical sections.** The resend runs under the same lease and generation
  as the attempt it repeats; stale-request fencing applies to it unchanged.

### 3.4 The request target

One implementation for every wire, `src/connection/requestTarget.ts`:

```ts
function requestTargetOn(headers: Record<string, string>): IRequestTarget
  header(name, value)  → headers[name] = value
  cookies(value)       → headers.Cookie = mergeCookieHeaders(headers.Cookie, value)
```

The wires already carry request headers where they go: HTTP merges `Cookie`
with its jar in `dress()`; RFC forwards every header as a
`SADT_REST_RFC_ENDPOINT` header field. No wire needs its own request target.

## 4. The wires

### 4.1 HTTP (`HttpTransport`, `OnPremHttpTransport`, `CloudHttpTransport`, `LegacyOnPremHttpTransport`)

- **Logon.** `open(context)` calls `context.logon(target)` first, before any
  request — the cloud preflight included. The target:
  - `tlsMaterial(m)` → Ok; stored. The axios client (and its `https.Agent`)
    is built lazily on the first request from
    `{ rejectUnauthorized, ...agentOptions(), ...material }`. A later logon
    offering material that differs (`cert`, `key`, `pfx`, `passphrase`,
    compared by value) drops the client; the next request builds a new one.
    The cookie jar and CSRF token are the session's and stay.
  - `logonParameters(…)` → Oops `{ reason: 'this wire takes no logon parameters (HTTP)' }`.
    Basic goes on with its header; certificate and SNC return it as theirs.
- **Constructor.** `agentOptions: () => AgentOptions` stays, for agent
  settings that are not the credential (`ca`, `rejectUnauthorized`).
- **Establishment.** A 401 while establishing the session is thrown as
  `WireLogonError { status: 401, cause }` at once — not retried by the
  establishment's own retry loop, which keeps retrying everything else as
  today.
- `CloudHttpTransport.open` (preflight) and `close`, and
  `OnPremHttpTransport.close` (logoff), fill their headers with
  `context.authorize(headers)` instead of `authHeaders()`.

### 4.2 RFC (`RfcTransport`, `rfcConversation.ts`)

- **Logon, on every conversation it opens** — the session's own and each
  per-call one in `openOwn()`. The target:
  - `logonParameters(p)` → Ok; `p` goes into this open's parameters.
  - `tlsMaterial(…)` → Oops `{ reason: 'this wire carries no TLS material (RFC)' }`.
- **Opening.** `new Client({ ...address, ...logon })`. A failure of the open
  is thrown as `WireLogonError { cause: <the raw sap-rfc-lite error> }` —
  no `'Failed to open RFC connection: …'` wrapping, so a provider can read
  the SDK's `key` and message (auth-providers 5.0.1 tells SNC from network
  failures this way).
- **The factory.** `RfcTransport` takes
  `(logon: Readonly<Record<string, string>>) => IRfcConversation`.
  `rfcConversationFrom(config)` returns such a factory.
- **`rfcParamsFrom(config)`** returns the address only — `ashost`, `sysnr`,
  `client` (default `'000'`), `lang` (`'EN'`) — and no longer requires or
  reads `username` / `password` (H2). `RfcConnectionParams` loses `user` /
  `passwd`.
- A provider that writes no logon parameters (a bearer token) cannot log on
  over RFC: the open fails, the provider is asked, and the caller gets its
  refusal. The goal's success criterion is "every wire that can carry that
  provider"; RFC cannot carry a bearer token.

## 5. What leaves the package

| Removed | Where it is now / why |
|---|---|
| `BasicAuthProvider`, `TokenAuthProvider`, `SamlAuthProvider`, `CertificateAuthProvider` (`src/auth/providers.ts`) | `@mcp-abap-adt/auth-providers` ≥ 5.0.1 |
| `FileCertificateMaterialLoader` | `@mcp-abap-adt/auth-providers` |
| `IAdtSessionContext.authHeaders` | `authorize(headers)` / `logon(target)` (§3.2) |
| `CredentialAbapConnection.getHttpsAgentOptions`, `buildAuthorizationHeader`, `isUnauthorized` | nothing reads them |
| `AbstractAbapConnection.recoverSession`, `discardSession` | no callers |
| `src/utils/tokenRefresh.ts`, `src/auth/ntlm.ts` (+ its test) | not imported, not exported |
| the comment placing renewal "a layer above, in CredentialAbapConnection" | describes a wrapper that does not exist |

`IAuthProvider` is still not re-exported: the consumer imports the contract
from `@mcp-abap-adt/interfaces-auth` and providers from wherever they come.

**Dependencies.** `@mcp-abap-adt/interfaces-auth` ^3.0.0,
`@mcp-abap-adt/interfaces-auth-sap` ^1.1.0 (it stays: `src/config/sapConfig.ts`
takes `SapConfig` from it). `@mcp-abap-adt/auth-providers` ^5.0.1 as a
**dev** dependency only (H6).

## 6. Tests

**Unit — the lifecycle, with a recording stub provider** (`src/__tests__/helpers/stubProvider.ts`: every call recorded, each answer scripted):

- connect calls `prepare` → `establish` → the establishing request, in that
  order; an Oops from `prepare` sends nothing;
- `authorize` runs before every attempt — request, CSRF fetch, preflight,
  logoff, each resend — and a header it writes on the resend is the one sent;
- a stale-CSRF 401 on a mutation is cured by the wire and never reaches
  `rejected`; a 401 that survives reaches it once; Ok → exactly one resend;
  Oops → `AuthRefusedError` with the provider's refusal and the 401 as cause;
- refused again after Ok → the fixed refusal, `rejected` called once;
- 403 → thrown unchanged, `rejected` never called;
- `WireLogonError` in connect and in an RFC per-call open → `rejected({ at:
  'logon', error })` with the **raw** error; Ok → one more logon;
- an `establish` Oops → `AuthRefusedError(at 'logon')`, `rejected` not called;
- a provider that throws → Oops "the credential provider failed", throw as cause.

**Wires:** HTTP builds the agent from the offered TLS material and rebuilds
on a change, keeps the jar; refuses logon parameters. RFC passes logon
parameters into the open, refuses TLS, throws the raw error in
`WireLogonError`; `rfcParamsFrom` works without `username` / `password`.

**Contract over real providers** (`src/__tests__/realProviders.test.ts`,
auth-providers as a dev dependency): Basic, `TokenAuthProvider`,
Certificate, SNC (with its fake system) — each connects on the HTTP and the
RFC stub wires it can travel on, and a refused one ends in its own words.
Nothing in the test branches on which provider it is (H1).

**Load-bearing:** each rule above is broken once on purpose and its test
must go red, then restored.

## 7. Live checks (H7)

| Check | System |
|---|---|
| `BasicAuthProvider` over HTTP and over RFC; a wrong password refused in the provider's words | E19 (on-prem) |
| `SncLogonProvider.forSecureLoginClient` over RFC; logged-out client → `A2200019` explained | E19, Windows with Secure Login Client |
| a token provider over HTTP | BTP trial (ABAP environment) |

## 8. Documentation and release

- `docs/MIGRATION-10.0.md`: providers from `@mcp-abap-adt/auth-providers`;
  `rfcConversationFrom` / `RfcTransport` factory signature; a custom wire's
  `authorize` / `logon` / `WireLogonError`; catching `AuthRefusedError`.
- README, `docs/USAGE.md` (and the section claiming concurrent requests share
  one renewal — it becomes the truth of §3.3), `INDEX.md`, `INSTALLATION.md`,
  `SCOPE.md`, `JWT_AUTH_TOOLS.md`, `STATEFUL_SESSION_GUIDE.md`, `CLAUDE.md`;
  `examples/` and `scripts/` import providers from auth-providers.
- `10.0.0`, CHANGELOG; the goal, this spec and the plan are deleted before
  the release.

## 9. Out of scope

- `@mcp-abap-adt/auth-broker` 4.0.0 and the server (steps 4 and 5).
- Kerberos / SPNego (`docs/kerberos-spnego-spec`, another line of work).
- Anything in auth-providers beyond 5.0.1.

## 10. Check against the goal

| Rule | Where |
|---|---|
| H1 never asks what it was given | §1, §3 (no kind branch), §6 real-provider suite |
| H2 credential only from the provider | §4.2 `rfcParamsFrom`, §5 |
| H3 the provider's words reach the caller | §2, §3.3 |
| H4 wire offers, provider writes, lifecycle decides | §3.2, §3.4, §4 (`WireLogonError` decides nothing) |
| H5 one more attempt, never a loop | §2 after Ok, §3.1, §3.3 |
| H6 no runtime dependency on auth-providers | §5 |
| H7 measured | §7 |
