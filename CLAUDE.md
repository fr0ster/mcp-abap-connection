# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # Clean + biome lint (error-level) + tsc compile
npm run build:fast     # tsc only (skip clean and lint, for rapid iteration)
npm run lint           # Biome auto-fix
npm run lint:check     # Biome read-only check
npm test               # Jest (all tests)
npx jest --testPathPattern=connectionFactory  # Run a single test file
```

## Architecture

SAP ABAP ADT connection library. Provides HTTP request handling with auth, CSRF tokens, cookies, and session management for SAP systems.

**Class hierarchy:**

```
AbapConnection (interface from @mcp-abap-adt/interfaces)
  └─ AbstractAbapConnection (abstract, NOT exported)
       ├─ BaseAbapConnection    — Basic Auth (on-prem)
       ├─ JwtAbapConnection     — JWT/Bearer (BTP cloud), supports ITokenRefresher injection
       └─ SamlAbapConnection    — SAML session cookies
```

`createAbapConnection()` factory in `connectionFactory.ts` switches on `config.authType` to produce the correct instance.

**Template method pattern:** `AbstractAbapConnection` implements shared logic (`makeAdtRequest`, `fetchCsrfToken`, cookie/session management). Subclasses implement `connect()` and `buildAuthorizationHeader()`.

**Key design decisions:**
- All external deps accessed through interfaces from `@mcp-abap-adt/interfaces` — no direct coupling
- Logger is optional everywhere, all calls use `logger?.method()` pattern
- CSRF fetch retries 3 times with fallback endpoint (`/sap/bc/adt/discovery`) for older BASIS < 7.52
- `skipSessionType` option exists for BASIS 7.40 where stateful header causes locking issues
- Timeouts configurable via env vars: `SAP_TIMEOUT_DEFAULT`, `SAP_TIMEOUT_CSRF`, `SAP_TIMEOUT_LONG`

**Backward-compat aliases:** `BaseAbapConnection` = `OnPremAbapConnection`, `JwtAbapConnection` = `CloudAbapConnection`

## Conventions

- **Biome** enforces formatting and linting — build fails on format errors
- Single quotes, semicolons always, 2-space indent
- Node built-ins use `node:` prefix (e.g., `node:https`, `node:crypto`)
- Local imports use `.js` extension (CommonJS output, ESM-compatible paths)
- Tests in `src/__tests__/*.test.ts`, excluded from tsc compilation
- Tests use `(instance as any).method()` to access protected members

## Release

GitHub Actions triggers on `v*.*.*` tags — runs build, `npm pack`, creates GitHub Release with `.tgz`.

- Never change `package.json` version without explicit user request
- After changing the version in `package.json`, always run `npm install --package-lock-only` to update `package-lock.json` and include it in the same commit

## Plans and Specs

After a plan under `docs/superpowers/plans/` or spec under `docs/superpowers/specs/` has been fully implemented, delete the file. Keep only active (not yet implemented) plans and specs in the tree — implementation history lives in git, not in these directories.
