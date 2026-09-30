/**
 * Let the goodbye that `disconnect()` dispatched but does not wait for go out.
 * Its headers are asked of the credential first, and how many turns of the
 * event loop that takes is the provider's business, not a contract to count on.
 */
export const settled = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));
