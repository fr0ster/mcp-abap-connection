/**
 * Test-only: a 5.x provider of `@mcp-abap-adt/auth-providers` as an
 * `IAuthProvider` of the error contract.
 *
 * connection releases before auth-providers 6.0.0 exists, and its suites run
 * real providers from the devDependency `^5.2.0`, whose refusals are unbranded
 * `{ reason, hint }` free text — not an `AuthOutcome` of interfaces-auth 6.
 * This adapter bridges the gap, with no cast: the 5.x classes satisfy
 * `LegacyAuthProvider` structurally, and the adapter is an ordinary
 * `IAuthProvider`.
 *
 * A 5.x refusal is translated by a CLOSED table, from the exact 5.x words
 * connection's suites produce to the builder call of the spec's Appendix A,
 * and then passed through `classifyOutcome`. Words outside the table answer
 * `provider-threw` and are recorded; the `afterEach` registered below fails
 * the test that produced them, so no refusal is silently re-worded.
 *
 * Never shipped (`tsconfig.json` leaves `src/__tests__` out of `dist`), and
 * removed — adapter, table and `afterEach` — once the devDependency moves to
 * auth-providers 6.0.0.
 */
import { authError, classifyOutcome } from '@mcp-abap-adt/auth-errors';
import type {
  AuthOutcome,
  IAuthProvider,
  IAuthProviderError,
  IAuthRejection,
  ICertificateMaterial,
  ILogonTarget,
  IRequestTarget,
} from '@mcp-abap-adt/interfaces-auth';

/** A 5.x refusal: free text. */
export interface LegacyRefusal {
  readonly reason: string;
  readonly hint?: string | undefined;
}

/** A 5.x outcome. */
export type LegacyOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: LegacyRefusal };

/** The logon target a 5.x provider writes into. */
export interface LegacyLogonTarget {
  tlsMaterial(material: ICertificateMaterial): LegacyOutcome;
  logonParameters(parameters: Readonly<Record<string, string>>): LegacyOutcome;
}

/** A 5.x provider, structurally: its four methods and their 5.x outcome. */
export interface LegacyAuthProvider {
  readonly kind: string;
  prepare(): Promise<LegacyOutcome>;
  establish(logon: LegacyLogonTarget): Promise<LegacyOutcome>;
  authorize(request: IRequestTarget): Promise<LegacyOutcome>;
  rejected(rejection: IAuthRejection): Promise<LegacyOutcome>;
}

/** The connection's moment the answer belongs to. */
type Moment = 'prepare' | 'logon' | 'request';

/** What a row may read beside the words: the moment the refusal is about. */
interface RowContext {
  /** `logon` / `request`; none for `prepare`. */
  readonly at: 'logon' | 'request' | undefined;
}

type Row = (context: RowContext) => IAuthProviderError;

const key = (reason: string, hint: string | undefined): string =>
  JSON.stringify([reason, hint ?? null]);

/**
 * The closed table: every 5.x refusal connection's suites produce, recorded on
 * master (11.0.1) with auth-providers 5.2.0, and its Appendix A builder call.
 */
const TRANSLATIONS: ReadonlyMap<string, Row> = new Map<string, Row>([
  // B7 — BasicAuthProvider.rejected
  [
    key('the user or password was refused', 'check the user and password'),
    ({ at }) =>
      authError['credential-refused']({
        credential: 'user-password',
        ...(at === undefined ? {} : { at }),
      }),
  ],
  // B11 — TokenAuthProvider.rejected
  [
    key('the token was refused', 'obtain a new token'),
    ({ at }) =>
      authError['credential-refused']({
        credential: 'token',
        ...(at === undefined ? {} : { at }),
      }),
  ],
  // I1 — the RFC target's refusal, relayed by CertificateAuthProvider.establish
  [
    key('this wire carries no TLS material (RFC)', undefined),
    () => authError['logon-target']({ wire: 'rfc', refused: 'tls-material' }),
  ],
  // G1 — SncLogonProvider.rejected, no Secure Login Client, the suite's library
  [
    key(
      'the SNC library has no credential to present (A2200019)',
      'make sure the SNC product behind /opt/libsapcrypto.so (x64) is logged on',
    ),
    () =>
      authError.snc<'no-credential'>(
        {
          problem: 'no-credential',
          secureLoginClient: false,
          libraryArchs: ['x64'],
        },
        { library: '/opt/libsapcrypto.so' },
      ),
  ],
  // B6 — a refused RFC logon with no key (BasicAuthProvider.rejected)
  [
    key('the logon failed (unknown error)', undefined),
    () => authError['system-refused']({ verdict: 'unknown', at: 'logon' }),
  ],
]);

const untranslated: LegacyRefusal[] = [];

/** The 5.x refusals no row translated since the last drain; empties the list. */
export function drainUntranslated(): LegacyRefusal[] {
  return untranslated.splice(0, untranslated.length);
}

/** Throws, naming the words, when a 5.x refusal outside the table was seen. */
export function failOnUntranslated(): void {
  if (untranslated.length === 0) return;
  const words = untranslated
    .map((r) => (r.hint === undefined ? r.reason : `${r.reason} — ${r.hint}`))
    .join('\n  ');
  throw new Error(
    `5.x refusals outside the legacy table (add a row, Appendix A):\n  ${words}`,
  );
}

// Every suite that loads the adapter, directly or through a helper, fails the
// test in which a refusal fell outside the table. Outside Jest (a probe under
// `scripts/`) there is no test to fail, and nothing is registered.
if (typeof afterEach === 'function') {
  afterEach(() => {
    try {
      failOnUntranslated();
    } finally {
      drainUntranslated();
    }
  });
}

/** A 5.x answer, as an outcome of the error contract. */
function translated(answer: LegacyOutcome, moment: Moment): AuthOutcome {
  const fallback = authError.connection({
    problem: 'provider-threw',
    at: moment,
  });
  if (answer.ok) return classifyOutcome(answer, fallback);
  const { reason, hint } = answer.refusal;
  const row = TRANSLATIONS.get(key(reason, hint));
  if (row === undefined) {
    untranslated.push(hint === undefined ? { reason } : { reason, hint });
    return classifyOutcome(answer, fallback);
  }
  const at = moment === 'prepare' ? undefined : moment;
  return classifyOutcome({ ok: false, refusal: row({ at }) }, fallback);
}

/** A target's answer, as the 5.x `{ reason, hint }` read from the minted error. */
function legacyOutcome(outcome: AuthOutcome): LegacyOutcome {
  if (outcome.ok) return { ok: true };
  const { reason, hint } = outcome.refusal;
  return {
    ok: false,
    refusal: hint === undefined ? { reason } : { reason, hint },
  };
}

function legacyTarget(target: ILogonTarget): LegacyLogonTarget {
  return {
    tlsMaterial: (material) => legacyOutcome(target.tlsMaterial(material)),
    logonParameters: (parameters) =>
      legacyOutcome(target.logonParameters(parameters)),
  };
}

/** A 5.x provider as an `IAuthProvider` of the error contract. */
export function legacyProvider(legacy: LegacyAuthProvider): IAuthProvider {
  return {
    kind: legacy.kind,
    prepare: async () => translated(await legacy.prepare(), 'prepare'),
    establish: async (logon) =>
      translated(await legacy.establish(legacyTarget(logon)), 'logon'),
    authorize: async (request) =>
      translated(await legacy.authorize(request), 'request'),
    rejected: async (rejection) =>
      translated(await legacy.rejected(rejection), rejection.at),
  };
}
