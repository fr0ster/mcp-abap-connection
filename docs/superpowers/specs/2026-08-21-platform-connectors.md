# Two connectors, one credential contract

**Status:** draft, for review
**Subject:** `AdtOnPremConnector` / `AdtCloudConnector` over a shared base, with authentication passed in rather than inherited.

## Why

The class you take today states your **credential**, and the session mechanism rides along with it. `JwtAbapConnection` is the only class that overrides `createSessionStrategy()`, so:

| the consumer builds | on a **cloud** host | on an **on-prem** host |
|---|---|---|
| `authType: 'jwt'` | ADT session resource — correct | ADT session resource — wrong |
| `authType: 'basic'` | ICF logoff — wrong | ICF logoff — correct |
| `authType: 'saml'` | ICF logoff — wrong | correct |
| `authType: 'certificate'`, `'kerberos'` | ICF logoff — wrong | correct |

Both wrong rows are reachable. The cloud trial answers `www-authenticate: Basic`, so a communication user against ABAP Cloud is an ordinary setup; SAML is the usual interactive logon on BTP. And the mirror — JWT against an on-prem system — puts that system on a mechanism it does not use.

**The consumer knows which system it is dialling.** It should say so by taking the connector for it, and the credential should be a parameter of that choice rather than the thing making it.

### Why not detect it

Tried, measured, wrong. `/sap/bc/adt/core/http/sessions` was probed to decide the mechanism; **on-prem answers it too** — 200, a `SAP_SESSIONID`, and a document publishing *both* the session resource and `/sap/public/bc/icf/logoff`. The probe never told the two systems apart; it told whether an endpoint exists, and both have it, so on-prem was silently moved onto the cloud mechanism.

Nothing here goes back to asking the server which kind of system it is.

## The shape

```
AbstractAbapConnection            requests, CSRF, cookies, session lifecycle, admission
        │
        ├── AdtOnPremConnector    session arrives with the establishing call;
        │                         given back with the platform's ICF logoff
        │
        └── AdtCloudConnector     session opened at /sap/bc/adt/core/http/sessions
                                  (`x-sap-security-session: create`,
                                   `sap-adt-purpose: preflight_logon`);
                                  given back by DELETE on the address it published
```

Both take a **credential** object. The two session strategies already exist and do not change; what changes is who chooses them and how authentication arrives.

## The credential contract

`ITokenRefresher` and `ITokenProvider` already exist in `@mcp-abap-adt/interfaces` — the first says outright *"Created by AuthBroker for a specific destination. Injected into JwtAbapConnection to enable automatic token refresh."* — and `@mcp-abap-adt/auth-providers` ships twelve implementations. That is the seam to join, not to reinvent.

But both are about **tokens**, and only one of the five ways in works that way. Measured, every current class overrides exactly two members, plus a few extras:

| | `buildAuthorizationHeader` | `establishSession` | other |
|---|---|---|---|
| basic | ✓ | ✓ | — |
| jwt | ✓ | ✓ | `prepareCredential`, `ensureToken` |
| saml | ✓ | ✓ | — |
| certificate | ✓ | ✓ | `getHttpsAgentOptions`, `ensureMaterial` |
| kerberos | ✓ | ✓ | `fetchCsrfToken` |

So the contract is small and is **not** "give me a token":

```ts
interface IAbapCredential {
  /** Prepare before anything is sent — mint, load, unlock. Optional. */
  prepare?(): Promise<void>;
  /** The Authorization header value, or '' when the credential is not a header. */
  authorizationHeader(): string;
  /** TLS material, for credentials that are a certificate rather than a header. */
  httpsAgentOptions?(): AgentOptions;
}
```

A token provider becomes one implementation of it, wrapping `ITokenRefresher`. Basic wraps a username and password. Certificate returns no header and supplies agent options instead.

**Where it lives:** `@mcp-abap-adt/interfaces`, released before the connector consumes it — the standing rule, no local bridge.

## The hard part, named

`JwtAbapConnection` is 483 lines and **most of it is not authentication.** `renewalInFlight`, the `AsyncLocalStorage` operation scopes, `tokenGeneration` against `recoveredGeneration`, `ensureRecovered`, and the calls to `discardSession()` and `recoverSession()` are about what happens to *the session* when the credential is renewed mid-flight. That is connection business and stays in the base.

The split to make:

- **credential**: "get me a valid token" → the provider, behind `IAbapCredential`;
- **connection**: "the credential changed, so the session it built is gone — discard, re-establish, let the request retry once" → the base, unchanged in behaviour.

If this line is drawn wrongly the 4.0.0 work is undone, and that work exists because the failures it fixed were subtle: two layered single-flight promises, identity-checked clears, an epoch checked before a retry. **The spec's success condition is that every test from 4.0.0 passes untouched.**

## Migration

The five current classes stay, deprecated, as thin wrappers: `new JwtAbapConnection(config, logger, sessionId, refresher)` builds `AdtCloudConnector` with a token credential. Nothing published breaks, and `createAbapConnection()` keeps working from `SapConfig` alone.

New code takes a connector and hands it a credential.

## What this does not do

- **No auto-detection**, in any form — see above.
- **No change to the two session strategies.** They were measured against a live trial and an on-prem system and are not the subject here.
- **No new auth mechanism.** Only a place for the ones that exist to be passed in.
- **No dependency on the auth packages.** The connector keeps speaking contracts; consumers supply implementations, as with `IAbapConnection` today.

## Open, to settle in review

1. **`prepare()` and Kerberos.** SPNEGO deliberately does not prepare early: minting the token sooner changes when the exchange happens, and that path is not production-tested. Does Kerberos keep opting out, or does the contract grow a way to say "prepare late"?
2. **What `createAbapConnection(config)` does when the config does not say which system it is.** Defaulting to on-prem keeps every existing consumer working and never guesses; refusing is more honest and breaks them. Deprecation-shaped default seems right, but it is a decision.
3. **Whether `AdtOnPremConnector` should refuse the ADT session resource explicitly** — it exists there and answers, so a future edit could quietly start using it.

## How it gets verified

- Cloud: from this machine, against the BTP trial — connect, hold a session across stateful requests, disconnect. Already the way the current mechanism was measured.
- On-prem: not reachable from here. Reviewed and run on the machine that reaches a system, as PR #34 was: strategy `icf`, `lock → PUT` chains, session present, and **no request to the session resource**.
- Both wrong rows from the table above become tests: a cloud connector with a basic credential must use the ADT session; an on-prem connector with a token credential must not.
