/**
 * The timer counter, tested: a test that asserts "no timer of the package's
 * own" proves nothing if the counter cannot see one.
 *
 * Each control arms one timer through one API from a module that sits where
 * package code sits — a compiled file under a `src/` directory, outside the
 * tests and outside `node_modules` — and the counter must count it. The same
 * module under a `node_modules/` directory, and the test's own call, must not
 * be counted.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it, mock } from 'node:test';
import { armedByPackage, watchTimers } from './helpers/packageTimers.js';

/** One deliberate delay per timer API, each a function of no arguments. */
const DELAYS = `'use strict';
const timers = require('node:timers');
const promises = require('node:timers/promises');
const once = (arm, clear) =>
  new Promise((resolve) => {
    const handle = arm(() => {
      if (clear) clear(handle);
      resolve();
    });
  });
module.exports = {
  'globalThis.setTimeout': () => once((done) => setTimeout(done, 1)),
  'globalThis.setInterval': () =>
    once((done) => setInterval(done, 1), clearInterval),
  'globalThis.setImmediate': () => once((done) => setImmediate(done)),
  'node:timers setTimeout': () => once((done) => timers.setTimeout(done, 1)),
  'node:timers setInterval': () =>
    once((done) => timers.setInterval(done, 1), timers.clearInterval),
  'node:timers setImmediate': () => once((done) => timers.setImmediate(done)),
  'node:timers/promises setTimeout': () => promises.setTimeout(1),
  'node:timers/promises setInterval': async () => {
    for await (const _ of promises.setInterval(1)) break;
  },
  'node:timers/promises setImmediate': () => promises.setImmediate(),
  'node:timers/promises scheduler.wait': () => promises.scheduler.wait(1),
  'node:timers/promises scheduler.yield': () => promises.scheduler.yield(),
};
`;

const NAMES = [
  'globalThis.setTimeout',
  'globalThis.setInterval',
  'globalThis.setImmediate',
  'node:timers setTimeout',
  'node:timers setInterval',
  'node:timers setImmediate',
  'node:timers/promises setTimeout',
  'node:timers/promises setInterval',
  'node:timers/promises setImmediate',
  'node:timers/promises scheduler.wait',
  'node:timers/promises scheduler.yield',
];

/** The delays module, loaded from `file`. */
function load(file: string): Record<string, () => Promise<unknown>> {
  const loaded: Record<string, () => Promise<unknown>> = require(file);
  return loaded;
}

describe('the timer counter', () => {
  let root: string;
  let packageSide: Record<string, () => Promise<unknown>>;
  let dependency: Record<string, () => Promise<unknown>>;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'package-timers-'));
    const ours = join(root, 'src', 'connection');
    const theirs = join(root, 'node_modules', 'dep', 'src');
    mkdirSync(ours, { recursive: true });
    mkdirSync(theirs, { recursive: true });
    writeFileSync(join(ours, 'delays.js'), DELAYS);
    writeFileSync(join(theirs, 'delays.js'), DELAYS);
    packageSide = load(join(ours, 'delays.js'));
    dependency = load(join(theirs, 'delays.js'));
  });

  afterEach(() => {
    mock.restoreAll();
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  for (const name of NAMES) {
    it(`counts a package-side delay through ${name}`, async () => {
      const delay = packageSide[name];
      assert.ok(delay, name);
      const timers = watchTimers();

      await delay();

      assert.ok(timers.ours() >= 1, `${name}: ${timers.ours()}`);
    });

    it(`does not count a dependency's delay through ${name}`, async () => {
      const delay = dependency[name];
      assert.ok(delay, name);
      const timers = watchTimers();

      await delay();

      assert.strictEqual(timers.ours(), 0);
    });
  }

  it('does not count a timer the test itself arms', async () => {
    const timers = watchTimers();

    await new Promise((resolve) => setTimeout(resolve, 1));

    assert.strictEqual(timers.ours(), 0);
  });

  it('reads the caller from the first frame that is a file', () => {
    const ours = [
      'Error',
      '    at Object.method (node:internal/test_runner/mock/mock:1:1)',
      '    at once (/repo/.test-build/src/connection/HttpTransport.js:9:9)',
    ].join('\n');
    const theirs = [
      'Error',
      '    at ClientRequest.startTimer (/repo/node_modules/follow-redirects/index.js:232:21)',
      '    at send (/repo/.test-build/src/connection/HttpTransport.js:9:9)',
    ].join('\n');
    // A function's name is not its location: one named like a Node module
    // is still the file it sits in.
    const named = [
      'Error',
      '    at Object.apply (node:internal/test_runner/mock/mock:778:20)',
      '    at node:timers/promises setTimeout (/repo/.test-build/src/connection/x.js:2:22)',
    ].join('\n');
    const windows = [
      'Error',
      '    at once (C:\\repo\\.test-build\\src\\connection\\HttpTransport.js:9:9)',
    ].join('\n');

    assert.strictEqual(armedByPackage(ours), true);
    assert.strictEqual(armedByPackage(theirs), false);
    assert.strictEqual(armedByPackage(named), true);
    assert.strictEqual(armedByPackage(windows), true);
  });
});
