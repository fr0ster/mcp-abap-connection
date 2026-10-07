# Migration to 13.0

13.0.0 moves the connection from interfaces-auth 6 to **7**, with
`@mcp-abap-adt/auth-errors` 2.0.0. The connection's own behaviour does not
change: the lifecycle, the one credential retry, the refusals it mints and
`WireLogonError` are as in 12.x. 12.0.0 was only on the `next` dist-tag, so for
most consumers this is the step from 11.x with the 12 migration included; read
[Migration to 12.0.0](./MIGRATION-12.0.md) too.

## Dependencies

| Package | 12.0 | 13.0 |
|---|---|---|
| `@mcp-abap-adt/interfaces-auth` | `^6.0.0` | `^7.0.0` |
| `@mcp-abap-adt/interfaces-auth-sap` | `^3.2.0` | `^3.3.0` |
| `@mcp-abap-adt/auth-errors` | `^1.0.0` | `^2.0.0` |

A process should hold **one** interfaces-auth major (`npm ls
@mcp-abap-adt/interfaces-auth`). Providers must speak interfaces-auth 7 as well:
use an `@mcp-abap-adt/auth-providers` release built on it.

## What interfaces-auth 7 changes

- New error kind `renewal-declined`; a consumer that switches on `kind`
  exhaustively must handle it.
- New configuration case `invalid-value`; new operation `renewal-strategy`.
- The operation `on-tokens-hook` is now `persisting-tokens`.
- The interactive outcome `browser-launch-failed` is gone.
- `ITokenResult.refreshTokenDisposition` and `RefreshTokenDisposition` are gone.

The connection reads none of these, so nothing in its API changes. A consumer
that does must update its own code.
