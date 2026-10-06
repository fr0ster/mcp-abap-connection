#!/usr/bin/env node
/**
 * The shape check of the MCP ABAP ADT authentication error contract (spec
 * §8.2): the rules TypeScript alone cannot express, decided on the
 * TypeScript compiler API, which needs type information Biome does not have.
 *
 * Canonical copy: `@mcp-abap-adt/auth-errors` publishes this file as it is;
 * every repository that runs it keeps a byte-identical copy in its `tools/`,
 * with a test comparing the two (Decision D4). No dependency but
 * `typescript`, which every repository running it has as a devDependency.
 *
 *   node tools/check-provider-shape.mjs --rules 4,5,6
 *     [--base <module>#AuthProviderBase]
 *                          the base, by declaration — required by rules 1–3
 *     [--root <dir>]       the repository root (default: the working directory)
 *     [--project <file>]   its tsconfig (default: <root>/tsconfig.json)
 *     [--sites <dir>]      where assertion-sites.json and
 *                          diagnostic-sites.json live (default: <root>/tools)
 *     [files…]             check these files instead of the project's
 *
 * Without files it checks every file of the project under `<root>/src`,
 * outside tests (`__tests__`, `__typechecks__`, `__fixtures__`, `__mocks__`,
 * `*.test.ts`, `*.spec.ts`) and declarations. Each finding is one line on
 * stdout, `<file>:<line>:<column>: rule <n>: <what>`, the file relative to
 * the root. Exit 0: nothing found; 1: findings; 2, reported on stderr: a
 * usage error, a file given that does not exist, nothing to check, a
 * program that does not type-check (the rules read types, so they are not
 * decided on a broken program), or rules 4 / 5 asked for while the brands of
 * interfaces-auth 6.0.0 or later are not found (they would pass in silence),
 * or rules 1–3 asked for without a `--base` that resolves to a class.
 *
 * **The base is named by declaration.** `--base <module>#<export>` names the
 * repository's `AuthProviderBase`: `<module>` is a path relative to the root
 * (`./src/auth/AuthProviderBase`, the extension optional) or a package
 * specifier resolved as the compiler resolves it from the root
 * (`@mcp-abap-adt/auth-providers`); `<export>` is the class's export name.
 * A class reaches the base only if a class it extends is that declaration; a
 * class of the same name elsewhere — in a file of the same name too —
 * exempts nothing. The base itself is verified under rule 1: each of its
 * four moments must be one method whose body is only
 * `return guard(this.#moments.<moment>, () => …, () => …)`, the callee
 * auth-errors' `guard`, no constructor parameter property may be named after
 * a moment, and no write may replace a moment: `this.<moment> = …` (a
 * computed key from a constant, through assertions, included) in the base,
 * `AuthProviderBase.prototype.<moment> = …`, and `Object.assign` /
 * `Object.defineProperty` of a moment onto the base's `this` or prototype —
 * in any checked file, and in the base's own file whatever files were
 * selected. A base read from a declaration file has no bodies:
 * there only the four methods are required, and the bodies are verified
 * where the base is written (auth-providers runs rules 1–3 on its source).
 *
 * The rules (§8.2), each selected by its number:
 *   1  a class that implements IAuthProvider, other than AuthProviderBase —
 *      by an `implements` clause, or structurally (its instances satisfy
 *      IAuthProvider) without reaching AuthProviderBase; a moment of the
 *      base itself that does more than delegate to guard;
 *   2  a class reaching AuthProviderBase that declares, or assigns to `this`,
 *      a member named prepare, establish, authorize or rejected (a computed
 *      name folded from its literal type); an assignment of one to `this` or
 *      to `X.prototype` of such a class, through parentheses and assertions
 *      (`(this as any)[NAME] = …`); `Object.assign` or
 *      `Object.defineProperty` writing one onto `this` of such a class or
 *      onto its `prototype`;
 *   3  an object literal that satisfies IAuthProvider;
 *   4  a type assertion whose target is or contains an error, a refusal, an
 *      outcome, a failure or a branded integer of the contract, outside the
 *      sites of assertion-sites.json; an overload signature (or a body-less
 *      `declare function`) whose return type is or contains an error, a
 *      refusal, an outcome or a failure, outside auth-errors' own builders.ts
 *      and mint.ts (an overload is a cast in disguise);
 *   5  an object spread, or an `Object.assign` argument, typed as an error;
 *   6  a builder call with a diagnostics argument whose fields are not each
 *      listed, for that file and function, in diagnostic-sites.json; a
 *      builder reached through call / apply / bind;
 *   7  a `guard` call whose grant is not a function expression, whose
 *      arguments are spread, or whose argument list reads `this` (outside
 *      a function expression) other than `this.#moments`; `guard` reached
 *      through call / apply / bind;
 *   8  in src/auth and src/providers (spec §6, C12): a `Basic ` authorization
 *      value, or a base64 encoding (`toString('base64' | 'base64url')`,
 *      `btoa`) of a value built from a client secret, outside `legacyBasic`
 *      (src/auth/tokenRequest.ts) and `clientSecretBasic`
 *      (src/clientAuthentication/clientSecret.ts). A Basic value is a string
 *      that is `Basic ` (any case) alone — a template head, a constant, a
 *      string joined later — or `Basic` alone, or `Basic` and a literal
 *      base64 credential; prose naming Basic is not one. "Built from a client
 *      secret" is a heuristic: an identifier or key named `secret`,
 *      `…_secret` or `…Secret`, following same-file variable initialisers.
 *      A hash or HMAC of a secret is not a reversible form of it, so not
 *      reported.
 *
 * A site list is a JSON array: assertion-sites.json of `{ file, function }`,
 * diagnostic-sites.json of `{ file, function, field }`, `file` relative to the
 * root. A missing list is an empty one. The function of a node is the
 * nearest enclosing named function: a function declaration, a method, an
 * accessor, or a function expression or arrow assigned to a variable or a
 * property.
 *
 * Limits — what the check does not see (each would need data flow or a
 * second type system, and none is a pattern the repositories write):
 *   - rule 1: a provider built by a mixin returning an anonymous class;
 *   - rule 2: `Object.defineProperties`, an `Object.assign` / `defineProperty`
 *     reached through an alias, a write through an alias of `this` or of the
 *     prototype (`const p = X.prototype; p.prepare = …`), a member name or
 *     key not folded to a literal (a `string` variable);
 *   - rule 3: an object built by `Object.create` or `Object.assign` of partial
 *     literals and returned as IAuthProvider;
 *   - rule 4: an unconstrained generic cast helper
 *     (`<T>(x: unknown): T => x as T`, then `cast<IAuthProviderError>(x)`), a
 *     value of type `any` assigned without an assertion, a JSDoc cast in a
 *     checked `.js` file;
 *   - rule 5: `Object.assign` through an alias (`const assign =
 *     Object.assign`, `Object['assign']`), `structuredClone` of an error;
 *   - rules 6 and 7: `Reflect.apply` of a builder or of `guard`; in rule 7, a
 *     provider property read before the call (`const self = this`,
 *     `const op = this.op`, then `guard(op, …)`);
 *   - rule 8: a `Basic ` value assembled from pieces (`'Ba' + 'sic '`), a
 *     lowercase `basic` with no space after it (it is also an auth type's
 *     name), `toString(encoding)` with the encoding in a variable, a secret
 *     under a name the heuristic does not know, axios's `auth: { username,
 *     password }` option (axios writes that Basic header itself).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const USAGE =
  'usage: check-provider-shape.mjs --rules <n,…> [--base <module>#AuthProviderBase] [--root <dir>] [--project <tsconfig>] [--sites <dir>] [files…]';
const KNOWN_RULES = new Set([1, 2, 3, 4, 5, 6, 7, 8]);
const INTERFACES_AUTH = '@mcp-abap-adt/interfaces-auth';
const AUTH_ERRORS = '@mcp-abap-adt/auth-errors';
const MOMENTS = new Set(['prepare', 'establish', 'authorize', 'rejected']);
const BASE = 'AuthProviderBase';
/** The brands of interfaces-auth: unexported unique symbols, by declared name. */
const ERROR_BRAND = 'minted';
/** Rule 4's overloads: an error, a refusal, an outcome or a failure (§8.2). */
const ERROR_BRANDS = new Set([ERROR_BRAND]);
const BRANDS = new Set([
  ERROR_BRAND,
  'httpStatusBrand',
  'countBrand',
  'portBrand',
]);
/** Rule 4: the files of auth-errors whose overloads are the builders' own. */
const OVERLOAD_FILES = new Set(['src/builders.ts', 'src/mint.ts']);
/** Rule 8: where it applies, and its two sites. */
const BASIC_SCOPE = ['src/auth/', 'src/providers/'];
const BASIC_SITES = [
  { file: 'src/auth/tokenRequest.ts', function: 'legacyBasic' },
  {
    file: 'src/clientAuthentication/clientSecret.ts',
    function: 'clientSecretBasic',
  },
];
const MAX_DEPTH = 8;

