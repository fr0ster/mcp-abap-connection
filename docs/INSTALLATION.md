# Installation Guide

**Version:** 0.1.10  
**Last Updated:** December 2025

## Prerequisites

- Node.js >= 18.0.0
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

When using the `sap-abap-auth` CLI tool, the generated `.env` file will include token expiry information:

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
import { createAbapConnection } from '@mcp-abap-adt/connection';

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

## CLI Tool Installation

The package includes `sap-abap-auth` CLI tool for browser-based JWT authentication.

### Global Installation

```bash
npm install -g @mcp-abap-adt/connection
```

Then use directly:

```bash
sap-abap-auth auth -k service-key.json
```

### Local Project Installation

```bash
npm install --save-dev @mcp-abap-adt/connection
```

Use via npx:

```bash
npx sap-abap-auth auth -k service-key.json
```

### On-Demand (No Installation)

```bash
npx @mcp-abap-adt/connection sap-abap-auth auth -k service-key.json
```

See [JWT_AUTH_TOOLS.md](./JWT_AUTH_TOOLS.md) for detailed CLI documentation.

## Verification

### Test Installation

```bash
node -e "const { createAbapConnection } = require('@mcp-abap-adt/connection'); console.log('✓ Package loaded successfully');"
```

### Test Connection (Basic Auth)

Create `test-connection.js`:

```javascript
const { createAbapConnection } = require('@mcp-abap-adt/connection');

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

const connection = createAbapConnection(config, logger);

connection.makeAdtRequest({
  method: 'GET',
  url: '/sap/bc/adt/discovery'
})
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
import { createAbapConnection, SapConfig, ILogger } from '@mcp-abap-adt/connection';

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

const connection = createAbapConnection(config, logger);
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
node --version  # Should be >= 18.0.0

# Rebuild
npm run build
```

### Connection errors

**401 Unauthorized**: Check username/password or JWT token  
**403 Forbidden**: Check user permissions in SAP  
**ENOTFOUND**: Check SAP URL is correct and reachable  
**ETIMEDOUT**: Check network/firewall, try increasing timeout

### SSL/TLS errors

For development with self-signed certificates:

```bash
export NODE_TLS_REJECT_UNAUTHORIZED=0
```

**⚠️ Warning**: Never use this in production!

## Version Compatibility

| Package Version | Node.js | TypeScript |
|----------------|---------|------------|
| 0.1.10         | >= 18.0 | >= 5.0     |
| 0.1.9          | >= 18.0 | >= 5.0     |
| 0.1.8          | >= 18.0 | >= 5.0     |
| 0.1.0 - 0.1.7  | >= 18.0 | >= 4.5     |

## Next Steps

- 📚 Read [USAGE.md](./USAGE.md) for detailed usage examples
- 🔄 Token refresh is handled by `@mcp-abap-adt/auth-broker` package
- 💾 Session state persistence is handled by `@mcp-abap-adt/auth-broker` package
- 🔑 Use [JWT auth CLI tool](./JWT_AUTH_TOOLS.md)
- 📖 Review [CHANGELOG.md](../CHANGELOG.md) for version history
