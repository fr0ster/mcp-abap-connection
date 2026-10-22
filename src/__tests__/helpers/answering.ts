/**
 * A mock function that answers its calls in order: the first call the first
 * answer, the second the second, and any call past the last one `undefined`
 * (what `jest.fn().mockResolvedValueOnce(…).mockRejectedValueOnce(…)` did).
 * Each answer is a promise — resolved with `resolve`, rejected with `reject`.
 */
import { mock } from 'node:test';

export type Answer = { resolve: unknown } | { reject: unknown };

export function answering(...answers: Answer[]) {
  let call = 0;
  return mock.fn((..._args: any[]): any => {
    const answer = answers[call++];
    if (answer === undefined) return undefined;
    return 'reject' in answer
      ? Promise.reject(answer.reject)
      : Promise.resolve(answer.resolve);
  });
}
