/**
 * The shape check of the auth error contract (rules 4, 5, 6), run in-process
 * through the module of @mcp-abap-adt/auth-errors: each fixture is refused by
 * exactly its own rule, a clean file and connection's own source pass.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  checkProviderShape,
  reportLines,
  type ShapeCheckOptions,
  type ShapeCheckReport,
  type ShapeFinding,
} from '@mcp-abap-adt/auth-errors/shape-check';
import ts from 'typescript';
import { REPO_ROOT } from './helpers/repoRoot.js';

const ROOT = REPO_ROOT;

/** The whole configuration of the check in this repository. */
const SHAPE_CHECK = {
  typescript: ts,
  rules: [4, 5, 6],
  root: ROOT,
  project: join(ROOT, 'tsconfig.json'),
  sites: join(ROOT, 'tools'),
} as const satisfies ShapeCheckOptions;

function findingsOf(report: ShapeCheckReport): readonly ShapeFinding[] {
  if (report.status !== 'checked') {
    throw new Error(`not checked: ${reportLines(report).join('\n')}`);
  }
  return report.findings;
}

function check(...files: string[]): readonly ShapeFinding[] {
  return findingsOf(
    checkProviderShape({
      ...SHAPE_CHECK,
      files: files.map((file) => join(ROOT, file)),
    }),
  );
}

describe('the shape check', () => {
  it('the site lists are empty: connection asserts no contract type and passes no diagnostics', () => {
    for (const list of ['assertion-sites.json', 'diagnostic-sites.json']) {
      assert.deepStrictEqual(
        JSON.parse(readFileSync(join(ROOT, 'tools', list), 'utf8')),
        [],
      );
    }
  });

  for (const [rule, fixture] of [
    [4, 'tools/__fixtures__/rule4.ts'],
    [5, 'tools/__fixtures__/rule5.ts'],
    [6, 'tools/__fixtures__/rule6.ts'],
  ] as const) {
    it(`refuses the rule ${rule} fixture (${fixture}) with that rule alone`, () => {
      const findings = check(fixture);

      assert.ok(findings.length > 0);
      for (const finding of findings) {
        assert.strictEqual(finding.rule, rule);
        assert.strictEqual(finding.file, fixture);
      }
    });
  }

  it('passes a file that relays a minted error as it is', () => {
    assert.deepStrictEqual(check('tools/__fixtures__/clean.ts'), []);
  });

  it("passes connection's own source", { timeout: 120_000 }, () => {
    assert.deepStrictEqual(
      reportLines(
        checkProviderShape({
          ...SHAPE_CHECK,
        }),
      ),
      [],
    );
  });

  describe('the publishing gate', () => {
    const scripts: Record<string, string> = JSON.parse(
      readFileSync(join(ROOT, 'package.json'), 'utf8'),
    ).scripts;

    it('test:shape runs this test file alone', () => {
      assert.strictEqual(
        scripts['test:shape'],
        'node scripts/run-tests.mjs src/__tests__/shapeCheck.test.ts',
      );
    });

    it('prepublishOnly runs the shape check through test:shape', () => {
      assert.ok(
        scripts.prepublishOnly?.split(' && ').includes('npm run test:shape'),
      );
    });

    it('lint:check is Biome alone: it names no checking script', () => {
      for (const checking of ['node ', 'run-tests', 'test:shape', 'shape']) {
        assert.ok(!scripts['lint:check'].includes(checking));
      }
    });
  });
});
