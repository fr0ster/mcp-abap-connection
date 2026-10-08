# Migration to 13.0

13.0.0 moves the connection from interfaces-auth 6 to **7**, with
`@mcp-abap-adt/auth-errors` 2, and is the release that works with
`@mcp-abap-adt/auth-providers` **6.0.0**. The connection's own behaviour does not
change: the lifecycle, the one credential retry, the refusals it mints and
`WireLogonError` are as in 12.x. 12.0.0 was only on the `next` dist-tag, so for
most consumers this is the step from 11.x with the 12 migration included; read
[Migration to 12.0.0](./MIGRATION-12.0.md) too.

## Dependencies

| Package | 12.0 | 13.0 |
|---|---|---|
| `@mcp-abap-adt/interfaces-auth` | `^6.0.0` | `^7.5.0` |
| `@mcp-abap-adt/interfaces-auth-sap` | `^3.2.0` | `^3.3.0` |
| `@mcp-abap-adt/auth-errors` | `^1.0.0` | `^2.1.1` |
| `@mcp-abap-adt/auth-providers` (yours, not a dependency) | none fits | `^6.0.0` |

A process should hold **one** interfaces-auth major and one auth-errors copy
(`npm ls @mcp-abap-adt/interfaces-auth @mcp-abap-adt/auth-errors`; each should
appear once, the rest `deduped`). Providers must speak interfaces-auth 7 as well.

## The providers: auth-providers 6.0.0

connection 13.0.0 is tested with `@mcp-abap-adt/auth-providers` 6.0.0, built on
interfaces-auth 7.5 and auth-errors 2.1. Install it beside the connection:

```bash
npm install @mcp-abap-adt/connection@^13 @mcp-abap-adt/auth-providers@^6
```

- auth-providers 5.x does not fit: its refusals are unbranded `{ reason, hint }`,
  not an `AuthOutcome` of interfaces-auth 7. No auth-providers release fits
  connection 12.x (6.0.0 is on interfaces-auth 7, 5.x on 3), so move to 13.0.0
  and 6.0.0 together.
- The credentials the connection docs use keep their constructors:
  `new BasicAuthProvider(user, password)`, `TokenAuthProvider.fixed(token)` /
  `.from(refresher)`, `new SamlAuthProvider(cookies)`,
  `new CertificateAuthProvider(loader, config)` / `.fromFiles(config)`,
  `new SncLogonProvider({ … })`.
- `CertificateAuthProvider` proves its material usable in `prepare()`, so a
  certificate it cannot use is refused at `connect()` (`AuthRefusedError` at
  `prepare`), before any logon.
- A token provider (`ClientCredentialsProvider`, `AuthorizationCodeProvider`,
  the OIDC and SAML providers, …) now needs `renewal` — `refreshThenLogin()`
  or `refreshOnly()` — and takes `persistence` in place of `onTokens`; an
  interactive one is handed an `IBrowser`. Each is an `IAuthProvider` itself
  and goes to a connector unwrapped. See auth-providers' README, *Migrating to
  6.0.0*.

## What interfaces-auth 7 changes

- New error kind `renewal-declined`; a consumer that switches on `kind`
  exhaustively must handle it.
- New configuration case `invalid-value`; new operation `renewal-strategy`.
- The operation `on-tokens-hook` is now `persisting-tokens`.
- The interactive outcome `browser-launch-failed` is gone.
- `ITokenResult.refreshTokenDisposition` and `RefreshTokenDisposition` are gone.

7.1–7.5 add only new types (`IBrowser`, the authorization parts) and new
members of code lists (`CONFIG_FIELDS`, `OPERATIONS`,
`INTERACTIVE_LOGIN_STRATEGIES`).

The connection reads none of these, so nothing in its API changes. A consumer
that does must update its own code.
