/**
 * The shape check of the auth error contract (rules 4, 5, 6), as `lint:check`
 * runs it: its copy is the canonical one, each fixture is refused by exactly
 * its own rule, a clean file and connection's own source pass.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const SCRIPT = join(ROOT, 'tools', 'check-provider-shape.mjs');

function check(...files: string[]) {
  const run = spawnSync(
    process.execPath,
    [SCRIPT, '--rules', '4,5,6', ...files],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const findings = run.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  return { status: run.status, findings, stderr: run.stderr };
}

describe('the shape check', () => {
  it('R1: tools/ holds a byte-identical copy of the one auth-errors publishes', () => {
    const canonical = readFileSync(
      require.resolve(
        '@mcp-abap-adt/auth-errors/tools/check-provider-shape.mjs',
      ),
    );
    expect(readFileSync(SCRIPT).equals(canonical)).toBe(true);
  });

  it('the site lists are empty: connection asserts no contract type and passes no diagnostics', () => {
    for (const list of ['assertion-sites.json', 'diagnostic-sites.json']) {
      expect(
        JSON.parse(readFileSync(join(ROOT, 'tools', list), 'utf8')),
      ).toStrictEqual([]);
    }
  });

  it.each([
    ['4', 'tools/__fixtures__/rule4.ts'],
    ['5', 'tools/__fixtures__/rule5.ts'],
    ['6', 'tools/__fixtures__/rule6.ts'],
  ])('refuses the rule %s fixture with rule %s alone', (rule, fixture) => {
    const { status, findings, stderr } = check(fixture);

    expect(stderr).toBe('');
    expect(status).toBe(1);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding).toMatch(
        new RegExp(`^${fixture}:\\d+:\\d+: rule ${rule}: `),
      );
    }
  });

  it('passes a file that relays a minted error as it is', () => {
    expect(check('tools/__fixtures__/clean.ts')).toStrictEqual({
      status: 0,
      findings: [],
      stderr: '',
    });
  });

  it("passes connection's own source", () => {
    expect(check()).toStrictEqual({ status: 0, findings: [], stderr: '' });
  });
});
