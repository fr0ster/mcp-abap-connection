// Rule 5: a spread of an error of the contract. Must be found.
import { authError } from '@mcp-abap-adt/auth-errors';

export function copied() {
  const refusal = authError.connection({ problem: 'no-credential' });
  return { ...refusal };
}
