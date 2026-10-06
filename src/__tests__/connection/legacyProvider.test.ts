/**
 * The test-only adapter that lets connection's suites run 5.x providers of
 * `@mcp-abap-adt/auth-providers` against the error contract: its table, its
 * fallback and its recorder, and the target it hands a 5.x provider.
 */

import { authError, isMinted } from '@mcp-abap-adt/auth-errors';
import { BasicAuthProvider } from '@mcp-abap-adt/auth-providers';
import type {
  AuthOutcome,
  IAuthRejection,
  ILogonTarget,
} from '@mcp-abap-adt/interfaces-auth';
import {
  drainUntranslated,
  failOnUntranslated,
  type LegacyAuthProvider,
  type LegacyOutcome,
  legacyProvider,
  reportUntranslatedAtExit,
} from '../helpers/legacyProvider.js';

const REQUEST_401: IAuthRejection = { at: 'request', status: 401, error: {} };
const LOGON_REFUSED: IAuthRejection = { at: 'logon', error: {} };

/** A 5.x provider answering the same refusal at every moment. */
function refusing(reason: string, hint?: string): LegacyAuthProvider {
  const answer: LegacyOutcome = {
    ok: false,
    refusal: hint === undefined ? { reason } : { reason, hint },
  };
  return {
    kind: 'legacy-stub',
    prepare: async () => answer,
    establish: async () => answer,
    authorize: async () => answer,
    rejected: async () => answer,
  };
}

function refusalOf(outcome: AuthOutcome) {
  if (outcome.ok) throw new Error('expected a refusal');
  return outcome.refusal;
}

describe('legacyProvider: the table', () => {
  it('a real 5.x BasicAuthProvider refused at a request is credential-refused, at request, verbatim', async () => {
    const provider = legacyProvider(new BasicAuthProvider('U', 'P'));

    const refusal = refusalOf(await provider.rejected(REQUEST_401));

    expect(isMinted(refusal)).toBe(true);
    expect(refusal.kind).toBe('credential-refused');
    expect(refusal.facts).toStrictEqual({
      credential: 'user-password',
      at: 'request',
    });
    expect(refusal.reason).toBe('the user or password was refused');
    expect(refusal.hint).toBe('check the user and password');
  });

  it.each([
    {
      reason: 'the user or password was refused',
      hint: 'check the user and password',
      kind: 'credential-refused',
      facts: { credential: 'user-password', at: 'logon' },
    },
    {
      reason: 'the token was refused',
      hint: 'obtain a new token',
      kind: 'credential-refused',
      facts: { credential: 'token', at: 'logon' },
    },
    {
      reason: 'this wire carries no TLS material (RFC)',
      hint: undefined,
      kind: 'logon-target',
      facts: { wire: 'rfc', refused: 'tls-material' },
    },
    {
      reason: 'the SNC library has no credential to present (A2200019)',
      hint: 'make sure the SNC product behind /opt/libsapcrypto.so (x64) is logged on',
      kind: 'snc',
      facts: {
        problem: 'no-credential',
        secureLoginClient: false,
        libraryArchs: ['x64'],
      },
    },
    {
      reason: 'the logon failed (unknown error)',
      hint: undefined,
      kind: 'system-refused',
      facts: { verdict: 'unknown', at: 'logon' },
    },
  ])('“$reason” becomes $kind', async ({ reason, hint, kind, facts }) => {
    const provider = legacyProvider(refusing(reason, hint));

    const refusal = refusalOf(await provider.rejected(LOGON_REFUSED));

    expect(isMinted(refusal)).toBe(true);
    expect(refusal.kind).toBe(kind);
    expect(refusal.facts).toStrictEqual(facts);
    expect(refusal.reason).toBe(reason);
  });

  it('the moment gives credential-refused its at: establish is logon, authorize is request, prepare none', async () => {
    const provider = legacyProvider(
      refusing('the token was refused', 'obtain a new token'),
    );
    const target: ILogonTarget = {
      tlsMaterial: () => ({ ok: true }),
      logonParameters: () => ({ ok: true }),
    };

    expect(refusalOf(await provider.establish(target)).facts).toStrictEqual({
      credential: 'token',
      at: 'logon',
    });
    expect(
      refusalOf(await provider.authorize({ header() {}, cookies() {} })).facts,
    ).toStrictEqual({ credential: 'token', at: 'request' });
    expect(refusalOf(await provider.prepare()).facts).toStrictEqual({
      credential: 'token',
    });
  });

  it('Ok stays Ok, and the kind is the 5.x provider’s', async () => {
    const provider = legacyProvider(new BasicAuthProvider('U', 'P'));
    expect(provider.kind).toBe(new BasicAuthProvider('U', 'P').kind);
    expect(await provider.prepare()).toStrictEqual({ ok: true });
  });
});

