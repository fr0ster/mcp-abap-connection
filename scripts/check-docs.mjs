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
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ships } from './docs-paths.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const problems = [];
const report = (check, detail) => {
  const line = `${check}: ${detail}`;
  if (!problems.includes(line)) problems.push(line);
};

/**
 * Every file under `dir` matching `test`, skipping node_modules.
 *
 * Paths come back in the host's separator, because that is what every caller
 * hands straight back to the filesystem. Rewriting them to POSIX here would be
 * the checker corrupting its own input: a backslash is a legal character in a
 * POSIX filename, so `docs/we\ird.md` would become `docs/we/ird.md` and the run
 * would die on an ENOENT instead of reporting anything. The two spellings have
 * to meet inside `ships()`, and that is where they are normalised.
 */
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

/** Fenced code blocks, as { file, line, lang, body }. */
function codeBlocks(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const blocks = [];
  let open = null;
  let lang = '';
  let buf = [];
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      if (open === null) {
        open = i + 1;
        lang = (line.match(/^\s*```(\w*)/)?.[1] ?? '').toLowerCase();
        buf = [];
      } else {
        blocks.push({ file, line: open, lang, body: buf.join('\n') });
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

for (const file of [...markdown, 'CHANGELOG.md']) {
  if (!ships(published, file) && file !== 'README.md') continue; // not shipped, not its problem
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\]\((\.{0,2}\/?[A-Za-z0-9_/.-]+\.md)/g)) {
    // Relative to the linking file, then relative to the package root, which is
    // what `files` entries are expressed against.
    const target = relative(root, resolve(dirname(file), m[1]));
    if (!ships(published, target)) {
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

// ---------------------------------------------------------------- check 8 ---
// A connector takes its wire as the THIRD argument, and it is required. Every
// example and every snippet passed a logger there until an outside reader tried
// one: in TypeScript that is a compile error, but `examples/*.js` runs, gets as
// far as connect(), and dies asking a logger for `open()`. Twenty-eight call
// sites across six documents were wrong at once, and every other check here
// passed.
//
// So the shape is checked rather than trusted. Nothing here parses TypeScript —
// it reads the third top-level argument and asks whether it names a wire, which
// is the one thing that went wrong.
function connectorCalls(text) {
  const calls = [];
  for (const m of text.matchAll(/new Adt(?:OnPrem|Cloud)Connector\s*\(/g)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const open = i;
    for (; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
      if (depth === 0) break;
    }
    calls.push({ at: m.index, args: splitTopLevel(text.slice(open + 1, i)) });
  }
  return calls;
}

/** Commas at depth zero, ignoring the ones inside strings and comments. */
function splitTopLevel(text) {
  const args = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
      continue;
    }
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < text.length && text[j] !== quote)
        j += text[j] === '\\' ? 2 : 1;
      cur += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      args.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) args.push(cur);
  return args;
}

const documented = [
  ...markdown.filter((f) => !f.includes('MIGRATION-2.0')),
  ...examples,
].filter(
  // The older migration guides describe the signatures of their own releases,
  // which is what a migration guide is for.
  (f) => !/MIGRATION-[245]\.0\.md$/.test(f),
);

for (const file of documented) {
  const text = readFileSync(file, 'utf8');
  for (const call of connectorCalls(text)) {
    const line = text.slice(0, call.at).split('\n').length;
    const wire = call.args[2]?.trim() ?? '';
    // `new AdtOnPremConnector(...)` naming the class rather than showing a call
    // — a table cell, a sentence — is not a call site and has nothing to check.
    if (call.args.length === 1 && call.args[0].trim() === '...') continue;
    if (!/Transport\b/.test(wire)) {
      report(
        'wire',
        `${file}:${line} builds a connector whose third argument is not a transport: ${
          wire.replace(/\s+/g, ' ').slice(0, 60) || '(missing)'
        }`,
      );
    }
  }
}

// ---------------------------------------------------------------- check 9 ---
/**
 * The documented TypeScript, actually compiled.
 *
 * `wire` above checks the one mistake that shipped: a logger where the
 * transport goes. This checks the general case, because the next drift will not
 * be that one. Every other check reads the docs as text; this one reads them as
 * code, against `dist/` — the surface a consumer installs, not the sources.
 *
 * A document is compiled as a document, top to bottom, the way it is read: its
 * imports are hoisted and merged, and each snippet becomes a function body of
 * its own, so `const connection` may be declared in five snippets without them
 * colliding. A snippet may therefore use what an earlier snippet imported —
 * which is how the page actually works — but a symbol imported NOWHERE on the
 * page is an error, because the reader who copies that block has nothing to
 * paste it into.
 *
 * The check owns THIS package's surface and not the page's narrative. So an
 * unknown name is reported when the package exports it — the page is using our
 * class without ever saying where it comes from — and ignored when it does not,
 * because `connection`, `options` and `yourHttpClient` are things the prose
 * establishes and no compiler can know.
 *
 * What it does not cover, each counted below so the gap is visible rather than
 * silent: snippets written as fragments, with an `...` where code was elided;
 * snippets standing on a package this repo does not install, which cannot be
 * resolved here and are not ours to check. JavaScript examples are not
 * typechecked at all — `node --check` parses them and `wire` reads their call
 * sites.
 */
const PLACEHOLDERS = `import type { SapConfig as _Cfg } from '@mcp-abap-adt/connection';
declare const config: _Cfg & { username: string; password: string };
declare const logger: { debug(m: string): void; info(m: string): void; warn(m: string): void; error(m: string): void };
declare const user: string;
declare const pass: string;
`;

/**
 * What this package declares — the only names the check claims to know.
 *
 * Read from the built types rather than listed here, so a class renamed in the
 * source cannot leave a name behind that the check still believes in.
 */
function declaredNames() {
  const names = new Set();
  for (const file of walk('dist', (n) => n.endsWith('.d.ts'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(
      /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|const|function|interface|type|enum)\s+(\w+)/gm,
    )) {
      names.add(m[1]);
    }
  }
  return names;
}

/** Named imports per module, merged, so two snippets importing one symbol do not redeclare it. */
function hoistImports(snippets) {
  const bare = [];
  const named = new Map();
  const bodies = [];
  for (const snippet of snippets) {
    const lines = snippet.body.split('\n');
    const rest = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^\s*import\b/.test(lines[i])) {
        rest.push(lines[i]);
        continue;
      }
      // An import may wrap over several lines; take it to its semicolon.
      let statement = lines[i];
      while (!statement.includes(';') && i + 1 < lines.length) {
        i += 1;
        statement += `\n${lines[i]}`;
      }
      const match = statement.match(
        /import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/,
      );
      if (!match) {
        bare.push(statement);
        continue;
      }
      const from = match[3];
      if (!named.has(from)) named.set(from, new Set());
      for (const symbol of match[2].split(',')) {
        const name = symbol.trim().replace(/^type\s+/, '');
        if (name) named.get(from).add(name);
      }
    }
    bodies.push({ ...snippet, body: rest.join('\n') });
  }
  const merged = [...named].map(
    ([from, symbols]) =>
      `import { ${[...symbols].join(', ')} } from '${from}';`,
  );
  return { head: [...bare, ...merged].join('\n'), bodies };
}

