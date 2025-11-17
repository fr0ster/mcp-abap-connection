# Installation Guide

## Prerequisites

- Node.js 18.0.0 or higher
- npm or yarn package manager

## Installation

### As NPM Package

```bash
npm install @mcp-abap-adt/connection
```

### From Source

```bash
git clone https://github.com/fr0ster/mcp-abap-adt.git
cd mcp-abap-adt/packages/connection
npm install
npm run build
```

## Environment Setup

### Basic Authentication

Create a `.env` file:

```bash
SAP_URL=https://your-sap-server.com
SAP_CLIENT=100
SAP_AUTH_TYPE=basic
SAP_USERNAME=your-username
SAP_PASSWORD=your-password
```

### JWT Authentication (Cloud/BTP)

```bash
SAP_URL=https://your-sap-server.com
SAP_CLIENT=100
SAP_AUTH_TYPE=jwt
SAP_JWT_TOKEN=your-jwt-token

# Optional: For automatic token refresh
SAP_REFRESH_TOKEN=your-refresh-token
SAP_UAA_URL=https://your-uaa-server.com
SAP_UAA_CLIENT_ID=your-client-id
SAP_UAA_CLIENT_SECRET=your-client-secret
```

## CLI Tool Installation

The package includes a CLI tool for browser-based authentication:

```bash
npm install -g @mcp-abap-adt/connection
```

Or use without global install:

```bash
npx @mcp-abap-adt/connection
```

## Verification

Test your installation:

```bash
node -e "const { createAbapConnection } = require('@mcp-abap-adt/connection'); console.log('✓ Package loaded successfully');"
```

## Troubleshooting

### Module not found

If you get "Cannot find module" error:

```bash
npm run build
```

### TypeScript errors

Ensure TypeScript version compatibility:

```bash
npm install --save-dev typescript@^5.9.2
```

## Next Steps

- See [USAGE.md](./USAGE.md) for usage examples
- See [AUTO_REFRESH_TESTING.md](./AUTO_REFRESH_TESTING.md) for testing guide
- See [CUSTOM_SESSION_STORAGE.md](./CUSTOM_SESSION_STORAGE.md) for session management
