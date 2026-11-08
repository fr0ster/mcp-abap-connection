# Migration to 20.0

20.0.0 takes an RFC destination's address as the config states it. An RFC
config has no URL: it names the server it dials — one application server, or a
message server and a logon group — and its client and logon language, and the
SAP NW RFC SDK gets exactly that. Nothing of the address is derived from a URL,
nothing is defaulted, nothing is read from the environment.

It rests on `@mcp-abap-adt/interfaces-auth-sap` 4.0.0, where `ISapConfig` is a
union by connection type, and `@mcp-abap-adt/interfaces-adt-connection` 4.0.0,
where `getBaseUrl()` may answer `undefined`. Both are required (`^4.0.0`).

## What changed

- **An RFC config is an `ISapRfcConfig`** (exported here as `SapRfcConfig`):
  `connectionType: 'rfc'`, `client`, `language`, and one address:
  - an application server: `ashost` and `sysnr`;
  - a message server: `mshost`, its service as `msserv`, `sysid` or both, and
    `group`.

  `saprouter` goes with either. An RFC config takes no `url`; an HTTP config
  (`ISapHttpConfig`, exported as `SapHttpConfig`: `connectionType` `'http'` or
  absent, and `url`) takes none of the RFC keys, `saprouter` and `language`
  included. The compiler refuses a config that states two addresses, an
  incomplete one, or a key of the other shape.
- **`rfcParamsFrom(config)` and `rfcConversationFrom(config)` take an
  `ISapRfcConfig` and read it as stated.** Gone:
  - the host taken from `url` and the system number from its port (`80NN` →
    `NN`);
  - `SAP_SYSNR` read from `process.env`;
  - the defaults `client` `'000'`, `lang` `'EN'` and `group` `'PUBLIC'`;
  - the two throws (no `url`; `mshost` without `msserv` or `sysid`): the type
    proves the address complete.

  `language` reaches the SDK as `lang`; `msserv`, `sysid` and `saprouter` are
  there exactly when the config states them; no value is trimmed. The
  provider's logon parameters are still spread over the address at each open:
  where they name a key of the address, the logon's value is the one sent.
- **`RfcMessageServerParams`** is the "`msserv`, `sysid` or both" shape: a
  union in which at least one of the two is a `string`.
- **`createConnection`: each spec takes its own config shape.** `CloudHttpSpec`
  and `OnPremHttpSpec` take an `ISapHttpConfig`, `OnPremRfcSpec` an
  `ISapRfcConfig`; the other shape does not compile. A combination of `system`
  and `transport` that does not exist does not compile either; built past the
  types, it is still refused with the fixed `TypeError`, as is any other value
  passed as the spec. Only a `null` or `undefined` spec now fails with the
  runtime's own `TypeError` (reading its `transport`) rather than those fixed
  words.
- **`getBaseUrl(): Promise<string | undefined>`.** An HTTP connection answers
  the origin of its `url`, as before. An RFC connection answers `undefined`: it
  has no HTTP origin, and none is invented. Construction no longer parses a URL
  for an RFC config.
- **The HTTP transports own their base URL.** `HttpTransport`,
  `OnPremHttpTransport`, `LegacyOnPremHttpTransport` and `CloudHttpTransport`
  take `baseUrl` as a required option (`{ client?, baseUrl }`). A path a caller
  sends is put on it; the requests the wire makes on its own — the CSRF fetch,
  the cloud preflight, the logoff — go to its origin, as they did.
- **`IAdtSessionContext` has no `baseUrl`.** The connection hands a wire no
  address; `establishSession` no longer reads `getBaseUrl()`.
- **`sapConfigSignature`** also carries `connectionType`, the RFC address
  fields and `language`: two configs that dial different servers never share a
  signature.

## What to do

**An RFC config states its address, client and language.** Remove `url`; add
what was derived or defaulted:

```diff
 const config = {
-  url: 'http://saphost:8042',
+  connectionType: 'rfc',
+  ashost: 'saphost', // the host the URL named
+  sysnr: '42',       // the two digits of its 80NN port, or the SAP_SYSNR you set
+  client: '000',     // if you relied on the default
+  language: 'EN',    // if you relied on the default
   authType: 'basic',
 };
```

A message-server config adds `connectionType: 'rfc'`, `client`, `language`, and
`group: 'PUBLIC'` if it relied on that default; it removes `url`. `SAP_SYSNR`
in the environment is no longer read: put its value in `sysnr`.

Type the config you build for RFC as `SapRfcConfig` (or `ISapRfcConfig`) and
the one for HTTP as `SapHttpConfig`; a value of the whole union narrows on
`connectionType === 'rfc'` before it is handed to `rfcConversationFrom` or an
RFC spec. Data you read from outside the type system — an env file, the
environment, YAML — is yours to check before you build the config: this package
refuses nothing about a typed config.

**`getBaseUrl()` may answer `undefined`.** Narrow before you use it:

```typescript
const origin = await connection.getBaseUrl();
if (origin !== undefined) {
  // an HTTP connection: its origin
}
```

**A hand-built HTTP transport takes `baseUrl`:**

```diff
-new OnPremHttpTransport(() => ({}), logger, { client: config.client })
+new OnPremHttpTransport(() => ({}), logger, {
+  client: config.client,
+  baseUrl: config.url,
+})
```

**A custom wire or test double reading `context.baseUrl`** takes its address
from its own construction instead: the session context no longer carries one.

If you only pass an HTTP config to `createConnection` or the connectors, there
is nothing to do.
