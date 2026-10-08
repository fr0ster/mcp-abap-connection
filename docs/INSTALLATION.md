# Installation Guide

**Version:** see [CHANGELOG.md](../CHANGELOG.md)  

## Prerequisites

- Node.js 22, 24 or 26 (`engines`: `^22 || ^24 || ^26`)
- npm or yarn package manager
- Access to SAP ABAP system (on-premise or BTP)

## Installation

### As NPM Package (Recommended)

```bash
npm install @mcp-abap-adt/connection
```

### With Yarn

```bash
yarn add @mcp-abap-adt/connection
```

### From Source

```bash
git clone https://github.com/fr0ster/mcp-abap-connection.git
cd mcp-abap-connection
npm install
npm run build
```

## Environment Setup

### Basic Authentication (On-Premise)

Create a `.env` file in your project root:

```bash
SAP_URL=https://your-sap-server.com:8000
SAP_CLIENT=100
SAP_AUTH_TYPE=basic
SAP_USERNAME=your-username
SAP_PASSWORD=your-password
```

### JWT Authentication (SAP BTP Cloud)

A `.env` file that carries a JWT can record its expiry as comments, for example:

```bash
# Token Expiry Information (auto-generated)
# JWT Token expires: Monday, December 25, 2025 at 10:30:45 AM UTC
# JWT Token expires at: 2025-12-25T10:30:45.000Z
# Refresh Token expires: Tuesday, January 25, 2026 at 10:30:45 AM UTC
# Refresh Token expires at: 2026-01-25T10:30:45.000Z

SAP_URL=https://your-instance.abap.cloud.sap
SAP_CLIENT=100
SAP_AUTH_TYPE=jwt
SAP_JWT_TOKEN=your-jwt-token

# Note: Token refresh is handled by @mcp-abap-adt/auth-broker package
# Connection package does not use refresh token credentials
```

**Manual Setup:** If creating `.env` manually (without CLI), you can omit the expiry comments:

```bash
SAP_URL=https://your-instance.abap.cloud.sap
SAP_CLIENT=100
SAP_AUTH_TYPE=jwt
SAP_JWT_TOKEN=your-jwt-token

# Note: Token refresh is handled by @mcp-abap-adt/auth-broker package
# Connection package does not use refresh token credentials
```

### Loading Environment Variables

In your code:

```typescript
import 'dotenv/config'; // or require('dotenv').config();
import { AdtOnPremConnector } from '@mcp-abap-adt/connection';
import { BasicAuthProvider } from '@mcp-abap-adt/auth-providers';

const config = {
  url: process.env.SAP_URL!,
  client: process.env.SAP_CLIENT,
  authType: process.env.SAP_AUTH_TYPE as 'basic' | 'jwt',
  username: process.env.SAP_USERNAME,
  password: process.env.SAP_PASSWORD,
  jwtToken: process.env.SAP_JWT_TOKEN,
  // Note: Token refresh credentials are not used by connection package
  // Token refresh is handled by @mcp-abap-adt/auth-broker
};
```

## Verification

### Test Installation

```bash
node -e "const { AdtOnPremConnector } = require('@mcp-abap-adt/connection'); console.log('✓ Package loaded successfully');"
```

### Test Connection (Basic Auth)

Create `test-connection.js`:

```javascript
const { AdtOnPremConnector, OnPremHttpTransport } = require('@mcp-abap-adt/connection');
const { BasicAuthProvider } = require('@mcp-abap-adt/auth-providers');

const config = {
  url: 'https://your-sap-server.com',
  authType: 'basic',
  username: 'your-username',
  password: 'your-password',
  client: '100'
};

const logger = {
  info: (msg) => console.log('[INFO]', msg),
  error: (msg) => console.error('[ERROR]', msg),
  warn: (msg) => console.warn('[WARN]', msg),
  debug: (msg) => console.log('[DEBUG]', msg),
};

const connection = new AdtOnPremConnector(
  config,
  new BasicAuthProvider(config.username, config.password),
  new OnPremHttpTransport(() => ({}), logger, {
    client: config.client,
    baseUrl: config.url,
  }),
  logger,
);

connection.connect()
  .then(() =>
    connection.makeAdtRequest({
      method: 'GET',
      url: '/sap/bc/adt/discovery',
    }),
  )
  .then(() => console.log('✓ Connection successful'))
  .catch((err) => console.error('✗ Connection failed:', err.message));
```

Run:

```bash
node test-connection.js
```

## TypeScript Setup

### Install TypeScript

```bash
npm install --save-dev typescript @types/node
```

### Install the contracts you name

`@mcp-abap-adt/connection` no longer brings the contract packages along, so
anything your own signatures name has to be installed. Install the ones you
actually use:

```bash
npm install @mcp-abap-adt/interfaces-adt-connection # IAbapConnection, ITimeoutConfig, ADT_SESSION_ERROR
npm install @mcp-abap-adt/interfaces-auth     # IAuthProvider, AuthOutcome, IAuthProviderError, ITokenRefresher (7.x)
npm install @mcp-abap-adt/auth-errors         # authError builders, classify — to mint a refusal of your own
npm install @mcp-abap-adt/interfaces-auth-sap # ISapConfig, SapAuthType, ICertificateMaterialLoader
npm install @mcp-abap-adt/interfaces-network  # NETWORK_ERROR_CODES, the WebSocket contracts
npm install @mcp-abap-adt/interfaces-utils    # ILogger
```

