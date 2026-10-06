// Rule 4: a type assertion to an error of the contract. Must be found.
import type { IAuthProviderError } from '@mcp-abap-adt/interfaces-auth';

export function forged(): IAuthProviderError {
  return { reason: 'forged' } as unknown as IAuthProviderError;
}