describe('legacyProvider: outside the table', () => {
  afterEach(() => {
    drainUntranslated();
  });

  it('answers provider-threw at the moment, records the words, and the afterEach check fails', async () => {
    const provider = legacyProvider(refusing('some new 5.x words', 'a hint'));

    const refusal = refusalOf(await provider.rejected(REQUEST_401));

    expect(isMinted(refusal)).toBe(true);
    expect(refusal.kind).toBe('connection');
    expect(refusal.facts).toStrictEqual({
      problem: 'provider-threw',
      at: 'request',
    });
    expect(() => failOnUntranslated()).toThrow(/some new 5\.x words/);
    expect(drainUntranslated()).toStrictEqual([
      { reason: 'some new 5.x words', hint: 'a hint' },
    ]);
  });

  it('prepare outside the table is provider-threw at prepare', async () => {
    const provider = legacyProvider(refusing('unheard of'));

    expect(refusalOf(await provider.prepare()).facts).toStrictEqual({
      problem: 'provider-threw',
      at: 'prepare',
    });
    expect(drainUntranslated()).toHaveLength(1);
  });
});

describe('legacyProvider: outside Jest (a probe script)', () => {
  it('reportUntranslatedAtExit writes the untranslated words to stderr at exit, and drains them', async () => {
    const handlers: (() => void)[] = [];
    const on = jest
      .spyOn(process, 'on')
      .mockImplementation((event: string | symbol, listener) => {
        if (event === 'exit') handlers.push(() => listener());
        return process;
      });
    const write = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      reportUntranslatedAtExit();
      await legacyProvider(refusing('odd 5.x words', 'a hint')).prepare();
      expect(handlers).toHaveLength(1);
      for (const handler of handlers) handler();
      expect(write).toHaveBeenCalledTimes(1);
      expect(String(write.mock.calls[0]?.[0])).toContain(
        'odd 5.x words — a hint',
      );
      expect(drainUntranslated()).toStrictEqual([]);
      for (const handler of handlers) handler();
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      on.mockRestore();
      write.mockRestore();
    }
  });
});

describe('legacyProvider: the LegacyLogonTarget', () => {
  it('hands the 5.x provider { reason, hint } read from the minted target refusal', async () => {
    const seen: LegacyOutcome[] = [];
    const legacy: LegacyAuthProvider = {
      kind: 'legacy-stub',
      prepare: async () => ({ ok: true }),
      establish: async (logon) => {
        seen.push(logon.tlsMaterial({ cert: 'C', key: 'K' }));
        seen.push(logon.logonParameters({ user: 'U' }));
        return { ok: true };
      },
      authorize: async () => ({ ok: true }),
      rejected: async () => ({ ok: true }),
    };
    const target: ILogonTarget = {
      tlsMaterial: () => ({
        ok: false,
        refusal: authError['logon-target']({
          wire: 'rfc',
          refused: 'tls-material',
        }),
      }),
      logonParameters: () => ({
        ok: false,
        refusal: authError['credential-refused']({ credential: 'token' }),
      }),
    };

    expect(await legacyProvider(legacy).establish(target)).toStrictEqual({
      ok: true,
    });
    expect(seen).toStrictEqual([
      {
        ok: false,
        refusal: { reason: 'this wire carries no TLS material (RFC)' },
      },
      {
        ok: false,
        refusal: {
          reason: 'the token was refused',
          hint: 'obtain a new token',
        },
      },
    ]);
  });

  it('hands Ok as Ok', async () => {
    const seen: LegacyOutcome[] = [];
    const legacy: LegacyAuthProvider = {
      kind: 'legacy-stub',
      prepare: async () => ({ ok: true }),
      establish: async (logon) => {
        seen.push(logon.logonParameters({ user: 'U' }));
        return { ok: true };
      },
      authorize: async () => ({ ok: true }),
      rejected: async () => ({ ok: true }),
    };

    await legacyProvider(legacy).establish({
      tlsMaterial: () => ({ ok: true }),
      logonParameters: () => ({ ok: true }),
    });

    expect(seen).toStrictEqual([{ ok: true }]);
  });
});
