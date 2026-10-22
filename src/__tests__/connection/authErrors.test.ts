import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';
import {
  authError,
  classifyOutcome,
  isMinted,
} from '@mcp-abap-adt/auth-errors';
import type { AuthOutcome, IAuthRefusal } from '@mcp-abap-adt/interfaces-auth';
import {
  AuthRefusedError,
  guarded,
  NO_CREDENTIAL_TO_RENEW,
  providerFailed,
  refusedAgain,
  WireLogonError,
} from '../../connection/authErrors.js';
import { isolatedRequire } from '../helpers/moduleCache.js';

/**
 * What a provider written in JavaScript answers: any value at all. Parsed
 * JSON is untyped, which is exactly what such a provider's answer is.
 */
function answering(value: unknown): () => Promise<AuthOutcome> {
  const json = JSON.stringify(value);
  return async () => JSON.parse(json);
}

describe('AuthRefusedError', () => {
  const refused = authError['credential-refused']({
    credential: 'user-password',
    at: 'logon',
  });

  it('carries the refusal, the moment and the cause', () => {
    const cause = new Error('wire');
    const error = new AuthRefusedError(refused, 'logon', cause);
    assert.ok(error instanceof Error);
    assert.strictEqual(error.name, 'AuthRefusedError');
    assert.strictEqual(error.refusal, refused);
    assert.strictEqual(error.refusal.kind, 'credential-refused');
    assert.strictEqual(error.at, 'logon');
    assert.strictEqual(error.cause, cause);
  });

  it('words its message as the reason alone when there is no hint', () => {
    assert.strictEqual(
      new AuthRefusedError(NO_CREDENTIAL_TO_RENEW, 'prepare').message,
      'this connection has no credential to renew',
    );
  });

  it('words its message as reason — hint', () => {
    assert.strictEqual(
      new AuthRefusedError(refused, 'request').message,
      'the user or password was refused — check the user and password',
    );
  });

  it('has no cause when none was given', () => {
    assert.strictEqual(
      new AuthRefusedError(refused, 'prepare').cause,
      undefined,
    );
  });

  it('RF3: over a structuredClone of a classified refusal, still reads reason — hint, rebuilt as a minted error', () => {
    const outcome = classifyOutcome(
      { ok: false, refusal: refused },
      providerFailed('request'),
    );
    if (outcome.ok) throw new Error('expected a refusal');
    const cloned: IAuthRefusal = structuredClone(outcome.refusal);
    assert.strictEqual(isMinted(cloned), false);
    const error = new AuthRefusedError(cloned, 'request');
    assert.strictEqual(
      error.message,
      'the user or password was refused — check the user and password',
    );
    assert.strictEqual(isMinted(error.refusal), true);
    assert.strictEqual(error.refusal.kind, 'credential-refused');
    assert.deepStrictEqual(error.refusal.facts, refused.facts);
  });
});

describe('AuthRefusedError classifies the refusal it is given', () => {
  const SECRET = 'password=hunter2';
  const library = authError.snc<'no-credential'>(
    { problem: 'no-credential', libraryArchs: ['x64'] },
    { library: '/opt/libsapcrypto.so' },
  );

  /** Every rendering of an error a log line or a report might use. */
  function everywhere(error: AuthRefusedError): string[] {
    return [
      error.message,
      String(error),
      JSON.stringify(error),
      JSON.stringify(error.refusal),
      inspect(error, { depth: 10 }),
      error.refusal.reason,
      String(error.refusal.hint),
    ];
  }

  it('keeps a refusal this copy minted as the same object', () => {
    const error = new AuthRefusedError(library, 'logon');
    assert.strictEqual(error.refusal, library);
    assert.deepStrictEqual(error.refusal.diagnostics, {
      library: '/opt/libsapcrypto.so',
    });
  });

  it('rebuilds a tampered structuredClone from its kind and facts: the foreign text is nowhere', () => {
    const tampered = Object.assign(structuredClone(library), {
      reason: `${SECRET} reason`,
      hint: `${SECRET} hint`,
      diagnostics: { library: `/${SECRET}` },
    });

    const error = new AuthRefusedError(tampered, 'logon');

    assert.strictEqual(isMinted(error.refusal), true);
    assert.strictEqual(error.refusal.kind, 'snc');
    assert.deepStrictEqual(error.refusal.facts, library.facts);
    assert.strictEqual(error.refusal.reason, library.reason);
    assert.strictEqual(error.refusal.hint, library.hint);
    assert.strictEqual(error.refusal.diagnostics, undefined);
    assert.strictEqual(error.message, `${library.reason} — ${library.hint}`);
    for (const text of everywhere(error)) assert.ok(!text.includes('hunter2'));
  });

  it('rebuilds a refusal minted by another copy of auth-errors, without its diagnostics', () => {
    const other = isolatedRequire<typeof import('@mcp-abap-adt/auth-errors')>(
      '@mcp-abap-adt/auth-errors',
    );
    const foreign = other.authError.snc<'no-credential'>(
      { problem: 'no-credential', libraryArchs: ['x64'] },
      { library: '/opt/libsapcrypto.so' },
    );
    assert.strictEqual(other.isMinted(foreign), true);
    assert.strictEqual(isMinted(foreign), false);

    const error = new AuthRefusedError(foreign, 'logon');

    assert.notStrictEqual(error.refusal, foreign);
    assert.strictEqual(isMinted(error.refusal), true);
    assert.strictEqual(error.refusal.kind, 'snc');
    assert.deepStrictEqual(error.refusal.facts, foreign.facts);
    assert.strictEqual(error.refusal.diagnostics, undefined);
    assert.strictEqual(error.message, `${foreign.reason} — ${foreign.hint}`);
  });

  it('answers provider-threw at the moment for anything that is no refusal', () => {
    const garbage: IAuthRefusal = JSON.parse(
      JSON.stringify({ reason: SECRET, hint: SECRET }),
    );

    const error = new AuthRefusedError(garbage, 'request');

    assert.deepStrictEqual(error.refusal, providerFailed('request'));
    assert.strictEqual(error.message, 'the credential provider failed');
    for (const text of everywhere(error)) assert.ok(!text.includes('hunter2'));
  });
});

