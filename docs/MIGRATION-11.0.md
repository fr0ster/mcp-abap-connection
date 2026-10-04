# Migration to 11.0

11.0.0 changes one thing: **the HTTP wire verifies the server certificate by
default**, as Node does. Nothing else in the API changed.

## What was wrong

Up to 10.x, `HttpTransport` — and so `OnPremHttpTransport`,
`LegacyOnPremHttpTransport` and `CloudHttpTransport` — built its HTTPS agent with
`rejectUnauthorized: true` only when `NODE_TLS_REJECT_UNAUTHORIZED` or
`TLS_REJECT_UNAUTHORIZED` was set to `1`. With neither set, which is the usual
case, the server certificate was **not verified**: any certificate, from anyone
in the path, was accepted. That held on every HTTPS connection, BTP included.

## What it does now

| What you set | Verified? |
|---|---|
| nothing | **yes** |
| `agentOptions: { ca }` | yes, also against that CA |
| `agentOptions: { rejectUnauthorized: false }` | no |
| `agentOptions: { rejectUnauthorized: true }` | yes, whatever the environment says |
| `TLS_REJECT_UNAUTHORIZED=0` | no (unless `agentOptions.rejectUnauthorized` says otherwise) |
| `NODE_TLS_REJECT_UNAUTHORIZED=0` | no (unless `agentOptions.rejectUnauthorized` says otherwise) |
| either variable with any other value — `1`, `false`, `no`, empty | yes |

`agentOptions.rejectUnauthorized` wins over the environment: it is your own
code. Only the exact value `0` turns verification off through a variable, so a
typo fails closed. When verification is off the wire logs, once and at debug
level, `TLS: the server certificate is not verified (explicit opt-out)`.

## Who is affected

**Anyone whose system presents a certificate Node does not trust and who never
set anything** — typically an on-premise system with a self-signed certificate
or one issued by a company CA that is not in Node's store. Those connections
worked by accident and now fail at the first request with a TLS error such as
`DEPTH_ZERO_SELF_SIGNED_CERT`, `SELF_SIGNED_CERT_IN_CHAIN` or
`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, before anything reaches the system.

Not affected: a system with a publicly trusted certificate (SAP BTP, most
hosted systems), anyone who already set one of the variables to `0`, and the RFC
wire, which does not use TLS through this package.

## What to do

**Trust the system's CA** — the right fix. Pass the certificate (or the CA that
issued it) as `ca` in `agentOptions`:

```typescript
import { readFileSync } from 'node:fs';
import { OnPremHttpTransport } from '@mcp-abap-adt/connection';

const ca = readFileSync('/path/to/sap-system-ca.pem', 'utf8');

const transport = new OnPremHttpTransport(() => ({ ca }), null, {
  client: '100',
  baseUrl: 'https://sap.example.com:44300',
});
```

`ca` replaces Node's built-in list of trusted CAs for that wire, so it must
hold every CA the connection has to trust. Alternatively, `NODE_EXTRA_CA_CERTS=/path/to/sap-system-ca.pem` adds it
to Node's store for the whole process, without code changes.

**Turn verification off** — the last resort, for a development system only.
Either in code:

```typescript
import { OnPremHttpTransport } from '@mcp-abap-adt/connection';

const unverified = new OnPremHttpTransport(
  () => ({ rejectUnauthorized: false }),
  null,
  { client: '100', baseUrl: 'https://sap.example.com:44300' },
);
```

or in the environment:

```bash
export TLS_REJECT_UNAUTHORIZED=0        # this package only
export NODE_TLS_REJECT_UNAUTHORIZED=0   # every TLS connection in the process
```

Prefer `TLS_REJECT_UNAUTHORIZED`: `NODE_TLS_REJECT_UNAUTHORIZED=0` also turns
verification off for everything else the process connects to.

If you set `TLS_REJECT_UNAUTHORIZED=1` or `NODE_TLS_REJECT_UNAUTHORIZED=1` to get
verification in 10.x, you can drop it: it is the default now.
