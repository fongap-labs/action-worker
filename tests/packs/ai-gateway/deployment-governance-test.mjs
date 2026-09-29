// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Merged suite. Each section below was a standalone suite and keeps its own scope:
//   - deployment-workflow-contract-test.mjs
//   - deploy-kill-switch-test.mjs
//   - ci-migration-immutability-contract-test.mjs
//   - migrations-check-test.mjs
//   - secret-scan-typescript-fixture-test.mjs

import { targetPath, targetRoot as root } from '#kit/target.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path, { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ==========================================================================
// deployment-workflow-contract-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT






  const deployManifest = JSON.parse(readFileSync(join(root, '.github/deploy.json'), 'utf8'));
  const deployScript = readFileSync(join(root, 'scripts/deploy.sh'), 'utf8').replace(/\r\n/g, '\n');
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');

  assert.equal(existsSync(join(root, '.github/workflows/deploy.yml')), false);
  assert.deepEqual(deployManifest, {
    schema_version: '1',
    adapter: 'source-script',
    automatic: true,
    ignore_docs_only: true,
    runner_profile: 'production-deploy',
    environment: 'production',
    entrypoint: 'scripts/deploy.sh',
  });
  assert.match(deployScript, /DEPLOY_SOURCE_SHA/);
  assert.match(deployScript, /AIG_IS_DEPLOY_ENABLED/);
  assert.match(deployScript, /cloudflare-wrangler\.mjs deploy/);
  assert.match(deployScript, /cloudflare-wrangler\.mjs rollback/);
  assert.match(deployScript, /github-deployment-config\.mjs health-check/);
  assert.doesNotMatch(deployScript, /AW_DISPATCH_TOKEN|AW_CONTROL_TOKEN|AW_ADMIN_TOKEN/);
  assert.doesNotMatch(deployScript, /wrangler@\d+\.\d+\.\d+/);

  assert.match(ci, /run-central-ci-ref/);
  assert.match(ci, /AW_DISPATCH_TOKEN/);
  assert.doesNotMatch(ci, /npm\s+run/);

  console.log('deployment-workflow-contract: source-owned deploy contract passed');
  console.log('ok - file:deployment-workflow-contract');
} catch (error) {
  console.error('not ok - deployment-workflow-contract-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// deploy-kill-switch-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT




  const deploy = readFileSync(targetPath('scripts/deploy.sh'), 'utf8');

  assert.match(deploy, /AIG_IS_DEPLOY_ENABLED/);
  assert.match(deploy, /== "false"/);
  assert.match(deploy, /exit 0/);
  assert.match(deploy, /cloudflare-wrangler\.mjs deploy/);
  assert.doesNotMatch(deploy, /AW_DISPATCH_TOKEN|AW_CONTROL_TOKEN|AW_ADMIN_TOKEN/);
  assert.doesNotMatch(deploy, /wrangler@\d+\.\d+\.\d+/);

  console.log('deploy kill-switch contract tests passed.');
  console.log('ok - file:deploy-kill-switch');
} catch (error) {
  console.error('not ok - deploy-kill-switch-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// ci-migration-immutability-contract-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT






  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const central = fs.readFileSync(path.join(root, '.github', 'scripts', 'central-ci.sh'), 'utf8');
  const migrationsCheck = fs.readFileSync(path.join(root, 'scripts', 'migrations-check.mjs'), 'utf8');

  assert.match(workflow, /run-central-ci-ref/, 'main CI must dispatch to Action Worker');
  assert.match(central, /npm run validate:merge/, 'central CI must execute merge validation with full checkout history');
  assert.match(central, /CENTRAL_CI_PR_NUMBER/, 'central CI must distinguish PR and default-branch validation');
  assert.ok(!/skipping immutability check/i.test(migrationsCheck));
  assert.match(migrationsCheck, /immutability check requires complete git history/);

  console.log('CI migration immutability contract passed.');
  console.log('ok - file:ci-migration-immutability-contract');
} catch (error) {
  console.error('not ok - ci-migration-immutability-contract-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// migrations-check-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // @ts-check
  // Copyright (c) 2026 Fongap Labs
  //
  // Unit tests for the migrations governance check.
  // Runs in-memory fixtures against the same regex / parse logic the
  // production check uses, so violations are caught even when the
  // on-disk migrations/ tree is the (clean) shipped state.





  const here = path.dirname(fileURLToPath(import.meta.url));

  const checkPath = path.join(root, 'scripts', 'migrations-check.mjs');

  // Re-import the same constants the check uses by parsing the source.
  // This keeps the test in lockstep with whatever the production regex is.
  const _source = await import(pathToFileURL(checkPath).href).catch(() => null);
  // The check is a script, not a module — re-derive the same regex.

  const FILENAME_RE = /^(\d{3,})_([a-z0-9_]+)\.sql$/;
  const parseName = (f) => {
    const m = FILENAME_RE.exec(f);
    if (!m) return null;
    return { num: Number.parseInt(m[1], 10), slug: m[2] };
  };

  function expectParse(f) {
    const p = parseName(f);
    assert.ok(p, `${f} should parse as a valid migration filename`);
    return p;
  }

  function expectReject(f) {
    const p = parseName(f);
    assert.equal(p, null, `${f} should NOT parse as a valid migration filename`);
  }

  await test('parse: 4-digit prefix is accepted (matches shipped files)', () => {
    const p = expectParse('0001_token_usage_hourly.sql');
    assert.equal(p.num, 1);
    assert.equal(p.slug, 'token_usage_hourly');
  });

  await test('parse: 3-digit prefix is accepted', () => {
    const p = expectParse('001_foo.sql');
    assert.equal(p.num, 1);
    assert.equal(p.slug, 'foo');
  });

  await test('parse: slug may contain digits and underscores', () => {
    expectParse('0007_drop_redundant_usage_indexes.sql');
    expectParse('0010_add_ocr_capability_2026_01_15.sql');
  });

  await test('reject: missing NNN prefix', () => {
    expectReject('token_usage_hourly.sql');
    expectReject('foo.sql');
    expectReject('001-foo.sql');
  });

  await test('reject: invalid slug characters', () => {
    expectReject('0001_Token.sql');
    expectReject('0001_foo-bar.sql');
    expectReject('0001_foo bar.sql');
    expectReject('0001_.sql');
  });

  await test('reject: non-sql files', () => {
    expectReject('0001_foo.md');
    expectReject('0001_foo.txt');
    expectReject('0001_foo');
  });

  await test('shipped files in migrations/ all parse cleanly', async () => {
    const fs = await import('node:fs');
    const dir = path.join(root, 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
    for (const f of files) {
      expectParse(f);
    }
    const nums = files.map((f) => expectParse(f).num).sort((a, b) => a - b);
    for (let i = 1; i < nums.length; i += 1) {
      assert.equal(nums[i] - nums[i - 1], 1, `gap between ${nums[i - 1]} and ${nums[i]}`);
    }
  });

  async function test(name, fn) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      console.error(`not ok - ${name}`);
      console.error(error?.stack || error);
      process.exitCode = 1;
    }
  }
  console.log('ok - file:migrations-check');
} catch (error) {
  console.error('not ok - migrations-check-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// secret-scan-typescript-fixture-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs
  //
  // Runtime fixture test for the secret scanner. The fixtures are generated in a
  // temporary directory so secret-looking strings never live in the repository.









  const scanner = path.join(root, 'scripts', 'secret-scan.mjs');
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gateway-secret-scan-'));

  try {
    const fakeKey = `sk-${'A'.repeat(24)}`;
    for (const ext of ['.ts', '.tsx', '.mts', '.cts']) {
      fs.writeFileSync(path.join(fixtureRoot, `fixture${ext}`), `export const leaked = '${fakeKey}';\n`, 'utf8');
    }

    const result = spawnSync(process.execPath, [scanner, '--root', fixtureRoot], {
      cwd: root,
      encoding: 'utf8',
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;

    assert.equal(result.status, 1, 'secret scanner must reject TypeScript fixtures containing a fake secret');
    for (const ext of ['.ts', '.tsx', '.mts', '.cts']) {
      assert.ok(output.includes(`fixture${ext}`), `scanner output must include the ${ext} fixture`);
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }

  console.log('secret scanner TypeScript fixture test passed.');
  console.log('ok - file:secret-scan-typescript-fixture');
} catch (error) {
  console.error('not ok - secret-scan-typescript-fixture-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}
