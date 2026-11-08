/**
 * A mock function that answers its calls in order: the first call the first
 * answer, the second the second; a call past the last one is rejected.
 * Each answer is a promise — resolved with `resolve`, rejected with `reject`.
 */
import { mock } from 'node:test';
import type {
  IAdtTransportRequest,
  IAdtTransportResponse,
} from '../../connection/IAdtTransport.js';

export type Answer = { resolve: IAdtTransportResponse } | { reject: unknown };

export function answering(...answers: Answer[]) {
  let call = 0;
  return mock.fn(
    (_request: IAdtTransportRequest): Promise<IAdtTransportResponse> => {
      const answer = answers[call++];
      // Past the last answer: a call nobody queued, failed loudly.
      if (answer === undefined)
        return Promise.reject(new Error('no answer queued for this call'));
      return 'reject' in answer
        ? Promise.reject(answer.reject)
        : Promise.resolve(answer.resolve);
    },
  );
}