Nothing is needed here if you only call what this package exports — the types
travel with it. Do **not** reach for `@mcp-abap-adt/interfaces`: it is **deleted**
as of its 52.0.0, npm still serves 51.0.0 with every symbol re-exported and
deprecated, and installing that alongside a contract package at a different major
puts two copies of the same contract in your tree.
[Migration to 9.0.0](./MIGRATION-9.0.md) has the details.

The credential providers (`BasicAuthProvider`, `TokenAuthProvider`,
`SamlAuthProvider`, `CertificateAuthProvider`) are no longer part of this
package as of 10.0.0; install `@mcp-abap-adt/auth-providers` for them —
connection 13.x works with auth-providers **6.0.0** (`^6.0.0`), built on
interfaces-auth 7 and auth-errors 2; the 5.x providers do not fit.
See [Migration to 10.0.0](./MIGRATION-10.0.md),
[Migration to 12.0.0](./MIGRATION-12.0.md) and
[Migration to 13.0.0](./MIGRATION-13.0.md).

### Create `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### TypeScript Example

```typescript
import {
  AdtOnPremConnector,
  ILogger,
  OnPremHttpTransport,
  SapConfig,
} from '@mcp-abap-adt/connection';
import { BasicAuthProvider } from '@mcp-abap-adt/auth-providers';

const config: SapConfig = {
  url: 'https://your-sap-server.com',
  authType: 'basic',
  username: 'user',
  password: 'pass',
  client: '100'
};

const logger: ILogger = {
  info: (msg: string) => console.log(msg),
  error: (msg: string) => console.error(msg),
  warn: (msg: string) => console.warn(msg),
  debug: (msg: string) => console.log(msg),
};

const connection = new AdtOnPremConnector(
  config,
  new BasicAuthProvider(config.username!, config.password!),
  new OnPremHttpTransport(() => ({}), logger, {
    client: config.client,
    baseUrl: config.url,
  }),
  logger,
);
```

## Troubleshooting

### Module not found

If you get "Cannot find module" error after installation:

```bash
# Clear cache
npm cache clean --force

# Reinstall
rm -rf node_modules package-lock.json
npm install
```

### TypeScript errors

Ensure TypeScript version compatibility:

```bash
npm install --save-dev typescript@^5.9.2
```

### Build errors

If building from source fails:

```bash
# Check Node version
node --version  # Should be v22, v24 or v26

# Rebuild
npm run build
```

### Connection errors

**401 Unauthorized**: Check username/password or JWT token  
**403 Forbidden**: Check user permissions in SAP  
**ENOTFOUND**: Check SAP URL is correct and reachable  
**ETIMEDOUT**: Check network/firewall, try increasing timeout

### SSL/TLS errors

The server certificate is verified by default (since 11.0.0). A system whose
certificate Node does not trust — self-signed, or issued by a company CA — is
refused at the first request with an error such as `DEPTH_ZERO_SELF_SIGNED_CERT`
or `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.

**Trust the system's CA** (preferred): pass it as `ca` in the transport's
`agentOptions`, or add it to Node's store for the whole process.

```typescript
import { readFileSync } from 'node:fs';
import { OnPremHttpTransport } from '@mcp-abap-adt/connection';

const ca = readFileSync('/path/to/sap-system-ca.pem', 'utf8');
const transport = new OnPremHttpTransport(() => ({ ca }), null, {
  client: '100',
  baseUrl: 'https://sap.example.com:44300',
});
```

```bash
export NODE_EXTRA_CA_CERTS=/path/to/sap-system-ca.pem
```

**Turn verification off** (last resort, development only), explicitly — only the
value `0` does it, anything else verifies:

```bash
export TLS_REJECT_UNAUTHORIZED=0        # this package's HTTP wire only
export NODE_TLS_REJECT_UNAUTHORIZED=0   # every TLS connection in the process
```

or `agentOptions: { rejectUnauthorized: false }`, which wins over both
variables. **⚠️ Warning**: never in production — anyone in the path can then
read and change the traffic, credentials included. See
[MIGRATION-11.0.md](./MIGRATION-11.0.md).

## Version Compatibility

| Package Version | Node.js | TypeScript |
|----------------|---------|------------|
| 10.0.2 and later | 22, 24, 26 | >= 5.0 |
| 0.1.10         | >= 18.0 | >= 5.0     |
| 0.1.9          | >= 18.0 | >= 5.0     |
| 0.1.8          | >= 18.0 | >= 5.0     |
| 0.1.0 - 0.1.7  | >= 18.0 | >= 4.5     |

## Next Steps

- 📚 Read [USAGE.md](./USAGE.md) for detailed usage examples
- 🔄 Token refresh is handled by `@mcp-abap-adt/auth-broker` package
- 💾 Session state persistence is handled by `@mcp-abap-adt/auth-broker` package
- 🔑 Obtain tokens for SAP BTP with `@mcp-abap-adt/auth-broker-cli`
- 📖 Review [CHANGELOG.md](../CHANGELOG.md) for version history
