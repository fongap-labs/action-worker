// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Merged suite. Each section below was a standalone suite and keeps its own scope:
//   - access-keys-test.mjs
//   - key-rpm-test.mjs

import { __resetAccessKeysCacheForTests, collectKnownModels, keyAllowsModel, loadAccessKeysConfig } from '#target/src/config/access-keys.ts';
import { __resetKeyRpmForTests, admitKeyRequest, getKeyRpmSnapshot } from '#target/src/ratelimit/key-rpm.ts';
import { authorize } from '#target/src/request/auth.ts';
import { filterVisibleModels } from '#target/src/request/model-authz.ts';
import assert from 'node:assert/strict';

// ==========================================================================
// access-keys-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT





  let passed = 0;
  async function test(name, fn) {
    try {
      __resetAccessKeysCacheForTests();
      await fn();
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (error) {
      console.error(`FAIL: ${name}`);
      console.error(error?.stack || error);
      process.exitCode = 1;
    }
  }

  const ENV_MODELS = {
    AIG_MODELS_CONFIG: JSON.stringify({
      'code-pro': { policy: 'fast' },
      'general-air': { policy: 'fast' },
    }),
  };
  const req = (key, header = 'authorization') => new Request('https://gateway.example.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [header]: header === 'authorization' ? `Bearer ${key}` : key,
    },
    body: '{}',
  });

  await test('no configured group fails closed', async () => {
    const result = await authorize(req('unused'), { ...ENV_MODELS });
    assert.equal(result.authorized, false);
    assert.equal(loadAccessKeysConfig({ ...ENV_MODELS }).keys.length, 0);
  });

  await test('CSV allowlist is group-scoped and fail-closed', async () => {
    const env = {
      ...ENV_MODELS,
      AIG_ACCESS_KEY_PRO: 'pro-secret',
      AIG_ACCESS_MODELS_PRO: 'code-pro',
    };
    const result = await authorize(req('pro-secret'), env);
    assert.equal(result.authorized, true);
    assert.equal(result.group, 'PRO');
    assert.equal(result.allowAll, false);
    assert.ok(result.allowlist.has('code-pro'));
    assert.ok(!result.allowlist.has('general-air'));
  });

  await test('missing or empty group model list grants zero models', async () => {
    for (const models of [undefined, '']) {
      const env = { ...ENV_MODELS, AIG_ACCESS_KEY_AIR: 'air-secret' };
      if (models !== undefined) env.AIG_ACCESS_MODELS_AIR = models;
      const result = await authorize(req('air-secret'), env);
      assert.equal(result.authorized, true);
      assert.equal(result.allowAll, false);
      assert.equal(result.allowlist.size, 0);
      assert.equal(keyAllowsModel(result, 'code-pro', new Set(['code-pro'])), false);
    }
  });

  await test('wildcard means all known models, not arbitrary strings', async () => {
    const env = {
      ...ENV_MODELS,
      AIG_ACCESS_KEY_MAX: 'max-secret',
      AIG_ACCESS_MODELS_MAX: '*',
    };
    const result = await authorize(req('max-secret'), env);
    assert.equal(result.authorized, true);
    assert.equal(result.allowAll, true);
    const known = new Set(['code-pro', 'general-air']);
    assert.equal(keyAllowsModel(result, 'code-pro', known), true);
    assert.equal(keyAllowsModel(result, 'made-up-model', known), false);
  });

  await test('wrong credential is rejected', async () => {
    const env = {
      ...ENV_MODELS,
      AIG_ACCESS_KEY_ULTRA: 'ultra-secret',
      AIG_ACCESS_MODELS_ULTRA: '*',
    };
    assert.equal((await authorize(req('wrong'), env)).authorized, false);
  });

  await test('all five groups resolve independently', async () => {
    const env = {
      ...ENV_MODELS,
      AIG_ACCESS_KEY_AIR: 'air', AIG_ACCESS_MODELS_AIR: 'general-air',
      AIG_ACCESS_KEY_PRO: 'pro', AIG_ACCESS_MODELS_PRO: 'code-pro',
      AIG_ACCESS_KEY_MAX: 'max', AIG_ACCESS_MODELS_MAX: 'general-air,code-pro',
      AIG_ACCESS_KEY_ULTRA: 'ultra', AIG_ACCESS_MODELS_ULTRA: '*',
      AIG_ACCESS_KEY_AGENT: 'agent', AIG_ACCESS_MODELS_AGENT: 'code-pro',
    };
    for (const [secret, group] of [['air', 'AIR'], ['pro', 'PRO'], ['max', 'MAX'], ['ultra', 'ULTRA'], ['agent', 'AGENT']]) {
      const result = await authorize(req(secret), env);
      assert.equal(result.authorized, true);
      assert.equal(result.group, group);
    }
  });

  await test('authorization result never leaks the raw secret', async () => {
    const env = {
      ...ENV_MODELS,
      AIG_ACCESS_KEY_AIR: 'super-secret-value',
      AIG_ACCESS_MODELS_AIR: '*',
    };
    const serialized = JSON.stringify(await authorize(req('super-secret-value'), env));
    assert.ok(!serialized.includes('super-secret-value'));
    assert.ok(!/bearer/i.test(serialized));
  });

  await test('unknown allowlist entry emits a catalog warning but creates no model', async () => {
    const env = {
      ...ENV_MODELS,
      AIG_ACCESS_KEY_PRO: 'pro',
      AIG_ACCESS_MODELS_PRO: 'ghost',
    };
    const { diagnostics } = loadAccessKeysConfig(env);
    assert.ok(diagnostics.some((d) => d.includes('ghost') && d.includes('Known Model Catalog')));
  });

  await test('x-api-key is accepted for grouped keys', async () => {
    const env = {
      ...ENV_MODELS,
      AIG_ACCESS_KEY_AIR: 'air',
      AIG_ACCESS_MODELS_AIR: '*',
    };
    const result = await authorize(req('air', 'x-api-key'), env);
    assert.equal(result.authorized, true);
    assert.equal(result.group, 'AIR');
  });

  await test('known model catalog is node mappings plus AIG_MODELS_CONFIG', async () => {
    const nodes = [{ models: { 'Code-Max': 'up' } }];
    const env = { AIG_MODELS_CONFIG: JSON.stringify({ Air: { policy: 'default' }, OCR: { policy: 'default' } }) };
    const known = collectKnownModels(nodes, env);
    assert.deepEqual([...known].sort(), ['Air', 'Code-Max', 'OCR']);
    assert.ok(!known.has('made-up-model'));
  });

  await test('/v1/models filter uses the same known catalog as authorization', async () => {
    const nodes = [{ models: { Air: 'a', 'Code-Max': 'c', Omni: 'o', OCR: 'r' } }];
    const known = collectKnownModels(nodes, {});
    assert.deepEqual(
      filterVisibleModels(known, { authorized: true, allowAll: true }),
      ['Air', 'Code-Max', 'OCR', 'Omni'],
    );
    assert.deepEqual(
      filterVisibleModels(known, { authorized: true, allowAll: false, allowlist: new Set(['Air', 'Omni']) }),
      ['Air', 'Omni'],
    );
  });

  await test('empty known catalog stays empty even for wildcard access key', async () => {
    const known = collectKnownModels([{ models: {} }], {});
    assert.equal(known.size, 0);
    assert.deepEqual(filterVisibleModels(known, { authorized: true, allowAll: true }), []);
  });

  if (process.exitCode) suiteExit(1);
  console.log(`\naccess-keys tests passed (${passed}).`);
  console.log('ok - file:access-keys');
} catch (error) {
  console.error('not ok - access-keys-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// key-rpm-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // @ts-check
  // Copyright (c) 2026 Fongap Labs
  //
  // PR 6 / P2-A — Per-key gateway RPM limiter (in-isolate, sliding window).
  //
  // These tests pin the contract the handler relies on:
  //   1. cap=0 disables the limiter (every request is admitted)
  //   2. within the window, the first N requests are admitted and
  //      request N+1 is denied
  //   3. once the oldest stamp falls out of the window, that slot frees
  //      up and the next request is admitted
  //   4. deny returns a positive retryAfterSec based on the oldest stamp
  //   5. each key has an independent counter
  //   6. the bounded key map does not leak under 10000 unique keys




  const now = 1_700_000_000_000;
  const WINDOW = 60_000;

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

  await test('cap=0 disables the limiter entirely', () => {
    __resetKeyRpmForTests();
    for (let i = 0; i < 5000; i += 1) {
      assert.equal(admitKeyRequest('k0', 0, now + i).ok, true, 'every request must be admitted when cap=0');
    }
  });

  await test('within the window, first N requests are admitted and N+1 is denied', () => {
    __resetKeyRpmForTests();
    for (let i = 0; i < 5; i += 1) {
      const r = admitKeyRequest('k1', 5, now + i * 100);
      assert.equal(r.ok, true, `request ${i + 1} should be admitted`);
    }
    const denied = admitKeyRequest('k1', 5, now + 500);
    assert.equal(denied.ok, false, 'the 6th request must be denied');
    assert.ok(denied.retryAfterSec > 0, 'retryAfterSec must be positive');
    assert.ok(denied.retryAfterSec <= 60, 'retryAfterSec must be <= the window length');
  });

  await test('once the oldest stamp falls out of the window, the slot frees up', () => {
    __resetKeyRpmForTests();
    // 5 requests at the cap.
    for (let i = 0; i < 5; i += 1) {
      admitKeyRequest('k2', 5, now + i);
    }
    // At now+WINDOW, the first request is exactly 60s old — outside the window.
    const later = now + WINDOW + 1;
    const r = admitKeyRequest('k2', 5, later);
    assert.equal(r.ok, true, 'after the window slides, the next request must be admitted');
  });

  await test('denied request retry-after reflects the oldest stamp', () => {
    __resetKeyRpmForTests();
    // First request at t=0; the 6th is at t=30000 — retry-after should
    // be ceil((0 + 60000 - 30000) / 1000) = 30 seconds.
    for (let i = 0; i < 5; i += 1) {
      admitKeyRequest('k3', 5, now + i);
    }
    const denied = admitKeyRequest('k3', 5, now + 300);
    assert.equal(denied.retryAfterSec, 60, 'retryAfterSec should be 60s when the oldest stamp is 0.3s in');
  });

  await test('each key has an independent counter', () => {
    __resetKeyRpmForTests();
    for (let i = 0; i < 5; i += 1) {
      admitKeyRequest('kA', 5, now + i);
    }
    // kA is at cap. kB has its own counter.
    for (let i = 0; i < 5; i += 1) {
      const r = admitKeyRequest('kB', 5, now + i);
      assert.equal(r.ok, true, 'kB should be unaffected by kA');
    }
    // kA is still denied.
    const r = admitKeyRequest('kA', 5, now + 6);
    assert.equal(r.ok, false, 'kA is still at cap');
  });

  await test('snapshot reports the current usage', () => {
    __resetKeyRpmForTests();
    for (let i = 0; i < 3; i += 1) {
      admitKeyRequest('kSnap', 10, now + i);
    }
    const snap = getKeyRpmSnapshot('kSnap', now + 3);
    assert.equal(snap.used, 3, 'snapshot should report the in-window count');
    assert.equal(snap.cap, 10, 'snapshot should report the configured cap');
  });

  await test('snapshot returns cap 0 for unknown key', () => {
    __resetKeyRpmForTests();
    const snap = getKeyRpmSnapshot('unknown-key');
    assert.equal(snap.used, 0);
    assert.equal(snap.cap, 0);
  });

  await test('bounded key map: 10000 unique keys do not exceed the cap', () => {
    __resetKeyRpmForTests();
    for (let i = 0; i < 10_000; i += 1) {
      admitKeyRequest(`k${i}`, 1, now);
    }
    // The cap is 5000; anything past that is evicted. The limiter still
    // works for newly-arriving keys (it never throws OOM, never blocks).
    const r = admitKeyRequest('k-fresh-after-overflow', 1, now);
    assert.equal(r.ok, true, 'the limiter must keep admitting fresh keys after overflow');
  });
  console.log('ok - file:key-rpm');
} catch (error) {
  console.error('not ok - key-rpm-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}
