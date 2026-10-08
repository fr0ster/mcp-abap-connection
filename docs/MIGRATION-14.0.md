# Migration to 14.0

14.0.0 removes the bundled `sap-abap-auth` command-line tool, together with the
two dependencies only it used, `open` and `commander`. The library's API, its
lifecycle and its behaviour are unchanged.

## What a consumer must do

- **If you used `sap-abap-auth`** (`npx sap-abap-auth auth -k service-key.json`,
  a global install, or `npx @mcp-abap-adt/connection sap-abap-auth …`): use
  [`@mcp-abap-adt/auth-broker-cli`](https://www.npmjs.com/package/@mcp-abap-adt/auth-broker-cli)
  instead. It provides the `mcp-auth` command (service key to destination) and
  `mcp-sso`; its README lists the options and the `.env` it writes. Its options
  are not those of `sap-abap-auth`, so read it before replacing a script.
- **If you only used the library**: nothing. You no longer install `open` and
  `commander` through this package; if your code imported either, depend on it
  yourself.
