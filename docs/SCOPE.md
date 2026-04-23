# Scope and Boundaries

This package is **one component of the `@mcp-abap-adt/*` family**. Each package owns one concern; together they form an SAP ABAP tooling stack. Keeping the boundaries clear is important — several features that look natural to add here actually belong in sibling packages, and some that look missing (like RFC-to-cloud) do not exist anywhere in the ecosystem because the underlying technology does not support them.

## What this package does

- **HTTP transport to SAP ADT** — request dispatch, CSRF token fetch, cookie and session handling, stateful/stateless session control.
- **RFC transport to on-premise SAP** — via `@mcp-abap-adt/sap-rfc-lite` + NW RFC SDK, calling `SADT_REST_RFC_ENDPOINT` (the same FM Eclipse ADT uses on on-prem).
- **Applying credentials** handed to it by the caller (Basic user/password, Bearer JWT, SAML session cookies).

## What this package does NOT do, and where it lives instead

| Concern | Belongs in |
|---|---|
| Token acquisition (SAML/OAuth2 flows, browser login, PKCE) | `@mcp-abap-adt/auth-broker` |
| Token validation, refresh, re-authentication, expiry tracking | consumer via `ITokenProvider` (from `@mcp-abap-adt/interfaces`) |
| Session state persistence across processes | `@mcp-abap-adt/auth-broker` |
| Auth-type constants, provider error codes, auth lifecycle contracts | `@mcp-abap-adt/interfaces` |

The rule: **if it is about *acquiring* or *refreshing* credentials, it is not our job.** We receive credentials that are valid at call time and use them. The consumer is responsible for handing us fresh ones — they know their IdP, their refresh cadence, their re-auth UX.

## Why there is no RFC to SAP BTP / cloud

Short answer: because SAP does not support it that way, and Eclipse ADT does not do it that way either.

**1. Eclipse ADT talks to cloud over HTTP, not RFC.**
The `com.sap.adt.communication.http.*` package is the only transport Eclipse ADT uses for ADT itself. Cloud login in Eclipse goes through `SamlWithReentranceTicketLogonFacade` → `IcfEndpointBasedSystemUrlInfoProvider` → `HttpLowLevelConnection.sendRequest`. This is an HTTP flow via the ABAP ICF (Internet Communication Framework) endpoint, with a browser SAML login minting a short-lived reentrance ticket, which is then exchanged for a `MYSAPSSO2` session cookie over HTTP. There is no RFC anywhere in this path. JCo/RFC calls that appear in Eclipse logs come from unrelated features (GUI integration, JCo destination tests) — not ADT.

**2. NW RFC SDK has no JWT or SAML-2.0-XML logon parameter.**
Inspection of `sapnwrfc.h` and the SDK's reference `sapnwrfc.ini` confirms the supported client logon parameters are: `USER`/`PASSWD`, `X509CERT`, `MYSAPSSO2` (accepts SSO2 tickets and SAP-internal "assertion tickets", *not* SAML 2.0 XML assertions), plus SNC (`SNC_QOP`, `SNC_MYNAME`, `SNC_PARTNERNAME`, `SNC_LIB`) for Kerberos/x509 over RFC. For WebSocket-RFC: `WSHOST`/`WSPORT`, `ALIAS_USER`, `TLS_CLIENT_PSE`, `TLS_CLIENT_CERTIFICATE_LOGON`. No `JWT`, no `BEARER`, no `SAML_ASSERTION`, no `OAUTH` keys exist in the SDK headers.

**3. `@mcp-abap-adt/sap-rfc-lite` is a pure passthrough.**
It forwards every `(name, value)` pair from the JS `Client(params)` object to `RFC_CONNECTION_PARAMETER[]` without filtering. So the wrapper is not a constraint — the constraint is the SDK itself.

**4. For BTP on-prem scenarios (Cloud Connector), the JWT→x509/SNC swap happens server-side in the CC.** The client-side RFC call still carries classic credentials (x509 + SNC), not the JWT. Supporting that would be adding SNC-over-RFC for on-prem backends behind a CC tunnel — an on-prem extension, not a "cloud RFC" feature.

**Conclusion:** "RFC to cloud" is not a missing feature that would be useful to add; it is a category error. ADT to cloud = HTTP (already supported here). RFC to on-prem = supported here via `connectionType: 'rfc'`. Anything claiming a third combination does not map to what the SAP stack actually exposes.

## See also

- [`INSTALLATION.md`](./INSTALLATION.md)
- [`USAGE.md`](./USAGE.md)
- Sibling packages: `@mcp-abap-adt/interfaces`, `@mcp-abap-adt/sap-rfc-lite`, `@mcp-abap-adt/auth-broker`
