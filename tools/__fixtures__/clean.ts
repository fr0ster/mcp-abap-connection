// None of rules 4, 5, 6: a minted error relayed as it is. Must pass.
import { authError } from '@mcp-abap-adt/auth-errors';
import type { AuthOutcome } from '@mcp-abap-adt/interfaces-auth';

export function relayed(): AuthOutcome {
  const refusal = authError.connection({ problem: 'no-credential' });
  return { ok: false, refusal };
}
