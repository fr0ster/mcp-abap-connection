# Passwordless login with Kerberos: SNC over RFC

**Status:** draft for review. Not approved; no plan yet. Decisions still open
are listed under [Decisions](#decisions).
**Repositories touched:** `mcp-abap-connection` (this one),
`mcp-abap-adt-interfaces` (`interfaces-auth-sap`, possibly `interfaces-auth`),
`mcp-abap-adt` (the server), possibly `sap-rfc-lite`.
**Background research:**
[auth-providers `docs/passwordless-sso.md`](https://github.com/fr0ster/mcp-abap-adt-auth-providers/blob/master/docs/passwordless-sso.md)
— what SAP GUI's passwordless login is, how Eclipse ADT does it, the HTTP
equivalents, with sources.

## Goal

`mcp-abap-adt` logs on to an on-premise ABAP system **without a password**, on
a machine where SAP GUI already does — a Windows domain logon, the SAP Secure
Login Client with a **Kerberos** profile, SNC switched on for the system in SAP
Logon.

Success: with no `SAP_USERNAME`/`SAP_PASSWORD` configured, the server connects
and `/sap/bc/adt/discovery` answers, as the domain user.

Out of scope: X.509 certificates from the Secure Login Server (mTLS already
exists as `CertificateAuthProvider`, for file-based material), BTP and S/4HANA
Cloud (browser OAuth through IAS already covers them), NTLM.

## What exists today

| Where | What | Reference |
|---|---|---|
| server config | `SAP_AUTH_TYPE=kerberos`, `SAP_KERBEROS_SPN`, `SAP_KERBEROS_SERVICE` are parsed | `mcp-abap-adt/src/lib/config/parseAuthType.ts`, `applyAuthFields.ts` |
| contract | `SapAuthType` includes `'kerberos'`; `ISapConfig` has `kerberosSpn`, `kerberosService` | `interfaces-auth-sap/src/sap/SapAuthType.ts`, `ISapConfig.ts:21-23` |
| server | `kerberos` is refused on purpose: `refuseKerberos()` | `mcp-abap-adt/src/lib/connectionFactory.ts:61` |
| this package | `KerberosAbapConnection` removed in 6.0 — single-leg, untested against a KDC ([#35](https://github.com/fr0ster/mcp-abap-adt-connection/issues/35)); "a `KerberosAuthProvider` belongs on the credential axis … with a system to test it against" | `docs/MIGRATION-6.0.md#kerberos` |
| this package | `IAuthProvider.authorizationHeader()` is asked per request and may return any scheme | `src/connection/CredentialAbapConnection.ts:75-90` |
| this package | `isNtlmChallenge()` detects NTLM, used by nothing | `src/auth/ntlm.ts` |
| this package | `RfcTransport` carries ADT over RFC (`SADT_REST_RFC_ENDPOINT`) through `@mcp-abap-adt/sap-rfc-lite`, an optional peer | `src/connection/RfcTransport.ts`, `rfcConversation.ts` |
| this package | `rfcParamsFrom()` requires `username` and `password`; no SNC parameters | `src/connection/rfcConversation.ts:37-57` |
| NW RFC SDK | client logon supports `SNC_QOP`, `SNC_MYNAME`, `SNC_PARTNERNAME`, `SNC_LIB` "for Kerberos/x509 over RFC" | `docs/SCOPE.md:31` |

## Two routes

A Kerberos ticket reaches an ABAP system in one of two ways. They share the
ticket and nothing else.

### Route A — SNC over RFC (the route to build)

Exactly what SAP GUI and Eclipse ADT do on-premise: the RFC logon is
authenticated by SNC, with the Secure Login Client's GSS library doing
Kerberos. ADT's REST requests already travel over RFC in this package.

- **Server side:** nothing new. If SAP GUI logs on with SNC, the system has
  SNC, the SSO licence and the user's SNC name mapped (`SU01` → SNC).
- **Client side:** the NW RFC SDK (already needed by `RfcTransport`) and the
  Secure Login Client's GSS library, already installed.
- **Change:** `rfcParamsFrom()` builds SNC logon parameters instead of
  `user`/`passwd` when SNC is configured:

  | RFC parameter | Value | From |
  |---|---|---|
  | `snc_mode` | `1` | SNC configured |
  | `snc_partnername` | the system's SNC name, e.g. `p:CN=SID, O=…` or `p:SAPServiceSID@DOMAIN` | new config field; SAP Logon → connection → *Network* shows it |
  | `snc_lib` | path to the GSS library, e.g. the Secure Login Client's `sapcrypto` library | new config field; default by platform is an open question |
  | `snc_qop` | `1`–`9`, default `8` (maximum available) | new config field, optional |
  | `snc_myname` | the user's SNC name | optional; the library takes it from the ticket when absent |

  No `user`/`passwd`. Everything else — `ashost`, `sysnr`, `client`, `lang` —
  unchanged.
- **Credential:** the RFC logon authenticates, so the connector's credential
  contributes nothing: a credential whose `authorizationHeader()` and
  `cookies()` return `null` (see [Decisions](#decisions) 1 for its name and
  whether it is a new `authType`).
- **Why this route:** the target setup is SNC — the user's SSO instructions
  install the Secure Login Client and switch SNC on in SAP GUI; they do not
  configure SPNego. Route A works wherever SAP GUI already works, with no
  request to the system's administrators, and is testable on the user's
  machine today.

Checked:
- `sap-rfc-lite` passes every key of the params object to `RfcOpenConnection`
  unchanged: `getConnectionParams()` (`sap-rfc-lite/src/cpp/nwrfcsdk.cc:908-926`)
  copies each property name and value into `RFC_CONNECTION_PARAMETER[]`, with
  no filter. What needs changing is this package's `RfcConnectionParams`
  interface (`src/connection/rfcConversation.ts:20`), whose `user` and
  `passwd` are required and which has no `snc_*` fields.

Unverified, to check before the plan:
- Which library file the Secure Login Client installs for SNC, per platform,
  and whether the NW RFC SDK loads it (SAP GUI does; the SDK is a separate
  process with its own `SNC_LIB`).

### Route B — SPNego over HTTP (deferred)

Not built now: the target setup does not configure SPNego (see route A).
Recorded so that, if administrators enable it for ICF later, the design does
not have to be rediscovered.

The HTTP equivalent: `Authorization: Negotiate <token>`, a Kerberos service
ticket for `HTTP/<host>` wrapped in SPNego (RFC 4559).

- **Server side: administrator work.** SPNego must be enabled for ICF —
  `spnego/enable`, `spnego/krbspnego`, a keytab in transaction `SPNEGO`, an
  `HTTP/<fqdn>` service principal in Active Directory, principal mapping in
  `SU01`. SNC being on for SAP GUI does **not** imply this. Check first: open
  `https://<host>/sap/bc/adt/discovery` in Edge or Chrome on the domain
  machine — if it answers without a password prompt, SPNego is on.
- **Client side:** the `kerberos` npm package (GSSAPI on Unix, SSPI on
  Windows — the Windows domain logon, no `kinit`).
- **Change:** a `KerberosAuthProvider implements IAuthProvider` here:
  - `authorizationHeader()` returns `Negotiate <token>`, **a fresh token per
    call**: a Kerberos authenticator carries a timestamp and the server keeps a
    replay cache, so a token cannot be resent.
  - `prepare()` loads the token source and mints one token, so a missing
    ticket fails `connect()` with a clear message instead of the silent
    preflight fallback #35 describes.
  - The token comes from a **strategy** — `INegotiateTokenSource`,
    `token(spn): Promise<string>` — with a default built on `kerberos`,
    loaded by `require` at `prepare()` as an optional peer, the way
    `sap-rfc-lite` is. Tests replace it; so can a consumer.
  - The SPN is `kerberosSpn`, or `${kerberosService ?? 'HTTP'}@${host of url}`.
  - A token that is NTLM (base64 prefix `TlRMTVNTUAA`) is refused: SSPI falls
    back to NTLM when it cannot find the SPN, and NTLM is multi-leg.
  - Refused for a cloud system: BTP and S/4HANA Cloud do not take SPNego.
- **Known limit — single leg.** `IAuthProvider` never sees a response, so a
  server continuation (`401` with `WWW-Authenticate: Negotiate <token>`) cannot
  be answered. With Kerberos a single leg is normal; if a system continues,
  the transport must surface it as a refusal naming the reason, not a bare 401.
  Mutual authentication (the server's final token) is not verified.

## Server changes (`mcp-abap-adt`)

- `onPremCredential()`:
  - `kerberos` + `connectionType: 'rfc'` → the SNC credential of route A;
  - `kerberos` over HTTP → still refused, with a message saying Kerberos
    works over RFC (`SAP_CONNECTION_TYPE=rfc` with the SNC fields) and that
    SPNego over HTTP is not implemented.
- `createAbapConnection()` for RFC passes the SNC fields through
  `rfcConversationFrom(config)` unchanged.
- Config: new env vars for route A — `SAP_SNC_PARTNERNAME`, `SAP_SNC_LIB`,
  `SAP_SNC_QOP`, `SAP_SNC_MYNAME` — parsed beside the Kerberos ones.
- `connectionAuthRouting.test.ts`: the "kerberos → refused" case becomes the
  two routings above.
- README: a "Passwordless login (Kerberos over SNC)" section: prerequisites
  (NW RFC SDK, Secure Login Client, SNC in SAP Logon), where to find the SNC
  name and library, the env vars.

## Contract changes (`interfaces-auth-sap`)

Types only, additive, a minor: `ISapConfig` gains `sncPartnerName?`,
`sncLib?`, `sncQop?`, `sncMyName?`. If `INegotiateTokenSource` goes to a
contract package, it is `interfaces-auth`, also a minor ([Decisions](#decisions) 2).

## Testing

| What | How | Where |
|---|---|---|
| SNC parameters | `rfcParamsFrom()` unit tests: SNC config → SNC keys, no `user`/`passwd`; partial SNC config refused naming the missing field | this package, CI |
| SNC end to end | on the user's domain machine: `SAP_AUTH_TYPE=kerberos`, `SAP_CONNECTION_TYPE=rfc`, SNC fields set, no password → discovery answers | live, manual, results recorded in the PR |
| `KerberosAuthProvider` (route B, deferred) | unit tests with a fake `INegotiateTokenSource`: fresh token per call, NTLM refused, SPN derivation, `prepare()` failure message, cloud refused | this package, CI |
| SPNego wire contract (route B, deferred) | a stand in Docker: MIT krb5 KDC, a small HTTPS server requiring `Negotiate` (validated with a keytab), a client container with `kinit` → the default token source against it | this package, CI job — answers #35's "untested against a KDC" |
| SPNego against ABAP (route B, deferred) | on the domain machine, once the browser check passes | live, manual |
| SNC with the Secure Login Client on Windows | only live — no Windows domain in CI | live, manual |

Each rule gets a test that goes red when the rule is removed: no `user` or
`passwd` sent when SNC is configured; a partial SNC configuration refused;
Kerberos over HTTP still refused with its message.

## Order

1. On the domain machine: find the SNC library the Secure Login Client
   installed and the system's SNC name in SAP Logon.
2. Route A: contract fields → `RfcConnectionParams` and `rfcParamsFrom()` →
   server routing → live check.
3. Route B only if SPNego is ever enabled for ICF (the browser check), with its
   KDC stand.

One PR per repository per step, each merged before the next opens.

## Decisions

1. **Auth type for route A.** Reuse `kerberos` and pick the route by
   `connectionType` (`rfc` → SNC, `http` → SPNego), or add `snc` to
   `SapAuthType`. Reuse is smaller; `snc` is more honest, since SNC can also
   carry X.509. *Recommendation: reuse `kerberos` now; `snc` when X.509 over
   SNC is wanted.*
2. **Where `INegotiateTokenSource` lives.** In `interfaces-auth`, by the
   interface-only rule, or local to this package as the certificate loader's
   shape suggests. *Recommendation: `interfaces-auth`, since a consumer is
   meant to replace it.*
3. **Default `snc_lib`.** Require it, or default to the Secure Login Client's
   install path per platform. *Recommendation: require it until the paths are
   verified.*
4. **Route B at all.** Deferred: the target setup is SNC only. Revisit if a
   target system enables SPNego for ICF.

## Open questions

1. ~~Does `sap-rfc-lite` pass `snc_*` keys to `RfcOpenConnection`?~~ Yes —
   see route A, *Checked*.
2. Which library does the Secure Login Client install for SNC on Windows and
   macOS, and does the NW RFC SDK load it outside SAP GUI?
3. Route B only: is SPNego enabled on the target system's ICF (the browser
   check), and does the system continue the exchange or accept one token?
4. After an SNC logon, does one RFC conversation carry the whole
   session, as it does with a password today, or does anything in
   `RfcTransport` reopen the connection and need the SNC parameters again?
