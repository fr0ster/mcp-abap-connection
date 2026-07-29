#!/usr/bin/env node
/**
 * Checks the docs against the code, because prose does not compile.
 *
 * Every check exists because something shipped past its absence: an example
 * calling a method removed eight versions earlier, a link to a file that never
 * existed, a quick start that could not run. Two exist because an earlier
 * version of this checker reported success while the defect was on the page —
 * so each one states what it does not cover.
 *
 * Node rather than a shell script with an embedded Python parser: this package
 * requires Node and nothing else, and a checker that adds a language to the
 * requirements is a checker that will not run somewhere.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const problems = [];
const report = (check, detail) => problems.push(`${check}: ${detail}`);

/** Every file under `dir` matching `test`, skipping node_modules. */
function walk(dir, test, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, test, out);
    else if (test(entry)) out.push(relative(root, full));
  }
  return out;
}

const markdown = walk('.', (n) => n.endsWith('.md')).filter(
  (f) => !f.endsWith('CHANGELOG.md'),
);
const examples = existsSync('examples')
  ? walk('examples', (n) => n.endsWith('.js'))
  : [];

/** Fenced code blocks, as { file, line, body }. */
function codeBlocks(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const blocks = [];
  let open = null;
  let buf = [];
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      if (open === null) {
        open = i + 1;
        buf = [];
      } else {
        blocks.push({ file, line: open, body: buf.join('\n') });
        open = null;
      }
    } else if (open !== null) {
      buf.push(line);
    }
  });
  if (open !== null) {
    // An unclosed fence is itself a defect: it desynchronises every parser
    // after it, which is exactly how a broken JWT example hid for months.
    report('fences', `${file}:${open} opens a code fence that is never closed`);
  }
  return blocks;
}

// ---------------------------------------------------------------- check 1 ---
// Covers .js examples AND markdown blocks. The first version read only
// examples/*.js, and a JWT example in USAGE.md sat broken behind a green run.
for (const file of examples) {
  const text = readFileSync(file, 'utf8');
  if (text.includes('makeAdtRequest') && !text.includes('.connect()')) {
    report('connect', `${file} makes a request without connect()`);
  }
}
for (const file of markdown) {
  for (const block of codeBlocks(file)) {
    const builds =
      block.body.includes('createAbapConnection(') ||
      /new \w+AbapConnection\(/.test(block.body);
    if (
      block.body.includes('makeAdtRequest') &&
      builds &&
      !block.body.includes('.connect()')
    ) {
      report(
        'connect',
        `${file}:${block.line} builds a connection and requests without connect()`,
      );
    }
  }
}

// ---------------------------------------------------------------- check 2 ---
// Every method the docs call on a connection must exist in the source.
// Comments are stripped first: an earlier version matched the words "request ("
// inside a doc comment and concluded that a request() method existed, so a
// documented call to a method that does not exist passed the check.
const sources = walk('src/connection', (n) => n.endsWith('.ts'))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');
const called = new Set();
for (const file of [...examples, ...markdown]) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/connection\d*\.([a-zA-Z]+)\(/g)) {
    called.add(m[1]);
  }
}
for (const method of [...called].sort()) {
  // A DECLARATION, not a mention: at the start of a line, optionally preceded
  // by modifiers. `performRequest(` must not vouch for `request()`.
  const declaration = new RegExp(
    `^\\s*(?:(?:public|private|protected|readonly|static|abstract|async|get|set)\\s+)*${method}\\s*[(<]`,
    'm',
  );
  if (!declaration.test(sources)) {
    report(
      'api',
      `${method}() is documented but does not exist in src/connection`,
    );
  }
}

// ---------------------------------------------------------------- check 3 ---
for (const file of markdown) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\]\((\.{0,2}\/?[A-Za-z0-9_/.-]+\.md)/g)) {
    const target = m[1];
    if (!existsSync(join(dirname(file), target)) && !existsSync(target)) {
      report('link', `${file} -> ${target} does not exist`);
    }
  }
}

// ---------------------------------------------------------------- check 4 ---
// The first version matched two exact phrasings and walked past a whole
// "## Version History" section. It matches the SHAPE of a version claim now.
const versionClaim =
  /(Latest version|\*\*Version:\*\*\s*\d|^#+\s*Version History|^-\s*\*\*\d+\.\d+\.\d+\*\*|^#+\s*\d+\.\d+\.\d+)/m;
for (const file of [...markdown, ...examples]) {
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (versionClaim.test(line) && !line.includes('[CHANGELOG')) {
        report(
          'version',
          `${file}:${i + 1} restates a version outside the changelog`,
        );
      }
    });
}

// ---------------------------------------------------------------- check 6 ---
// A link can exist in the repo and still be broken for everyone who installed
// the package: `files` decides what ships, and the README pointed at
// docs/MIGRATION-2.0.md while `files` listed only dist, bin, README and LICENSE.
// Check 3 sees the file on disk and passes. This one asks the other question —
// does the target ship too.
const published = JSON.parse(readFileSync('package.json', 'utf8')).files ?? [];
const ships = (target) =>
  published.some((entry) => target === entry || target.startsWith(`${entry}/`));

for (const file of [...markdown, 'CHANGELOG.md']) {
  if (!ships(file) && file !== 'README.md') continue; // not shipped, not its problem
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\]\((\.{0,2}\/?[A-Za-z0-9_/.-]+\.md)/g)) {
    // Relative to the linking file, then relative to the package root, which is
    // what `files` entries are expressed against.
    const target = relative(root, resolve(dirname(file), m[1]));
    if (!ships(target)) {
      report(
        'ships',
        `${file} -> ${m[1]} is in the repo but not in package.json "files"`,
      );
    }
  }
}

// ---------------------------------------------------------------- check 7 ---
// A bracketed heading with no reference definition renders as literal "[1.5.3]"
// — brackets and all, linking nowhere. Three of them survived years of green
// runs because CHANGELOG.md is excluded from every other check here, being the
// one file allowed to restate versions. It ships now, so it gets one of its own.
{
  const text = readFileSync('CHANGELOG.md', 'utf8');
  const defined = new Set(
    [...text.matchAll(/^\[([^\]]+)\]:/gm)].map((m) => m[1]),
  );
  for (const m of text.matchAll(/^## \[([^\]]+)\]/gm)) {
    if (!defined.has(m[1])) {
      report(
        'refs',
        `CHANGELOG.md heading [${m[1]}] has no reference definition — drop the brackets or add a target`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
const checks = ['connect', 'api', 'link', 'version', 'fences', 'ships', 'refs'];
for (const name of checks) {
  const hits = problems.filter((p) => p.startsWith(`${name}:`));
  console.log(`${hits.length ? '✗' : '✓'} ${name}`);
  for (const hit of hits) console.log(`    ${hit.slice(name.length + 2)}`);
}
process.exit(problems.length ? 1 : 0);