// ---------------------------------------------------------------- arguments

function fail(message) {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(2);
}

function parseArguments(argv) {
  const options = { files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (
      arg === '--rules' ||
      arg === '--base' ||
      arg === '--root' ||
      arg === '--project' ||
      arg === '--sites'
    ) {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} needs a value`);
      options[arg.slice(2)] = value;
      i += 1;
    } else if (arg.startsWith('--')) {
      fail(`unknown option ${arg}`);
    } else {
      options.files.push(arg);
    }
  }
  if (options.rules === undefined) fail('--rules is required');
  const rules = new Set();
  for (const part of options.rules.split(',')) {
    const rule = Number(part.trim());
    if (!KNOWN_RULES.has(rule)) fail(`unknown rule ${part}`);
    rules.add(rule);
  }
  const root = resolve(options.root ?? process.cwd());
  let base;
  if (options.base !== undefined) {
    const at = options.base.lastIndexOf('#');
    if (at <= 0 || at === options.base.length - 1) {
      fail(`--base must be <module>#<export>: ${options.base}`);
    }
    base = {
      spec: options.base,
      module: options.base.slice(0, at),
      name: options.base.slice(at + 1),
    };
  } else if (rules.has(1) || rules.has(2) || rules.has(3)) {
    fail(
      'rules 1, 2 and 3 need --base <module>#AuthProviderBase: the base, by declaration',
    );
  }
  return {
    rules,
    base,
    root,
    project: resolve(options.project ?? join(root, 'tsconfig.json')),
    sites: resolve(options.sites ?? join(root, 'tools')),
    files: options.files.map((file) => resolve(file)),
  };
}

function readSites(dir, name, keys) {
  const path = join(dir, name);
  if (!existsSync(path)) return [];
  let list;
  try {
    list = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`${path} is not JSON`);
  }
  if (!Array.isArray(list)) fail(`${path} is not an array`);
  for (const entry of list) {
    for (const key of keys) {
      if (typeof entry?.[key] !== 'string')
        fail(`${path}: every entry needs a string ${key}`);
    }
  }
  return list;
}

// ---------------------------------------------------------------- program

const STRICT_DEFAULTS = {
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.Node16,
  moduleResolution: ts.ModuleResolutionKind.Node16,
  esModuleInterop: true,
  skipLibCheck: true,
};

function isTestPath(path) {
  return (
    /(^|\/)(__tests__|__typechecks__|__fixtures__|__mocks__)\//.test(path) ||
    /\.(test|spec)\.[cm]?tsx?$/.test(path) ||
    /\.d\.[cm]?ts$/.test(path)
  );
}

function loadProgram(options) {
  let compilerOptions = { ...STRICT_DEFAULTS };
  let projectFiles = [];
  if (existsSync(options.project)) {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      options.project,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) =>
          fail(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
      },
    );
    if (parsed === undefined) fail(`cannot read ${options.project}`);
    if (parsed.errors.length > 0) {
      fail(ts.formatDiagnostics(parsed.errors, formatHost(options.root)));
    }
    compilerOptions = parsed.options;
    projectFiles = parsed.fileNames;
  } else if (options.files.length === 0) {
    projectFiles = ts.sys.readDirectory(join(options.root, 'src'), [
      '.ts',
      '.tsx',
      '.mts',
      '.cts',
    ]);
  }
  const checked = (options.files.length > 0 ? options.files : projectFiles)
    .map((file) => resolve(file))
    .filter((file) => {
      if (options.files.length > 0) return true;
      const path = rel(options.root, file);
      return path.startsWith('src/') && !isTestPath(path);
    });
  for (const file of options.files) {
    if (!existsSync(file)) fail(`no such file: ${file}`);
  }
  if (checked.length === 0) {
    fail(`no file to check under ${join(options.root, 'src')}`);
  }
  const roots = [...checked];
  let baseFile;
  if (options.base !== undefined) {
    baseFile = resolveBase(options.base.module, options.root, compilerOptions);
    if (baseFile === undefined) {
      fail(
        `--base: ${options.base.module} does not resolve from ${options.root}`,
      );
    }
    roots.push(baseFile);
  }
  const contract = resolveModule(
    INTERFACES_AUTH,
    options.root,
    compilerOptions,
  );
  if (contract !== undefined) roots.push(contract);
  const program = ts.createProgram(roots, {
    ...compilerOptions,
    noEmit: true,
    composite: false,
    incremental: false,
    declaration: false,
    declarationMap: false,
    tsBuildInfoFile: undefined,
  });
  const sources = checked
    .map((file) => program.getSourceFile(file))
    .filter((source) => source !== undefined);
  const diagnostics = sources.flatMap((source) => [
    ...program.getSyntacticDiagnostics(source),
    ...program.getSemanticDiagnostics(source),
  ]);
  if (diagnostics.length > 0) {
    process.stderr.write(
      `the shape check needs a program that type-checks:\n${ts.formatDiagnostics(diagnostics, formatHost(options.root))}`,
    );
    process.exit(2);
  }
  if (sources.length !== checked.length)
    fail('a file to check is not in the program');
  if (options.rules.has(4) || options.rules.has(5)) requireBrands(program);
  return { program, sources, contract, baseFile };
}

