#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Repository layout governance for ai-gateway. This suite lives in the central
// test pack (action-worker), so a pull request to ai-gateway cannot weaken it.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { targetRoot as root } from '#kit/target.mjs';

const packDir = path.dirname(fileURLToPath(import.meta.url));

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const scriptsDir = path.join(root, 'scripts');
const srcDir = path.join(root, 'src');
const workflowsDir = path.join(root, '.github', 'workflows');
const testName = /(?:^|[-_.])test(?:[-_.]|\.)/i;

const misplacedScriptTests = walk(scriptsDir)
  .filter((file) => testName.test(path.basename(file)))
  .map((file) => path.relative(root, file))
  .filter((file) => file !== path.join('scripts', 'test.mjs'));
assert.deepEqual(misplacedScriptTests, [], 'scripts/ must contain tooling, not executable test files');

const misplacedRuntimeTests = walk(srcDir)
  .filter((file) => testName.test(path.basename(file)))
  .map((file) => path.relative(root, file));
assert.deepEqual(misplacedRuntimeTests, [], 'src/ must contain Worker runtime code, not test files');

assert.equal(
  fs.existsSync(path.join(root, '.githooks')),
  false,
  '.githooks must remain local; repository governance is enforced by CI and GitHub workflows',
);

assert.equal(
  fs.existsSync(path.join(root, 'benchmark')),
  false,
  'standalone benchmark/ must remain absent unless a governed benchmark system with stable baselines and thresholds is introduced',
);

// Test suites are owned by the central pack; the product repository carries none.
const localSuites = fs.existsSync(path.join(root, 'tests'))
  ? walk(path.join(root, 'tests')).map((file) => path.relative(root, file).replaceAll(path.sep, '/'))
  : [];
assert.deepEqual(localSuites, [], 'test suites live in action-worker tests/packs/ai-gateway, not in this repository');

const tokenStoreFacadePath = path.join(root, 'src/observability/token-usage-store.ts');
assert.equal(fs.existsSync(tokenStoreFacadePath), true,
  'token-usage-store.ts must remain the stable import facade for the persistent store');
const tokenStoreFacade = fs.readFileSync(tokenStoreFacadePath, 'utf8');
assert.match(tokenStoreFacade, /Stable public import surface for the persistent token-usage store/);
assert.match(tokenStoreFacade, /export \* from '\.\/token-usage-store\/index\.ts';/);

const directStoreIndexImports = [
  ...walk(srcDir).map((file) => ({ file, base: root })),
  ...walk(packDir)
    .filter((file) => file !== fileURLToPath(import.meta.url))
    .map((file) => ({ file, base: packDir })),
]
  .filter(({ file }) => /\.(?:ts|mjs|js)$/.test(file))
  .filter(({ file }) => path.resolve(file) !== path.resolve(tokenStoreFacadePath))
  .filter(({ file }) => /token-usage-store\/index\.ts/.test(fs.readFileSync(file, 'utf8')))
  .map(({ file, base }) => path.relative(base, file).replaceAll(path.sep, '/'));
assert.deepEqual(directStoreIndexImports, [], 'consumers must use token-usage-store.ts instead of coupling to store implementation files');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const name of ['test:unit', 'test:gate', 'test:all', 'test:integration', 'test:conversion']) {
  assert.equal(pkg.scripts?.[name], undefined, `package.json must not define ${name}; suites are executed by the central runner`);
}
assert.equal(pkg.scripts?.test, 'node scripts/test.mjs', 'package.json test must delegate to the central pack runner wrapper');
assert.equal(pkg.scripts?.bench, undefined, 'package.json must not expose an ungoverned bench command');
assert.equal(pkg.scripts?.['bench:full'], undefined, 'package.json must not expose an ungoverned bench:full command');

for (const name of ['validate:merge', 'validate:deploy']) {
  const command = pkg.scripts?.[name] || '';
  for (const step of ['check', 'check:deployment-config', 'migrations:check', 'security:scan', 'check:docs', 'typecheck', 'check:links']) {
    assert.match(command, new RegExp(`npm run ${step}(?: |$)`), `${name} must run ${step}`);
  }
}

// Pack integrity: gate suites exist and none is listed twice.
const pack = JSON.parse(fs.readFileSync(path.join(packDir, 'pack.json'), 'utf8'));
const gate = pack.tiers?.gate ?? [];
assert.equal(new Set(gate).size, gate.length, 'pack.json gate tier must not list a suite twice');
for (const required of [
  'scheduler-stability-test.mjs',
  'integration-test.mjs',
  'stress-test.mjs',
  'codex-contract-test.mjs',
  'claude-contract-test.mjs',
]) {
  assert.ok(gate.includes(required), `pack.json gate tier must include ${required}`);
  assert.ok(fs.existsSync(path.join(packDir, required)), `${required} must exist in the pack`);
}

const temporaryTestWorkflows = fs.readdirSync(workflowsDir)
  .filter((name) => /^(?:patch|fix)-.*test.*\.ya?ml$/i.test(name))
  .sort();
assert.deepEqual(temporaryTestWorkflows, [], 'one-shot patch/fix test workflows must not remain on main');

console.log('repository-layout tests passed.');
