/**
 * The plain-JS fixture's surface: it takes any strings for `system` and
 * `transport`, which is the point — the call is not checked.
 */
export function createPastTheTypes(
  system: string | undefined,
  transport: string | undefined,
  config: object,
  credential: object,
): unknown;
