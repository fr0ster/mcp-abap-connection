# Migration to 19.0

19.0.0 moves the optional RFC dependency `@mcp-abap-adt/sap-rfc-lite` from `^0.2.2` to `^0.3.2`.
The connection's API and the RFC wire's behaviour are unchanged; what changes is how the RFC
binding gets onto a machine.

## What changed

- **sap-rfc-lite compiles nothing on install.** 0.2.x compiled its native binding during
  `npm install` (with the SAP NW RFC SDK and a C++ toolchain). 0.3.x has no install script —
  `npm install` and `npm ci` run nothing — and loads a prebuilt binding at run time.
- **Prebuilt bindings exist for linux-x64 (glibc), win32-x64 and darwin-arm64.** On these, an
  install needs no SDK headers and no compiler.
- **Anywhere else there is no binding after install** — linux-arm64, darwin-x64, Linux with musl
  (Alpine), and any other platform. The install succeeds (the dependency is optional), and the RFC
  wire fails when `rfcConversationFrom` loads sap-rfc-lite.
- **The RFC library at run time:** on Windows, the 64-bit `sapnwrfc.dll` SAP GUI installs into
  `System32` is enough; otherwise the SAP NW RFC SDK, its `lib` directory on the library search
  path.
- sap-rfc-lite 0.3 needs Node.js 20 or newer; this package already needs 22.

## What to do

- **On linux-x64 (glibc), win32-x64 or darwin-arm64:** nothing. If you built with
  `SAPNWRFC_HOME` only for the install, it is no longer needed then; keep the SDK libraries
  loadable at run time (or SAP GUI's on Windows).
- **On any other platform**, build sap-rfc-lite's binding from its repository and install the
  package you built (sap-rfc-lite's README, "Installation"):

  ```bash
  git clone https://github.com/fr0ster/sap-rfc-lite.git && cd sap-rfc-lite
  git checkout v0.3.2
  npm ci
  npm run prebuild:native      # needs SAPNWRFC_HOME and a C++ toolchain
  npm pack                     # install the .tgz in your project
  ```

- **HTTP only:** nothing; sap-rfc-lite is loaded only by the RFC wire.