describe('WireLogonError', () => {
  it('keeps the raw error as it arrived, the same object', () => {
    const raw = Object.assign(new Error('401'), { response: { status: 401 } });
    const error = new WireLogonError(raw, 401);
    assert.strictEqual(error.name, 'WireLogonError');
    assert.strictEqual(error.cause, raw);
    assert.strictEqual(error.status, 401);
  });

  it('has no status when the wire has none', () => {
    assert.strictEqual(new WireLogonError('rfc said no').status, undefined);
  });
});

describe("connection's own refusals (I3–I5)", () => {
  it('I3: provider-threw, at the moment, in the words of today', () => {
    const error = providerFailed('logon');
    assert.strictEqual(isMinted(error), true);
    assert.strictEqual(error.kind, 'connection');
    assert.deepStrictEqual(error.facts, {
      problem: 'provider-threw',
      at: 'logon',
    });
    assert.strictEqual(error.reason, 'the credential provider failed');
    assert.strictEqual(error.hint, undefined);
  });

  it('I4: refused-after-renewal, at the moment, in the words of today', () => {
    const error = refusedAgain('request');
    assert.strictEqual(isMinted(error), true);
    assert.strictEqual(error.kind, 'connection');
    assert.deepStrictEqual(error.facts, {
      problem: 'refused-after-renewal',
      at: 'request',
    });
    assert.strictEqual(
      error.reason,
      'the credential was refused again after the provider renewed it',
    );
    assert.strictEqual(error.hint, undefined);
  });

  it('I5: no-credential, in the words of today', () => {
    assert.strictEqual(isMinted(NO_CREDENTIAL_TO_RENEW), true);
    assert.strictEqual(NO_CREDENTIAL_TO_RENEW.kind, 'connection');
    assert.deepStrictEqual(NO_CREDENTIAL_TO_RENEW.facts, {
      problem: 'no-credential',
    });
    assert.strictEqual(
      NO_CREDENTIAL_TO_RENEW.reason,
      'this connection has no credential to renew',
    );
    assert.strictEqual(NO_CREDENTIAL_TO_RENEW.hint, undefined);
  });
});

describe('guarded', () => {
  it('passes Ok through', async () => {
    assert.deepStrictEqual(
      await guarded(async () => ({ ok: true }), 'prepare'),
      {
        outcome: { ok: true },
      },
    );
  });

  it('passes a refusal minted by the same auth-errors as the same object', async () => {
    const refusal = authError['credential-refused']({ credential: 'token' });
    const answer = await guarded(
      async () => ({ ok: false, refusal }),
      'request',
    );
    if (answer.outcome.ok) throw new Error('expected a refusal');
    assert.strictEqual(answer.outcome.refusal, refusal);
    assert.strictEqual('thrown' in answer, false);
  });

  it('re-mints a forged refusal from a JavaScript provider as provider-threw; the secret is in no message', async () => {
    const secret = 'password=hunter2';
    const answer = await guarded(
      answering({ ok: false, refusal: { reason: secret, hint: secret } }),
      'logon',
    );
    if (answer.outcome.ok) throw new Error('expected a refusal');
    assert.strictEqual(isMinted(answer.outcome.refusal), true);
    assert.strictEqual(answer.outcome.refusal.kind, 'connection');
    assert.deepStrictEqual(answer.outcome.refusal.facts, {
      problem: 'provider-threw',
      at: 'logon',
    });
    const error = new AuthRefusedError(answer.outcome.refusal, 'logon');
    assert.strictEqual(error.message, 'the credential provider failed');
    assert.ok(!error.message.includes('hunter2'));
    assert.ok(!JSON.stringify(answer).includes('hunter2'));
  });

  it('re-mints an answer that is no outcome at all as provider-threw', async () => {
    const answer = await guarded(answering('nonsense'), 'request');
    assert.deepStrictEqual(answer.outcome, {
      ok: false,
      refusal: providerFailed('request'),
    });
  });

  it('turns a throw into provider-threw at the moment and keeps the throw', async () => {
    const thrown = new Error('boom');
    const answer = await guarded(async () => {
      throw thrown;
    }, 'prepare');
    if (answer.outcome.ok) throw new Error('expected a refusal');
    assert.strictEqual(answer.outcome.refusal.kind, 'connection');
    assert.deepStrictEqual(answer.outcome.refusal.facts, {
      problem: 'provider-threw',
      at: 'prepare',
    });
    assert.strictEqual(
      answer.outcome.refusal.reason,
      'the credential provider failed',
    );
    assert.strictEqual(answer.thrown, thrown);
  });

  it('turns a synchronous throw into provider-threw too', async () => {
    const thrown = new Error('sync');
    const answer = await guarded(() => {
      throw thrown;
    }, 'request');
    assert.deepStrictEqual(answer.outcome, {
      ok: false,
      refusal: providerFailed('request'),
    });
    assert.strictEqual(answer.thrown, thrown);
  });
});
