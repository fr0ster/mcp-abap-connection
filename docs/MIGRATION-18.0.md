# Migration to 18.0

18.0.0 adds RFC logon through a message server and a logon group
(load-balanced logon). For a consumer on 17.x, the change is confined to the
types of one function.

## What changed

- **`rfcParamsFrom(config)` returns `RfcAddress`.** That is
  `RfcConnectionParams | RfcMessageServerParams`; before, it returned
  `RfcConnectionParams`.
  - A config with `mshost` yields a message-server address:
    `{ mshost, msserv?, sysid?, group, client, lang, saprouter? }`.
  - Any other config yields the application-server address as before:
    `{ ashost, sysnr, client, lang, saprouter? }`.
  - At run time nothing changes for a config without `mshost`. The break is in
    the type: code that read `.ashost` or `.sysnr` straight off the result no
    longer compiles.
- **New exported types:** `RfcAddress`, `RfcMessageServerParams`.
- **`RfcConnectionParams`** gains an optional `saprouter`.
- **`@mcp-abap-adt/interfaces-auth-sap` ^3.4.0** is required. It adds the
  `ISapConfig` fields `mshost`, `msserv`, `sysid`, `group` and `saprouter`.

## What to do

If you call `rfcParamsFrom` and read its fields, narrow first:

```typescript
const params = rfcParamsFrom(config);
if ('ashost' in params) {
  // one application server: params.ashost, params.sysnr
} else {
  // a message server: params.mshost, params.msserv / params.sysid, params.group
}
```

If you only pass the config to `rfcConversationFrom` or `createConnection`,
there is nothing to do.

## Using a message server

Add `mshost`, plus `msserv` or `sysid` (one of the two is required), and
`group` (default `PUBLIC`) to the config. `saprouter` works with either
addressing. The url is still the system's ADT URL, but the RFC wire takes no
host and no system number from it, and `SAP_SYSNR` is not read.

**Verification status.** The message-server address follows the SAP NW RFC SDK's
own connection parameters, and it is unit-tested. It has **not yet been run
against a live message server**. In particular, `mshost` + `msserv` without
`sysid` is accepted here, but no SDK documentation found so far confirms that
combination. If the SDK refuses it, add `sysid`. The gated integration test in
`src/__tests__/rfc-connection.test.ts` (`SAP_MSHOST`, plus `SAP_MSSERV` or
`SAP_SYSID`) runs it on a system that has one.