/** `--base`'s module: a path relative to the root, or a package specifier. */
function resolveBase(module, root, compilerOptions) {
  if (module.startsWith('./') || module.startsWith('../')) {
    const plain = resolve(root, module);
    const stem = plain.replace(/\.[cm]?js$/, '');
    const candidates = [
      plain,
      ...['.ts', '.tsx', '.mts', '.cts', '.d.ts'].map((ext) => stem + ext),
      join(plain, 'index.ts'),
      join(plain, 'index.d.ts'),
    ];
    return candidates.find(
      (file) => existsSync(file) && statSync(file).isFile(),
    );
  }
  return resolveModule(module, root, compilerOptions);
}

/**
 * Rules 4 and 5 recognise the contract's types by the brands interfaces-auth
 * declares; without every brand they would pass in silence (an
 * interfaces-auth before 6.0.0, a brand renamed), so the check refuses.
 */
function requireBrands(program) {
  const found = new Set();
  for (const source of program.getSourceFiles()) {
    if (packageOf(source.fileName).name !== INTERFACES_AUTH) continue;
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          BRANDS.has(declaration.name.text) &&
          declaration.type !== undefined &&
          ts.isTypeOperatorNode(declaration.type) &&
          declaration.type.operator === ts.SyntaxKind.UniqueKeyword
        ) {
          found.add(declaration.name.text);
        }
      }
    }
  }
  const missing = [...BRANDS].filter((brand) => !found.has(brand));
  if (missing.length > 0) {
    fail(
      `rules 4 and 5 need the brands of ${INTERFACES_AUTH} 6.0.0 or later; not found: ${missing.join(', ')}`,
    );
  }
}

function resolveModule(name, root, compilerOptions) {
  const resolved = ts.resolveModuleName(
    name,
    join(root, '__shape-check__.ts'),
    compilerOptions,
    ts.sys,
  ).resolvedModule;
  return resolved?.resolvedFileName;
}

function formatHost(root) {
  return {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => root,
    getNewLine: () => '\n',
  };
}

function rel(root, file) {
  return relative(root, file).split(sep).join('/');
}

// ---------------------------------------------------------------- packages

const packageCache = new Map();

/** The nearest package.json above `file`: its name and its directory. */
function packageOf(file) {
  let dir = dirname(file);
  const visited = [];
  while (true) {
    const cached = packageCache.get(dir);
    if (cached !== undefined) {
      for (const seen of visited) packageCache.set(seen, cached);
      return cached;
    }
    visited.push(dir);
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      let name;
      try {
        name = JSON.parse(readFileSync(manifest, 'utf8')).name;
      } catch {
        name = undefined;
      }
      const found = { name: typeof name === 'string' ? name : undefined, dir };
      for (const seen of visited) packageCache.set(seen, found);
      return found;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      const none = { name: undefined, dir };
      for (const seen of visited) packageCache.set(seen, none);
      return none;
    }
    dir = parent;
  }
}

function inPackage(node, name) {
  return packageOf(node.getSourceFile().fileName).name === name;
}

/** Whether `file` is auth-errors' module `base`, from source or built. */
function isAuthErrorsModule(file, base) {
  const pkg = packageOf(file);
  if (pkg.name !== AUTH_ERRORS) return false;
  const path = rel(pkg.dir, file);
  return path === `src/${base}.ts` || path === `dist/${base}.d.ts`;
}

// ---------------------------------------------------------------- the checker

