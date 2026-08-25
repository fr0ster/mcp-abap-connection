#!/usr/bin/env node
/**
 * Checks what would actually be published, because `files` is only half of it.
 *
 * Two defects shipped past every other gate here, one after the other, and both
 * looked innocent from `package.json`: `files` lists `dist`, and it was the
 * COMPILER that decided what `dist` held. First `dist/__tests__/` — the shared
 * connector contract, its fixtures and three helpers — because `tsconfig`
 * excluded only files named `.test.ts`, which is not the same as excluding the
 * test directory. Then `dist/tsconfig.scripts.tsbuildinfo`, 120KB of incremental
 * bookkeeping from a config whose only job was `--noEmit`, because it inherited
 * `composite` and `outDir` from the base.
 *
 * Neither is a documentation problem, a type error or a failing test, so
 * nothing here was looking. This asks npm the one question that matters — what
 * goes in the tarball — and reads the answer.
 */
import { execFileSync } from 'node:child_process';

/** What has no business reaching a consumer, and why it got in before. */
const FORBIDDEN = [
  {
    test: (p) => /(^|\/)__tests__(\/|$)/.test(p),
    why: 'a test file: exclude the test directory in tsconfig, not just *.test.ts',
  },
  {
    test: (p) => p.endsWith('.tsbuildinfo'),
    why: "a compiler's incremental state: set composite/incremental false, or move tsBuildInfoFile out of the published directory",
  },
  {
    test: (p) => p.endsWith('.ts') && !p.endsWith('.d.ts'),
    why: 'a TypeScript source: only the build output ships',
  },
  {
    test: (p) => /(^|\/)\.env|\.env$|(^|\/)\.npmrc$/.test(p),
    why: 'credentials',
  },
  {
    test: (p) => /\.(log|tgz)$/.test(p),
    why: 'a build artifact',
  },
];

/**
 * `npm pack` failing is a finding, not a crash.
 *
 * stderr was discarded here, so a read-only npm cache — or anything else that
 * stops npm before it can answer — surfaced as `Command failed: npm pack
 * --dry-run --json` and nothing else. That is the failure this whole file
 * exists to prevent, in the file itself: a check that could not run, saying
 * nothing about why.
 */
let raw;
try {
  raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (error) {
  const detail = `${error.stderr ?? ''}${error.stdout ?? ''}`.trim();
  console.log('✗ pack — npm could not answer, so nothing was checked');
  for (const line of (detail || String(error.message)).split('\n')) {
    console.log(`    ${line}`);
  }
  process.exit(1);
}

let pack;
try {
  [pack] = JSON.parse(raw);
} catch {
  // npm answered with something that is not the JSON this asked for. Print it:
  // whatever it is, it is the reason, and guessing at it here would hide it.
  console.log('✗ pack — npm answered, but not with the JSON this asked for');
  for (const line of raw.trim().split('\n').slice(0, 10)) {
    console.log(`    ${line}`);
  }
  process.exit(1);
}
const files = pack.files.map((f) => f.path);

const problems = [];
for (const file of files) {
  for (const rule of FORBIDDEN) {
    if (rule.test(file)) problems.push(`${file} — ${rule.why}`);
  }
}

// Stated on every run, pass or fail: the number is the thing a reader can
// sanity-check against the last release, and it only helps if it is always there.
console.log(
  `${problems.length ? '✗' : '✓'} pack — ${pack.entryCount} files, ${Math.round(pack.size / 1024)}KB packed, ${Math.round(pack.unpackedSize / 1024)}KB unpacked`,
);
for (const problem of problems) console.log(`    ${problem}`);
process.exit(problems.length ? 1 : 0);
