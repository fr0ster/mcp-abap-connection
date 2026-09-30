/**
 * A hand-written 3.0 provider for tests whose subject is not a real provider:
 * it writes the header or the cookies it is told to, and answers Ok to
 * everything else.
 */
import type {
  AuthOutcome,
  IAuthProvider,
  IRequestTarget,
} from '@mcp-abap-adt/interfaces-auth';

const OK: AuthOutcome = { ok: true };

export function credentialWriting(options: {
  kind?: string;
  /** Written as `Authorization` at every request; a function is asked each time. */
  authorization?: string | (() => Promise<string> | string);
  cookies?: string;
  /** Awaited before `authorize` answers, for a provider that takes a moment. */
  beforeAuthorize?: () => Promise<void>;
}): IAuthProvider & { rejections: unknown[] } {
  const rejections: unknown[] = [];
  return {
    kind: options.kind ?? 'test',
    rejections,
    prepare: async () => OK,
    establish: async () => OK,
    authorize: async (request: IRequestTarget) => {
      await options.beforeAuthorize?.();
      const { authorization } = options;
      if (authorization !== undefined) {
        request.header(
          'Authorization',
          typeof authorization === 'function'
            ? await authorization()
            : authorization,
        );
      }
      if (options.cookies) request.cookies(options.cookies);
      return OK;
    },
    rejected: async (rejection) => {
      rejections.push(rejection);
      return OK;
    },
  };
}
