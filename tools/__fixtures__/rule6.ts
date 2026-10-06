// Rule 6: a builder call with diagnostics outside diagnostic-sites.json.
// Must be found.
import { authError } from '@mcp-abap-adt/auth-errors';

export function withLibrary() {
  return authError.snc<'no-credential'>(
    { problem: 'no-credential' },
    { library: '/opt/libsapcrypto.so' },
  );
}