function createRules(program, contractFile, baseFile, options, sites) {
  const checker = program.getTypeChecker();
  const findings = [];

  function report(node, rule, what) {
    const source = node.getSourceFile();
    const { line, character } = source.getLineAndCharacterOfPosition(
      node.getStart(source),
    );
    findings.push({
      file: rel(options.root, source.fileName),
      line: line + 1,
      column: character + 1,
      rule,
      what,
    });
  }

  // The contract's IAuthProvider, for rules 1 and 3.
  let providerType;
  if (contractFile !== undefined) {
    const source = program.getSourceFile(contractFile);
    const moduleSymbol = source && checker.getSymbolAtLocation(source);
    const exported =
      moduleSymbol &&
      checker
        .getExportsOfModule(moduleSymbol)
        .find((s) => s.name === 'IAuthProvider');
    if (exported !== undefined) {
      const target =
        exported.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(exported)
          : exported;
      providerType = checker.getDeclaredTypeOfSymbol(target);
    }
  }
  if (
    providerType === undefined &&
    (options.rules.has(1) || options.rules.has(3))
  ) {
    fail(
      `rules 1 and 3 need ${INTERFACES_AUTH}, which does not resolve from ${options.root}`,
    );
  }

  // The base named by --base, by declaration (rules 1–3).
  const baseDeclarations = new Set();
  if (baseFile !== undefined) {
    const { spec, name } = options.base;
    const source = program.getSourceFile(baseFile);
    const moduleSymbol = source && checker.getSymbolAtLocation(source);
    if (moduleSymbol === undefined) fail(`--base: ${spec} is not a module`);
    let exported = checker
      .getExportsOfModule(moduleSymbol)
      .find((symbol) => symbol.name === name);
    if (exported === undefined) fail(`--base: ${spec} exports no ${name}`);
    if (exported.flags & ts.SymbolFlags.Alias) {
      exported = checker.getAliasedSymbol(exported);
    }
    for (const declaration of exported.declarations ?? []) {
      if (ts.isClassDeclaration(declaration)) baseDeclarations.add(declaration);
    }
    if (baseDeclarations.size === 0) {
      fail(`--base: ${name} of ${spec} is not a class`);
    }
  }

  function declaredIn(symbol, name) {
    return (symbol?.declarations ?? []).some((declaration) =>
      inPackage(declaration, name),
    );
  }

  /** The name of the brand `property` carries, if it is one of interfaces-auth's. */
  function brandOf(property) {
    for (const declaration of property.declarations ?? []) {
      const name = declaration.name;
      if (
        name !== undefined &&
        ts.isComputedPropertyName(name) &&
        ts.isIdentifier(name.expression) &&
        BRANDS.has(name.expression.text) &&
        inPackage(declaration, INTERFACES_AUTH)
      ) {
        return name.expression.text;
      }
    }
    return undefined;
  }

  /** Whether the members of `type` are worth walking: not a library's own. */
  function ownMembers(type) {
    const symbol = type.getSymbol();
    const declarations = symbol?.declarations ?? [];
    if (declarations.length === 0) return true;
    return declarations.some((declaration) => {
      const source = declaration.getSourceFile();
      if (program.isSourceFileDefaultLibrary(source)) return false;
      // The compiler's file names use `/` on every platform.
      if (!source.fileName.includes('/node_modules/')) return true;
      const pkg = packageOf(source.fileName).name;
      return pkg === INTERFACES_AUTH || pkg === AUTH_ERRORS;
    });
  }

  /**
   * Whether `type` is or contains a type carrying one of `brands` — the
   * brands of interfaces-auth: an error's (and so a refusal's, an outcome's
   * and a failure's), a branded integer's — reached through unions,
   * intersections, type arguments, constraints (of a type parameter, a
   * conditional, an indexed access), properties and signature returns. Members of a
   * library's own types (outside interfaces-auth and auth-errors) are not
   * walked; its type arguments are.
   */
  function containsContract(type, brands) {
    // The shallowest depth each type was walked at: a type first met near
    // the cut-off is walked again when met higher, where its members fit.
    const walked = new Map();
    const walk = (current, depth) => {
      if (current === undefined || depth > MAX_DEPTH) return false;
      const before = walked.get(current);
      if (before !== undefined && before <= depth) return false;
      walked.set(current, depth);
      // A type parameter, a conditional or an indexed access: its constraint.
      if (current.flags & ts.TypeFlags.Instantiable) {
        return walk(checker.getBaseConstraintOfType(current), depth + 1);
      }
      if (current.isUnionOrIntersection()) {
        return current.types.some((member) => walk(member, depth + 1));
      }
      if (!(current.flags & ts.TypeFlags.Object)) return false;
      if (current.objectFlags & ts.ObjectFlags.Reference) {
        if (
          checker
            .getTypeArguments(current)
            .some((argument) => walk(argument, depth + 1))
        )
          return true;
      }
      if (
        current.aliasTypeArguments?.some((argument) =>
          walk(argument, depth + 1),
        )
      )
        return true;
      if (!ownMembers(current)) return false;
      for (const property of checker.getPropertiesOfType(current)) {
        if (brands.has(brandOf(property))) return true;
        if (walk(checker.getTypeOfSymbol(property), depth + 1)) return true;
      }
      for (const signature of [
        ...current.getCallSignatures(),
        ...current.getConstructSignatures(),
      ]) {
        if (walk(checker.getReturnTypeOfSignature(signature), depth + 1))
          return true;
      }
      return false;
    };
    return walk(type, 0);
  }

  /** Whether `type` is an error of the contract (not merely holds one). */
  function isErrorType(type) {
    const seen = new Set();
    const walk = (current) => {
      if (current === undefined || seen.has(current)) return false;
      seen.add(current);
      if (current.flags & ts.TypeFlags.Instantiable)
        return walk(checker.getBaseConstraintOfType(current));
      if (current.isUnion()) return current.types.some(walk);
      if (current.isIntersection() && current.types.some(walk)) return true;
      return checker
        .getPropertiesOfType(current)
        .some((property) => brandOf(property) === ERROR_BRAND);
    };
    return walk(type);
  }

  function nameOf(name) {
    if (name === undefined) return undefined;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
    if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))
      return name.text;
    if (
      ts.isComputedPropertyName(name) &&
      ts.isStringLiteralLike(name.expression)
    ) {
      return name.expression.text;
    }
    return undefined;
  }

  /** The nearest enclosing named function of `node`. */
  function functionOf(node) {
    for (
      let current = node.parent;
      current !== undefined;
      current = current.parent
    ) {
      if (
        ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current)
      ) {
        const name = nameOf(current.name);
        if (name !== undefined) return name;
      }
      if (ts.isConstructorDeclaration(current)) return 'constructor';
      if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
        if (current.name !== undefined) return current.name.text;
        const holder = current.parent;
        if (
          (ts.isVariableDeclaration(holder) ||
            ts.isPropertyAssignment(holder) ||
            ts.isPropertyDeclaration(holder)) &&
          holder.initializer === current
        ) {
          const name = nameOf(holder.name);
          if (name !== undefined) return name;
        }
      }
    }
    return undefined;
  }

  function isSite(node, list) {
    const file = rel(options.root, node.getSourceFile().fileName);
    const fn = functionOf(node);
    return (
      fn !== undefined &&
      list.some((site) => site.file === file && site.function === fn)
    );
  }

  function skipParentheses(node) {
    return ts.skipParentheses(node);
  }

  // ------------------------------------------------------------ classes

  function isBaseClass(declaration) {
    return baseDeclarations.has(declaration);
  }

  /** Whether the class declared by `node` has AuthProviderBase among its ancestors. */
  /** The symbol of the class `node` declares, named or not. */
  function classSymbol(node) {
    return node.name !== undefined
      ? checker.getSymbolAtLocation(node.name)
      : checker.getTypeAtLocation(node).getSymbol();
  }

  /** A member's name, a computed one folded from its literal type. */
  function memberName(name) {
    if (name !== undefined && ts.isComputedPropertyName(name)) {
      return keyOf(name.expression);
    }
    return nameOf(name);
  }

  /** The string an expression used as a key is typed as, if a literal. */
  function keyOf(expression) {
    if (expression === undefined) return undefined;
    const type = checker.getTypeAtLocation(expression);
    return type.isStringLiteral() ? type.value : undefined;
  }

  function reachesBase(node) {
    const symbol = classSymbol(node);
    if (symbol === undefined) return false;
    const seen = new Set();
    const walk = (type) => {
      if (type === undefined || seen.has(type)) return false;
      seen.add(type);
      for (const base of checker.getBaseTypes(type)) {
        const target =
          base.objectFlags & ts.ObjectFlags.Reference ? base.target : base;
        const declarations = target.getSymbol()?.declarations ?? [];
        if (declarations.some(isBaseClass)) return true;
        if (target.isClassOrInterface() && walk(target)) return true;
        if (base.isIntersection()) {
          for (const member of base.types) {
            if ((member.getSymbol()?.declarations ?? []).some(isBaseClass))
              return true;
            if (member.isClassOrInterface() && walk(member)) return true;
          }
        }
      }
      return false;
    };
    const type = checker.getDeclaredTypeOfSymbol(symbol);
    return type.isClassOrInterface() ? walk(type) : false;
  }

  function isProviderInterface(type) {
    const seen = new Set();
    const walk = (current) => {
      if (current === undefined || seen.has(current)) return false;
      seen.add(current);
      const target =
        current.objectFlags & ts.ObjectFlags.Reference
          ? current.target
          : current;
      if (target === providerType) return true;
      const symbol = target.getSymbol();
      if (
        symbol?.name === 'IAuthProvider' &&
        declaredIn(symbol, INTERFACES_AUTH)
      )
        return true;
      if (target.isClassOrInterface())
        return checker.getBaseTypes(target).some(walk);
      if (current.isUnionOrIntersection()) return current.types.some(walk);
      return false;
    };
    return walk(type);
  }

  function checkClass(node) {
    const isBase = isBaseClass(node);
    const reaches = !isBase && reachesBase(node);
    if (options.rules.has(1) && !isBase) {
      const implementsProvider = (node.heritageClauses ?? [])
        .filter((clause) => clause.token === ts.SyntaxKind.ImplementsKeyword)
        .flatMap((clause) => clause.types)
        .find((expression) =>
          isProviderInterface(checker.getTypeAtLocation(expression)),
        );
      if (implementsProvider !== undefined) {
        report(
          implementsProvider,
          1,
          reaches
            ? `drop \`implements IAuthProvider\`: ${BASE} already implements it`
            : `a class implements IAuthProvider; a provider extends ${BASE}`,
        );
      } else if (!reaches && providerType !== undefined && !isAbstract(node)) {
        const symbol = classSymbol(node);
        const instance =
          symbol === undefined
            ? undefined
            : checker.getDeclaredTypeOfSymbol(symbol);
        if (
          instance !== undefined &&
          instance.flags & ts.TypeFlags.Object &&
          checker.isTypeAssignableTo(instance, providerType)
        ) {
          report(
            node.name ?? node,
            1,
            `a class satisfies IAuthProvider without extending ${BASE}`,
          );
        }
      }
    }
    if (options.rules.has(2) && reaches) {
      for (const member of node.members) {
        const name = memberName(member.name);
        if (name !== undefined && MOMENTS.has(name)) {
          report(
            member,
            2,
            `a class reaching ${BASE} declares ${name}; ${BASE} owns the four methods`,
          );
        }
        if (ts.isConstructorDeclaration(member)) {
          for (const parameter of member.parameters) {
            const parameterName = nameOf(parameter.name);
            if (
              parameterName !== undefined &&
              MOMENTS.has(parameterName) &&
              ts.getModifiers(parameter)?.some(isParameterPropertyModifier)
            ) {
              report(
                parameter,
                2,
                `a class reaching ${BASE} declares ${parameterName}; ${BASE} owns the four methods`,
              );
            }
          }
        }
      }
    }
  }

  /** `node` without parentheses, `as`, `<T>`, `!` or `satisfies` around it. */
  function unwrap(node) {
    let current = node;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  }

  /** Whether the base's own writes are checked: any of rules 1–3. */
  function checksBase() {
    return options.rules.has(1) || options.rules.has(2) || options.rules.has(3);
  }

  /**
   * Where a moment written onto `target` lands: `'base'` (the base named by
   * --base — reported under rule 1, its verification), `'provider'` (a class
   * reaching it — rule 2), or undefined. Each only when its rule runs.
   */
  function momentTarget(target) {
    const kind = targetKind(target);
    if (baseWritesOnly)
      return kind === 'base' && checksBase() ? 'base' : undefined;
    if (kind === 'base') return checksBase() ? 'base' : undefined;
    if (kind === 'provider')
      return options.rules.has(2) ? 'provider' : undefined;
    return undefined;
  }

  /** Reports a moment written onto the base or a class reaching it. */
  function reportWrite(node, where, baseWhat, providerWhat) {
    if (where === 'base') {
      report(node, 1, `${baseWhat}; its moments only delegate to guard`);
    } else {
      report(node, 2, `${providerWhat}; ${BASE} owns the four methods`);
    }
  }

  /**
   * Rules 1 (the base) and 2 through an assignment: `this.<moment> = …` in
   * the base or a class reaching it, or `X.prototype.<moment> = …` of one —
   * `this` or the target unwrapped of parentheses and assertions, a computed
   * key folded from its literal type (`(this as any)[NAME]`,
   * `X.prototype[NAME]`).
   */
  function checkMomentAssignment(node) {
    const kind = node.operatorToken.kind;
    if (
      kind < ts.SyntaxKind.FirstAssignment ||
      kind > ts.SyntaxKind.LastAssignment
    )
      return;
    const target = unwrap(node.left);
    if (
      !ts.isPropertyAccessExpression(target) &&
      !ts.isElementAccessExpression(target)
    )
      return;
    const name = ts.isPropertyAccessExpression(target)
      ? target.name.text
      : keyOf(target.argumentExpression);
    if (name === undefined || !MOMENTS.has(name)) return;
    const owner = unwrap(target.expression);
    const where = momentTarget(owner);
    if (where === undefined) return;
    const written =
      owner.kind === ts.SyntaxKind.ThisKeyword
        ? `this.${name}`
        : `${owner.getText()}.${name}`;
    reportWrite(
      node,
      where,
      `${BASE} assigns ${written}`,
      `a class reaching ${BASE} assigns ${written}`,
    );
  }

  /**
   * Rules 1 (the base) and 2 through a call: `Object.assign` or
   * `Object.defineProperty` onto `this` of the base or a class reaching it,
   * or onto `X.prototype` of one, with a moment's key.
   */
  function checkMomentCall(node) {
    const method = globalObjectMethod(node);
    if (method !== 'assign' && method !== 'defineProperty') return;
    const target = node.arguments[0];
    if (target === undefined) return;
    const where = momentTarget(unwrap(target));
    if (where === undefined) return;
    const names =
      method === 'defineProperty'
        ? [keyOf(node.arguments[1])]
        : node.arguments.slice(1).flatMap((argument) => {
            const source = ts.isSpreadElement(argument)
              ? argument.expression
              : argument;
            return checker
              .getPropertiesOfType(checker.getTypeAtLocation(source))
              .map((property) => property.name);
          });
    const moment = names.find(
      (name) => name !== undefined && MOMENTS.has(name),
    );
    if (moment !== undefined) {
      reportWrite(
        node,
        where,
        `Object.${method} writes ${moment} onto ${BASE}`,
        `Object.${method} writes ${moment} onto a class reaching ${BASE}`,
      );
    }
  }

  /** What a class declaration is: the base, one reaching it, or neither. */
  function classKind(declaration) {
    if (isBaseClass(declaration)) return 'base';
    return ts.isClassLike(declaration) && reachesBase(declaration)
      ? 'provider'
      : undefined;
  }

  /** `this` inside the base or a class reaching it, or `X.prototype` of one. */
  function targetKind(target) {
    if (target.kind === ts.SyntaxKind.ThisKeyword) {
      const owner = ts.findAncestor(target, ts.isClassLike);
      return owner === undefined ? undefined : classKind(owner);
    }
    if (
      ts.isPropertyAccessExpression(target) &&
      target.name.text === 'prototype'
    ) {
      const symbol = checker.getSymbolAtLocation(unwrap(target.expression));
      const resolved =
        symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(symbol)
          : symbol;
      const kinds = (resolved?.declarations ?? []).map(classKind);
      if (kinds.includes('base')) return 'base';
      if (kinds.includes('provider')) return 'provider';
    }
    return undefined;
  }

  function isAbstract(node) {
    return (
      ts
        .getModifiers(node)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.AbstractKeyword) ??
      false
    );
  }

  function isParameterPropertyModifier(modifier) {
    return (
      modifier.kind === ts.SyntaxKind.PublicKeyword ||
      modifier.kind === ts.SyntaxKind.ProtectedKeyword ||
      modifier.kind === ts.SyntaxKind.PrivateKeyword ||
      modifier.kind === ts.SyntaxKind.ReadonlyKeyword ||
      modifier.kind === ts.SyntaxKind.OverrideKeyword
    );
  }

  // ------------------------------------------------------------ rule 3

  function checkObjectLiteral(node) {
    if (!options.rules.has(3) || providerType === undefined) return;
    const type = checker.getTypeAtLocation(node);
    if (checker.isTypeAssignableTo(type, providerType)) {
      report(
        node,
        3,
        `an object literal satisfies IAuthProvider; a provider is a class extending ${BASE}`,
      );
    }
  }

  // ------------------------------------------------------------ rule 4

  function checkAssertion(node) {
    if (!options.rules.has(4)) return;
    const typeNode = node.type;
    if (
      ts.isTypeReferenceNode(typeNode) &&
      ts.isIdentifier(typeNode.typeName) &&
      typeNode.typeName.text === 'const'
    ) {
      return;
    }
    if (!containsContract(checker.getTypeFromTypeNode(typeNode), BRANDS))
      return;
    if (isSite(node, sites.assertions)) return;
    report(
      node,
      4,
      `a type assertion to a type of the contract (${typeNode.getText()}); only a listed site may assert`,
    );
  }

  function isOverload(node) {
    if (node.body !== undefined) return false;
    if (isAbstract(node)) return false;
    if (node.getSourceFile().isDeclarationFile) return false;
    if (
      ts
        .getModifiers(node)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
    )
      return true;
    const symbol =
      node.name !== undefined
        ? checker.getSymbolAtLocation(node.name)
        : undefined;
    return (symbol?.declarations ?? []).some(
      (declaration) =>
        declaration !== node &&
        'body' in declaration &&
        declaration.body !== undefined,
    );
  }

  function checkOverload(node) {
    if (!options.rules.has(4) || !isOverload(node)) return;
    const pkg = packageOf(node.getSourceFile().fileName);
    if (
      pkg.name === AUTH_ERRORS &&
      OVERLOAD_FILES.has(rel(pkg.dir, node.getSourceFile().fileName))
    )
      return;
    const signature = checker.getSignatureFromDeclaration(node);
    if (signature === undefined) return;
    if (
      !containsContract(
        checker.getReturnTypeOfSignature(signature),
        ERROR_BRANDS,
      )
    )
      return;
    report(
      node,
      4,
      'an overload signature returns a type of the contract; its implementation is not checked against it',
    );
  }

  // ------------------------------------------------------------ rule 5

  function checkSpread(node) {
    if (!options.rules.has(5)) return;
    if (isErrorType(checker.getTypeAtLocation(node.expression))) {
      report(
        node,
        5,
        'a spread of an error keeps its brand on a new object; relay the error as it is',
      );
    }
  }

  /** The method of the global `Object` that `node` calls, if it calls one. */
  function globalObjectMethod(node) {
    const callee = skipParentheses(node.expression);
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const object = skipParentheses(callee.expression);
    if (!ts.isIdentifier(object) || object.text !== 'Object') return undefined;
    const symbol = checker.getSymbolAtLocation(object);
    const global = (symbol?.declarations ?? []).every((declaration) =>
      program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
    );
    return global ? callee.name.text : undefined;
  }

  function isGlobalObjectAssign(node) {
    return globalObjectMethod(node) === 'assign';
  }

  function checkObjectAssign(node) {
    if (!options.rules.has(5) || !isGlobalObjectAssign(node)) return;
    for (const argument of node.arguments) {
      const expression = ts.isSpreadElement(argument)
        ? argument.expression
        : argument;
      const type = checker.getTypeAtLocation(expression);
      const element = ts.isSpreadElement(argument)
        ? checker.getIndexTypeOfType(type, ts.IndexKind.Number)
        : type;
      if (isErrorType(element)) {
        report(
          argument,
          5,
          'Object.assign copies an error, keeping its brand on another object; relay the error as it is',
        );
      }
    }
  }

  // ------------------------------------------------------------ rules 6 and 7

  function isBuilderDeclaration(declaration) {
    if (declaration === undefined) return false;
    const file = declaration.getSourceFile().fileName;
    if (!isAuthErrorsModule(file, 'builders')) return false;
    if (
      ts.isMethodSignature(declaration) &&
      ts.isInterfaceDeclaration(declaration.parent)
    ) {
      return declaration.parent.name.text === 'VariantBuilders';
    }
    return (
      ts.isFunctionDeclaration(declaration) &&
      ['buildSaml', 'buildSnc', 'buildConfiguration'].includes(
        declaration.name?.text ?? '',
      )
    );
  }

  function isGuardDeclaration(declaration) {
    return (
      declaration !== undefined &&
      ts.isFunctionDeclaration(declaration) &&
      declaration.name?.text === 'guard' &&
      isAuthErrorsModule(declaration.getSourceFile().fileName, 'guard')
    );
  }

  function declarationsOfCallable(expression) {
    const type = checker.getTypeAtLocation(expression);
    return type
      .getCallSignatures()
      .map((signature) => signature.getDeclaration());
  }

  function diagnosticFields(argument) {
    const expression = skipParentheses(argument);
    const type = checker.getTypeAtLocation(expression);
    if (type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return [];
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return ['*'];
    if (
      ts.isObjectLiteralExpression(expression) &&
      expression.properties.every((p) => !ts.isSpreadAssignment(p))
    ) {
      return expression.properties.map(
        (property) => nameOf(property.name) ?? '*',
      );
    }
    const names = checker
      .getPropertiesOfType(checker.getNonNullableType(type))
      .map((property) => property.name);
    return names.length > 0 ? names : ['*'];
  }

  function checkCall(node) {
    const callee = skipParentheses(node.expression);
    // call / apply / bind of a builder or of guard: neither can be checked.
    if (
      ts.isPropertyAccessExpression(callee) &&
      ['call', 'apply', 'bind'].includes(callee.name.text)
    ) {
      const declarations = declarationsOfCallable(callee.expression);
      if (options.rules.has(6) && declarations.some(isBuilderDeclaration)) {
        report(
          node,
          6,
          `a builder reached through ${callee.name.text}; call it directly`,
        );
      }
      if (options.rules.has(7) && declarations.some(isGuardDeclaration)) {
        report(
          node,
          7,
          `guard reached through ${callee.name.text}; call it directly`,
        );
      }
    }
    if (!options.rules.has(6) && !options.rules.has(7)) return;
    const declaration = checker.getResolvedSignature(node)?.getDeclaration();
    if (
      options.rules.has(6) &&
      isBuilderDeclaration(declaration) &&
      node.arguments.length >= 2
    ) {
      const argument = node.arguments[1];
      const file = rel(options.root, node.getSourceFile().fileName);
      const fn = functionOf(node);
      const fields = ts.isSpreadElement(argument)
        ? ['*']
        : diagnosticFields(argument);
      const refused = fields.filter(
        (field) =>
          !sites.diagnostics.some(
            (site) =>
              site.file === file &&
              site.function === fn &&
              site.field === field,
          ),
      );
      if (refused.length > 0) {
        report(
          argument,
          6,
          `diagnostics (${refused.join(', ')}) passed outside the sites of diagnostic-sites.json (${file}, ${fn ?? 'no function'})`,
        );
      }
    }
    if (options.rules.has(7) && isGuardDeclaration(declaration))
      checkGuard(node);
  }

  function isFunctionExpression(node) {
    const inner = skipParentheses(node);
    return ts.isArrowFunction(inner) || ts.isFunctionExpression(inner);
  }

  function checkGuard(node) {
    const args = node.arguments;
    if (args.some(ts.isSpreadElement)) {
      report(
        node,
        7,
        'guard called with spread arguments; pass the operation, the body and the grant',
      );
      return;
    }
    const grant = args[2];
    if (grant !== undefined && !isFunctionExpression(grant)) {
      report(
        grant,
        7,
        "guard's grant is not a function expression; it must be read inside the boundary",
      );
    }
    for (const argument of args) {
      const visit = (child) => {
        if (ts.isArrowFunction(child) || ts.isFunctionExpression(child)) return;
        if (
          child.kind === ts.SyntaxKind.ThisKeyword ||
          child.kind === ts.SyntaxKind.SuperKeyword
        ) {
          const parent = child.parent;
          const moments =
            child.kind === ts.SyntaxKind.ThisKeyword &&
            ts.isPropertyAccessExpression(parent) &&
            parent.expression === child &&
            ts.isPrivateIdentifier(parent.name) &&
            parent.name.text === '#moments';
          if (!moments) {
            report(
              child,
              7,
              "a provider property read in guard's arguments, before the boundary; only this.#moments is",
            );
          }
          return;
        }
        ts.forEachChild(child, visit);
      };
      visit(argument);
    }
  }

  // ------------------------------------------------------------ rule 8

  function inBasicScope(source) {
    const file = rel(options.root, source.fileName);
    return BASIC_SCOPE.some((prefix) => file.startsWith(prefix));
  }

  function isBasicSite(node) {
    return isSite(node, BASIC_SITES);
  }

  /**
   * A header value: `Basic ` (any case) and nothing else — a template head
   * followed by the credential, or a string joined to it (`+`, `concat`, a
   * constant used later); `Basic` alone (`join(' ')`, `${'Basic'}`); or
   * `Basic` and a literal credential (base64 holding a digit, `+`, `/` or
   * `=`). Prose (`Basic authentication`, `the Basic ${x}`) is none.
   */
  const BASIC_PREFIX = /^\s*basic\s+$/i;
  const BASIC_CREDENTIAL = /^\s*basic\s+([A-Za-z0-9+/_-]{8,}={0,2})$/i;

  function isBasicValue(node) {
    const text = node.text;
    if (BASIC_PREFIX.test(text)) return true;
    if (text.trim() === 'Basic') return true;
    const credential = BASIC_CREDENTIAL.exec(text)?.[1];
    return credential !== undefined && /[0-9+/=]/.test(credential);
  }

  function checkBasicText(node) {
    if (
      !options.rules.has(8) ||
      !inBasicScope(node.getSourceFile()) ||
      isBasicSite(node)
    )
      return;
    if (isBasicValue(node)) {
      report(
        node,
        8,
        'a Basic authorization value outside legacyBasic and clientSecretBasic',
      );
    }
  }

  /**
   * A name for a secret's value: `secret`, `…_secret`, `…Secret` (a client
   * secret by any spelling) — not a name that merely starts with it
   * (`secretName`). A heuristic: a secret under another name is not seen.
   */
  function isSecretName(name) {
    return (
      /^secret$/i.test(name) ||
      /_secret$/i.test(name) ||
      /[A-Za-z0-9]Secret$/.test(name)
    );
  }

  /** The value a base64 encoding call encodes, or undefined when it is none. */
  function base64Input(node) {
    const callee = skipParentheses(node.expression);
    if (ts.isIdentifier(callee) && callee.text === 'btoa')
      return node.arguments[0];
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const method = callee.name.text;
    const encoding = node.arguments[0];
    if (method !== 'toString') return undefined;
    if (
      encoding === undefined ||
      !ts.isStringLiteralLike(encoding) ||
      !/^base64(url)?$/.test(encoding.text)
    ) {
      return undefined;
    }
    const subject = skipParentheses(callee.expression);
    if (
      ts.isCallExpression(subject) &&
      ts.isPropertyAccessExpression(subject.expression) &&
      subject.expression.name.text === 'from' &&
      ts.isIdentifier(subject.expression.expression) &&
      subject.expression.expression.text === 'Buffer'
    ) {
      return subject.arguments[0];
    }
    return subject;
  }

  /** Whether `node` is built from something named a secret, following local initialisers. */
  function builtFromSecret(node) {
    const seen = new Set();
    const walk = (current, depth) => {
      if (current === undefined || depth > MAX_DEPTH) return false;
      if (ts.isIdentifier(current) || ts.isPrivateIdentifier(current)) {
        if (isSecretName(current.text)) return true;
        const symbol = checker.getSymbolAtLocation(current);
        if (symbol === undefined || seen.has(symbol)) return false;
        seen.add(symbol);
        return (symbol.declarations ?? []).some(
          (declaration) =>
            ts.isVariableDeclaration(declaration) &&
            declaration.getSourceFile() === current.getSourceFile() &&
            walk(declaration.initializer, depth + 1),
        );
      }
      if (
        ts.isStringLiteralLike(current) &&
        ts.isElementAccessExpression(current.parent)
      ) {
        return isSecretName(current.text);
      }
      let found = false;
      ts.forEachChild(current, (child) => {
        if (!found && walk(child, depth)) found = true;
      });
      return found;
    };
    return walk(node, 0);
  }

  function checkBase64(node) {
    if (
      !options.rules.has(8) ||
      !inBasicScope(node.getSourceFile()) ||
      isBasicSite(node)
    )
      return;
    const input = base64Input(node);
    if (input !== undefined && builtFromSecret(input)) {
      report(
        node,
        8,
        'a base64 encoding of a client secret outside legacyBasic and clientSecretBasic',
      );
    }
  }

  // ------------------------------------------------------------ the walk

  function visit(node) {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node))
      checkClass(node);
    else if (ts.isObjectLiteralExpression(node)) checkObjectLiteral(node);
    else if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))
      checkAssertion(node);
    else if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node))
      checkOverload(node);
    else if (ts.isBinaryExpression(node)) checkMomentAssignment(node);
    else if (ts.isSpreadAssignment(node) || ts.isJsxSpreadAttribute(node))
      checkSpread(node);
    else if (ts.isCallExpression(node)) {
      checkObjectAssign(node);
      checkMomentCall(node);
      checkCall(node);
      checkBase64(node);
    } else if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node)
    ) {
      checkBasicText(node);
    }
    ts.forEachChild(node, visit);
  }

  // ------------------------------------------------------------ the base

  /** Set while the base's own files are scanned beside the selected ones. */
  let baseWritesOnly = false;

  /**
   * The base's implementation files (where it has bodies) are scanned for
   * writes onto the base whatever files were selected; a file also selected
   * is left to `visit`, so nothing is reported twice.
   */
  function scanBaseFiles(selected) {
    const files = new Set();
    for (const declaration of baseDeclarations) {
      const source = declaration.getSourceFile();
      if (!source.isDeclarationFile && !selected.includes(source))
        files.add(source);
    }
    const walk = (node) => {
      if (ts.isBinaryExpression(node)) checkMomentAssignment(node);
      else if (ts.isCallExpression(node)) checkMomentCall(node);
      ts.forEachChild(node, walk);
    };
    baseWritesOnly = true;
    try {
      for (const source of files) walk(source);
    } finally {
      baseWritesOnly = false;
    }
  }

  /** `this.#moments.<moment>`, through parentheses. */
  function isMomentsRead(node, moment) {
    const inner = skipParentheses(node);
    return (
      ts.isPropertyAccessExpression(inner) &&
      ts.isIdentifier(inner.name) &&
      inner.name.text === moment &&
      ts.isPropertyAccessExpression(inner.expression) &&
      inner.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
      ts.isPrivateIdentifier(inner.expression.name) &&
      inner.expression.name.text === '#moments'
    );
  }

  /** A body that is only `return guard(this.#moments.<m>, () => …, () => …)`. */
  function delegatesToGuard(body, moment) {
    if (body.statements.length !== 1) return false;
    const [statement] = body.statements;
    if (!ts.isReturnStatement(statement) || statement.expression === undefined)
      return false;
    const call = skipParentheses(statement.expression);
    if (!ts.isCallExpression(call)) return false;
    const args = call.arguments;
    return (
      args.length === 3 &&
      !args.some(ts.isSpreadElement) &&
      isMomentsRead(args[0], moment) &&
      isFunctionExpression(args[1]) &&
      isFunctionExpression(args[2]) &&
      declarationsOfCallable(call.expression).some(isGuardDeclaration)
    );
  }

  /** Rule 1 on the base itself: each moment one method delegating to guard. */
  function verifyBase() {
    for (const declaration of baseDeclarations) {
      const declarationFile = declaration.getSourceFile().isDeclarationFile;
      const parameters = declaration.members
        .filter(ts.isConstructorDeclaration)
        .flatMap((ctor) => [...ctor.parameters])
        .filter((parameter) =>
          ts.getModifiers(parameter)?.some(isParameterPropertyModifier),
        );
      for (const moment of MOMENTS) {
        const parameter = parameters.find(
          (candidate) => nameOf(candidate.name) === moment,
        );
        if (parameter !== undefined) {
          report(
            parameter,
            1,
            `${BASE} declares ${moment} as a constructor parameter property; its moments only delegate to guard`,
          );
          continue;
        }
        const members = declaration.members.filter(
          (member) => memberName(member.name) === moment,
        );
        const [method] = members;
        const what = `${BASE}.${moment} must only return guard(this.#moments.${moment}, () => …, () => …)`;
        if (
          members.length !== 1 ||
          method === undefined ||
          !ts.isMethodDeclaration(method) ||
          isAbstract(method)
        ) {
          report(method ?? declaration.name ?? declaration, 1, what);
          continue;
        }
        if (method.body === undefined) {
          if (!declarationFile) report(method, 1, what);
          continue;
        }
        if (!delegatesToGuard(method.body, moment)) report(method, 1, what);
      }
    }
  }

  return { visit, verifyBase, scanBaseFiles, findings };
}

// ---------------------------------------------------------------- main

const options = parseArguments(process.argv.slice(2));
const sites = {
  assertions: readSites(options.sites, 'assertion-sites.json', [
    'file',
    'function',
  ]),
  diagnostics: readSites(options.sites, 'diagnostic-sites.json', [
    'file',
    'function',
    'field',
  ]),
};
const { program, sources, contract, baseFile } = loadProgram(options);
const { visit, verifyBase, scanBaseFiles, findings } = createRules(
  program,
  contract,
  baseFile,
  options,
  sites,
);
if (options.rules.has(1) || options.rules.has(2) || options.rules.has(3)) {
  verifyBase();
  scanBaseFiles(sources);
}
for (const source of sources) visit(source);
findings.sort((a, b) =>
  a.file === b.file
    ? a.line - b.line || a.column - b.column || a.rule - b.rule
    : a.file < b.file
      ? -1
      : 1,
);
for (const finding of findings) {
  process.stdout.write(
    `${finding.file}:${finding.line}:${finding.column}: rule ${finding.rule}: ${finding.what}\n`,
  );
}
process.exit(findings.length > 0 ? 1 : 0);