const ours = existsSync(join('dist', 'index.d.ts'))
  ? declaredNames()
  : new Set();

/**
 * Whether a snippet is this package's to check.
 *
 * Importing us is the obvious half. The other half is a snippet that USES one
 * of our classes while importing nothing — which is not an edge case but the
 * defect itself, and an earlier version of this check, keyed on the import
 * alone, could not see a single snippet in a document that had none.
 */
function usesThisPackage(body) {
  if (/from\s*['"]@mcp-abap-adt\//.test(body)) return true;
  return [...body.matchAll(/\bnew\s+(\w+)|:\s*(\w+)\b/g)].some((m) =>
    ours.has(m[1] ?? m[2]),
  );
}

/** A module the snippet stands on that this repo does not install. */
function unresolvable(body) {
  for (const m of body.matchAll(/from\s*['"]([^'"]+)['"]/g)) {
    const from = m[1];
    if (from.startsWith('@mcp-abap-adt/') || from.startsWith('node:')) continue;
    if (!existsSync(join('node_modules', from))) return from;
  }
  return null;
}

let elided = 0;
let unresolved = 0;
let compiled = 0;
const compilable = new Map();
for (const file of documented.filter((f) => f.endsWith('.md'))) {
  const snippets = codeBlocks(file)
    .filter((b) => b.lang === 'typescript' || b.lang === 'ts')
    .filter((b) => usesThisPackage(b.body))
    .filter((b) => {
      const fragment = /^\s*(\/\/\s*)?\.\.\./m.test(b.body);
      if (fragment) elided += 1;
      return !fragment;
    })
    .filter((b) => {
      const missing = unresolvable(b.body);
      if (missing) unresolved += 1;
      return !missing;
    });
  compiled += snippets.length;
  if (snippets.length) compilable.set(file, snippets);
}

if (!existsSync(join('dist', 'index.d.ts'))) {
  // Reported rather than skipped: a check that quietly passes when it could not
  // run is the failure mode this whole file exists to answer.
  report(
    'types',
    'dist/index.d.ts is missing — run the build before this check',
  );
} else if (compilable.size) {
  const dir = mkdtempSync(join(tmpdir(), 'doc-types-'));
  try {
    const sources = new Map();
    for (const [file, snippets] of compilable) {
      // The page's imports, for the snippets that show none: those are
      // continuations, and the page established the names above them.
      const page = hoistImports(snippets).head;
      snippets.forEach((snippet, i) => {
        // A snippet that shows its OWN import block is claiming to be
        // self-contained, so it is compiled with exactly that block and
        // nothing borrowed. This is the difference that matters: the reader
        // copies one fence, not the page, and a Quick Start importing the
        // connector but not the transport leaves them with a broken paste.
        const declares = /^\s*import\b/m.test(snippet.body);
        const { head, bodies } = hoistImports([snippet]);
        const source = `${PLACEHOLDERS}${declares ? head : page}\n\nasync function _snippet() {\n${bodies[0].body}\n}\n`;
        const name = `${file.replace(/[^\w]/g, '_')}_${i}.ts`;
        writeFileSync(join(dir, name), source);
        // Where the body starts in the generated file, so an error is reported
        // at the line of the document rather than of the scratch file.
        sources.set(name, {
          file,
          start: source.split('\n').indexOf('async function _snippet() {') + 2,
          line: snippet.line,
        });
      });
    }
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'es2022',
          module: 'esnext',
          moduleResolution: 'bundler',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          baseUrl: '.',
          paths: {
            '@mcp-abap-adt/connection': [join(root, 'dist', 'index.d.ts')],
            '@mcp-abap-adt/interfaces': [
              join(root, 'node_modules', '@mcp-abap-adt', 'interfaces'),
            ],
          },
          typeRoots: [join(root, 'node_modules', '@types')],
          types: ['node'],
        },
        include: ['*.ts'],
      }),
    );

    /**
     * Compile, and keep compiling until nothing fails to PARSE.
     *
     * TypeScript checks types only once the whole program parses, so a single
     * malformed snippet turns every other file's semantic errors off — and the
     * check then reports that one line and calls the rest checked. Measured
     * here: one unparseable snippet hid sixty-five real errors, including the
     * missing import this check was written for. So a file that will not parse
     * is reported and then taken out of the program, and the rest are compiled
     * without it.
     */
    const compile = () => {
      try {
        execFileSync(
          process.execPath,
          [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', dir],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        );
        return '';
      } catch (error) {
        return `${error.stdout ?? ''}${error.stderr ?? ''}`;
      }
    };
    const syntactic = /error TS1\d{3}:/;
    const excluded = new Set();
    let output = compile();
    while (output.split('\n').some((l) => syntactic.test(l))) {
      const before = excluded.size;
      for (const line of output.split('\n')) {
        if (!syntactic.test(line)) continue;
        const name = line
          .match(/^(.*\.ts)\(/)?.[1]
          .split(/[\\/]/)
          .pop();
        if (name) excluded.add(name);
      }
      if (excluded.size === before) break; // nothing new to remove; stop rather than spin
      const config = JSON.parse(
        readFileSync(join(dir, 'tsconfig.json'), 'utf8'),
      );
      config.exclude = [...excluded];
      writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(config));
      output = `${output}\n${compile()}`;
    }

    for (const line of output.split('\n')) {
      const match = line.match(
        /^(.*\.ts)\((\d+),(\d+)\): error (TS\d+): (.*)$/,
      );
      if (!match) continue;
      const source = sources.get(match[1].split(/[\\/]/).pop());
      if (!source) continue;
      // A name the page never imported is ours to report only if it IS ours.
      // Otherwise it is something the prose introduced, and the compiler is
      // the wrong thing to ask about it.
      const unknown = match[5].match(/^Cannot find name '(\w+)'/);
      if (unknown && !ours.has(unknown[1])) continue;
      const at = Number(match[2]);
      report(
        'types',
        `${source.file}:${source.line + (at - source.start)} ${match[5]} (${match[4]})`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
const checks = [
  'connect',
  'api',
  'link',
  'version',
  'fences',
  'ships',
  'refs',
  'wire',
  'types',
];
for (const name of checks) {
  const hits = problems.filter((p) => p.startsWith(`${name}:`));
  console.log(`${hits.length ? '✗' : '✓'} ${name}`);
  for (const hit of hits) console.log(`    ${hit.slice(name.length + 2)}`);
  if (name === 'types') {
    // Said out loud on every run, pass or fail: a coverage figure that only
    // appears on failure is one nobody reads until it is too late.
    console.log(
      `    compiled ${compiled} snippet${compiled === 1 ? '' : 's'} in ${compilable.size} document${compilable.size === 1 ? '' : 's'}; skipped ${elided} written as fragments and ${unresolved} standing on a package this repo does not install`,
    );
  }
}
process.exit(problems.length ? 1 : 0);
