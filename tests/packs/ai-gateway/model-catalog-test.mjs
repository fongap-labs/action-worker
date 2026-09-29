// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Merged suite. Each section below was a standalone suite and keeps its own scope:
//   - model-status-test.mjs
//   - model-status-window-contract-test.mjs
//   - model-catalog-policy-test.mjs
//   - model-discovery-live-test.mjs
//   - closed-catalog-test.mjs

import { createMockD1 } from '#kit/mock-d1-database.mjs';
import { targetRoot as root } from '#kit/target.mjs';
import { collectDiscoveryNodes, diffModelSnapshots, formatDiscoveryMarkdown, scanDiscoveryNode } from '#target/scripts/provider-discovery/index.js';
import { getModelsConfigDiagnostics, loadModelsConfig } from '#target/src/config/models.ts';
import { getPolicy, loadPoliciesConfig } from '#target/src/config/policies.ts';
import { collectKnownModels, isWildcardNode, loadModelRegistry, modelRegistryEntry, servesModel } from '#target/src/config/registry.ts';
import worker from '#target/src/index.ts';
import { queryRecentModelEvidence } from '#target/src/observability/token-usage-store.ts';
import { providerWire } from '#target/src/providers/registry.ts';
import { __resetAllStateForTests } from '#target/src/reliability/node-state.ts';
import { __resetTier1StateForTests, getTier1Model, recordTier1Ttft } from '#target/src/reliability/tier1-state.ts';
import { authorizeModel, filterVisibleModels } from '#target/src/request/model-authz.ts';
import { buildModelFallbackRounds } from '#target/src/request/model-fallback.ts';
import { MODEL_STATUS_HISTORICAL_WINDOW_MS, MODEL_STATUS_RECENT_WINDOW_MS, getPublicModelStatus } from '#target/src/runtime/model-status.ts';
import { supportsRequest } from '#target/src/scheduler/scheduler.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ==========================================================================
// model-status-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  //
  // Public Model Status unit tests (src/runtime/model-status.ts). The core bug
  // fix is verified here: a freshly-isolated Worker that has no Tier 1
  // passive-TTFT sample must NOT mark every model `暂无记录` when D1 has recent
  // successful evidence for them. The five public states are: 服务可用
  // (available), 服务波动 (fluctuating), 无新记录 (no_recent), 暂无记录
  // (no_record), 服务故障 (down). A model with no runtime sample, no recent
  // evidence, and no historical evidence is `no_record`; a model with all
  // candidates currently down and no recent evidence is `down`. D1 failure
  // must fail open: never fabricate `available`, never mark every model `down`.








  const HOUR = 3_600_000;

  let passed = 0;
  function test(name, fn) {
    try {
      __resetTier1StateForTests();
      __resetAllStateForTests();
      fn();
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (e) {
      console.error(`FAIL: ${name}`);
      console.error(e?.stack || e);
      process.exitCode = 1;
    }
  }

  async function testAsync(name, fn) {
    try {
      __resetTier1StateForTests();
      __resetAllStateForTests();
      await fn();
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (e) {
      console.error(`FAIL: ${name}`);
      console.error(e?.stack || e);
      process.exitCode = 1;
    }
  }

  const ENV = { AIG_ACCESS_KEY_AIR: 'k', AIG_MODELS_CONFIG: JSON.stringify({ air: { policy: 'fast' } }) };
  const node = (id, models) => ({
    id,
    provider: 'mock',
    tier: 'tier-1',
    protocol: 'openai',
    surfaces: ['chat_completions'],
    base_url: `https://${id}.example.com/v1`,
    models,
    limits: { concurrency: 1 },
  });
  const now = () => 1_700_000_000_000;

  function findModelStatus(result, id) {
    const list = Array.isArray(result) ? result : result?.models || [];
    const entry = list.find((m) => m.id === id);
    if (!entry) throw new Error(`no model ${id} in result`);
    return entry.status;
  }

  // --- 1. Cold-start: no Tier 1 sample + D1 has recent traffic => available ----

  test('cold-start: no Tier 1 sample but D1 has recent traffic -> available', () => {
    const nodes = [node('a', { air: 'up-air' })];
    // No recordTier1Ttft() — fresh isolate, account has no sample.
    const evidence = new Set(['air']);
    const list = getPublicModelStatus(nodes, ENV, evidence, now());
    assert.equal(findModelStatus(list, 'air'), 'available');
  });

  // --- 2. New model: no runtime sample + no D1 evidence => no_record ----------

  test('new model: no runtime sample and no D1 evidence -> no_record', () => {
    const nodes = [node('a', { air: 'up-air' })];
    const list = getPublicModelStatus(nodes, ENV, new Set(), now());
    assert.equal(findModelStatus(list, 'air'), 'no_record');
  });

  // --- 3. All candidates down + no recent D1 => down ---------------------------

  test('all candidates down and no D1 evidence -> down', () => {
    const nodes = [node('a', { air: 'up-air' })];
    // Force the Tier 1 model into cooldown so runtime returns 'unavailable'.
    const t1Model = getTier1Model('a', 'air');
    t1Model.cooldownUntil = now() + 60_000;
    t1Model.failureState = 'cooldown';
    const list = getPublicModelStatus(nodes, ENV, new Set(), now());
    assert.equal(findModelStatus(list, 'air'), 'down');
  });

  // --- 4. All candidates down + recent D1 => fluctuating -----------------------

  test('all candidates cooling with recent D1 success -> fluctuating', () => {
    const nodes = [node('a', { air: 'up-air' })];
    const t1Model = getTier1Model('a', 'air');
    t1Model.cooldownUntil = now() + 60_000;
    t1Model.failureState = 'cooldown';
    const list = getPublicModelStatus(nodes, ENV, new Set(['air']), now());
    assert.equal(findModelStatus(list, 'air'), 'fluctuating');
  });

  // --- 5. Tier 1 sample present + healthy => available -------------------------

  test('healthy Tier 1 path with sample -> available (with or without D1)', () => {
    const nodes = [node('a', { air: 'up-air' })];
    recordTier1Ttft('a', 'air', 100, now() - 1000);
    assert.equal(findModelStatus(getPublicModelStatus(nodes, ENV, new Set(), now()), 'air'), 'available');
    assert.equal(findModelStatus(getPublicModelStatus(nodes, ENV, new Set(['air']), now()), 'air'), 'available');
  });

  // --- 6. Mixed nodes: one available + one cooling + no D1 => available ---------

  test('one available + one cooling + no D1 -> available (still has a path)', () => {
    const nodes = [node('a', { air: 'up-air' }), node('b', { air: 'up-air' })];
    recordTier1Ttft('a', 'air', 100, now() - 1000);
    // b is in cooldown.
    const t1ModelB = getTier1Model('b', 'air');
    t1ModelB.cooldownUntil = now() + 60_000;
    t1ModelB.failureState = 'cooldown';
    const list = getPublicModelStatus(nodes, ENV, new Set(), now());
    assert.equal(findModelStatus(list, 'air'), 'available');
  });

  // --- 7. Mixed nodes: one available + one cooling + D1 => available -----------

  test('one available + one cooling + D1 -> available', () => {
    const nodes = [node('a', { air: 'up-air' }), node('b', { air: 'up-air' })];
    recordTier1Ttft('a', 'air', 100, now() - 1000);
    const t1ModelB = getTier1Model('b', 'air');
    t1ModelB.cooldownUntil = now() + 60_000;
    t1ModelB.failureState = 'cooldown';
    const list = getPublicModelStatus(nodes, ENV, new Set(['air']), now());
    assert.equal(findModelStatus(list, 'air'), 'available');
  });

  // --- 8. Node-mapped models are public by default ----------------------------

  test('node-mapped model IS public (no AIG_MODELS_CONFIG required)', () => {
    // Two node-mapped models. No AIG_MODELS_CONFIG: both should be public.
    const nodes = [node('a', { 'public-air': 'up-air', 'public-max': 'up-max' })];
    const list = getPublicModelStatus(nodes, ENV, new Set(), now());
    const ids = list.models.map((m) => m.id);
    assert.ok(ids.includes('public-air'), 'a node-mapped model is public by default');
    assert.ok(ids.includes('public-max'), 'a node-mapped model is public by default');
    // A model in AIG_MODELS_CONFIG but with no node mapping is not in the public set.
    const airInResult = list.models.find((m) => m.id === 'air');
    assert.equal(airInResult, undefined, 'AIG_MODELS_CONFIG alone does not surface a model');
  });

  // --- 9. Wildcard node: serves any model another node declared ---------------

  test('wildcard node serves any model another node declared', () => {
    // Two nodes: one wildcard (empty models), one explicit. The wildcard node
    // serves 'air' (because another node maps it), even though its own models
    // map is empty.
    const nodes = [
      node('a', {}), // wildcard
      node('b', { 'public-air': 'up-air' }), // explicit
    ];
    const list = getPublicModelStatus(nodes, ENV, new Set(['public-air']), now());
    // Node mappings are the primary source; 'public-air' is in node b's map.
    const ids = list.models.map((m) => m.id);
    assert.ok(ids.includes('public-air'), 'public-air is in the public set via node b');
  });

  // --- 10. Sort order: result is sorted by id ----------------------------------

  test('output is sorted by logical model name', () => {
    // Source is node mappings (primary). Build a single node with three models.
    const nodes = [node('a', { zeta: 'up-zeta', alpha: 'up-alpha', mid: 'up-mid' })];
    const list = getPublicModelStatus(nodes, ENV, new Set(), now());
    assert.deepEqual(
      list.models.map((m) => m.id),
      ['alpha', 'mid', 'zeta'],
    );
    assert.equal(list.observed_at, new Date(now()).toISOString(), 'envelope carries observed_at');
  });

  // --- 11. Public-safety: no node ids / providers / tiers in output ------------

  test('output never carries node ids, providers, or tiers', () => {
    const nodes = [node('n1', { air: 'up-air' })];
    const list = getPublicModelStatus(nodes, ENV, new Set(['air']), now());
    const serialized = JSON.stringify(list);
    assert.ok(!/n1/.test(serialized), 'must not leak node id');
    assert.ok(!/mock/.test(serialized), 'must not leak provider');
    assert.ok(!/openai/.test(serialized), 'must not leak protocol');
    assert.ok(!/tier-1/.test(serialized), 'must not leak tier');
    assert.ok(!/cooldown/.test(serialized), 'must not leak cooldown reason');
    assert.ok(!/half_open/.test(serialized), 'must not leak failure state');
  });

  // --- 12. Edge: empty node list ----------------------------------------------

  test('empty node list -> empty public status (no node mappings = no public models)', () => {
    const list = getPublicModelStatus([], ENV, new Set(), now());
    // Node mappings are primary; with no nodes there is nothing to show. The
    // AIG_MODELS_CONFIG declaration alone does not surface a model.
    assert.deepEqual(list.models, []);
  });

  // --- 13. Edge: null/undefined env handling -----------------------------------

  test('null env (e.g. test isolation) falls back to node mappings', () => {
    const nodes = [node('a', { air: 'up-air' })];
    const result = getPublicModelStatus(nodes, null, new Set(), now());
    // Without a registry the backward-compat fallback picks up node-mapping
    // model names so the dashboard is not silently empty.
    assert.ok(Array.isArray(result.models));
    assert.equal(result.models.length, 1, 'fallback picks up node-mapping model');
    assert.equal(result.models[0].id, 'air');
  });

  // --- 14. Edge: half-open state -> no_record without evidence ---------------

  test('Tier 1 half-open state -> no_record without evidence, available with recent', () => {
    const nodes = [node('a', { air: 'up-air' })];
    // Tier 1 half-open is the only state that returns 'unobserved' from runtime.
    // Mark it explicitly: cooldownUntil has elapsed, halfOpenSuccesses not yet 2.
    const t1Model = getTier1Model('a', 'air');
    t1Model.failureState = 'half_open';
    t1Model.cooldownUntil = 0;
    t1Model.halfOpenSuccesses = 0;
    // No D1 evidence -> no_record (configured but never proven)
    assert.equal(findModelStatus(getPublicModelStatus(nodes, ENV, new Set(), now()), 'air'), 'no_record');
    // Recent D1 evidence -> available (proven recently)
    assert.equal(findModelStatus(getPublicModelStatus(nodes, ENV, new Set(['air']), now()), 'air'), 'available');
  });

  // --- 15. queryRecentModelEvidence: miss / hit / fail-open --------------------

  await testAsync('queryRecentModelEvidence: no binding -> empty Set', async () => {
    const out = await queryRecentModelEvidence({ AIG_ACCESS_KEY_AIR: 'k' }, MODEL_STATUS_RECENT_WINDOW_MS, now());
    assert.ok(out instanceof Set);
    assert.equal(out.size, 0);
  });

  await testAsync('queryRecentModelEvidence: persists -> returns model Set', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    // Persist one recent success.
    const h0 = Math.floor((now() - 30 * 60_000) / HOUR) * HOUR;
    const { persistTokenUsage } = await import('#target/src/observability/token-usage-store.ts');
    await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'air');
    await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'code-max');
    const out = await queryRecentModelEvidence(env, MODEL_STATUS_RECENT_WINDOW_MS, now());
    assert.equal(out.size, 2);
    assert.ok(out.has('air'));
    assert.ok(out.has('code-max'));
  });

  await testAsync('queryRecentModelEvidence: D1 read failure -> empty Set, never throws', async () => {
    const d1 = createMockD1({ failReads: true });
    const env = { TOKEN_STATS_DB: d1 };
    const out = await queryRecentModelEvidence(env, MODEL_STATUS_RECENT_WINDOW_MS, now());
    assert.ok(out instanceof Set);
    assert.equal(out.size, 0);
  });

  await testAsync('queryRecentModelEvidence: only rows in the window count', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    const h0 = Math.floor((now() - 30 * 60_000) / HOUR) * HOUR; // 30 min ago: in window
    const hOld = Math.floor((now() - 30 * HOUR) / HOUR) * HOUR; // 30h ago: out of window
    const { persistTokenUsage } = await import('#target/src/observability/token-usage-store.ts');
    await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'air');
    await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, hOld, 'oldmodel');
    const out = await queryRecentModelEvidence(env, MODEL_STATUS_RECENT_WINDOW_MS, now());
    assert.ok(out.has('air'), 'recent traffic counted');
    assert.ok(!out.has('oldmodel'), 'old traffic outside window ignored');
  });

  await testAsync('queryRecentModelEvidence: requests=0 is NOT evidence', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    const h0 = Math.floor((now() - 30 * 60_000) / HOUR) * HOUR;
    // Persist with null usage -> requests=1, reports=0, missing=1. The
    // evidence query is `requests > 0` (per-model traffic), so this DOES
    // still count as evidence. The 'reports > 0' filter would be too strict
    // (an interrupted stream with partial data is still recent activity).
    const { persistTokenUsage } = await import('#target/src/observability/token-usage-store.ts');
    await persistTokenUsage(env, null, h0, 'broken-only');
    const out = await queryRecentModelEvidence(env, MODEL_STATUS_RECENT_WINDOW_MS, now());
    assert.ok(out.has('broken-only'), 'a row with requests > 0 (even if missing-usage) still counts as recent activity');
  });

  // --- 16. Window constants: 24h recent + 7d historical ------------------------

  test('MODEL_STATUS_RECENT_WINDOW_MS is 24h; HISTORICAL is 7d', () => {
    assert.equal(MODEL_STATUS_RECENT_WINDOW_MS, 24 * 3600_000);
    assert.equal(MODEL_STATUS_HISTORICAL_WINDOW_MS, 7 * 24 * 3600_000);
  });

  // --- 17. Multi-isolate cold-start: rebuild does not flip available -> unobserved

  test('isolate rebuild does not flip a previously-available model back to unobserved', () => {
    // Isolate A served the model and recorded a sample.
    const nodes = [node('a', { air: 'up-air' })];
    recordTier1Ttft('a', 'air', 100, now() - 1000);
    // D1 also has the recent success.
    const evidence = new Set(['air']);
    const aList = getPublicModelStatus(nodes, ENV, evidence, now());
    assert.equal(findModelStatus(aList, 'air'), 'available');
    // Wipe isolate-local Tier 1 state (simulate a fresh isolate). D1 still has evidence.
    __resetTier1StateForTests();
    __resetAllStateForTests();
    const bList = getPublicModelStatus(nodes, ENV, evidence, now());
    assert.equal(findModelStatus(bList, 'air'), 'available', 'cold-start with persistent D1 evidence must remain available');
  });

  // --- 18. Three-tier aggregation: a model served only by tier 3 still works --

  test('model served by tier 3 (legacy state) is read correctly', () => {
    // Pure-tier-3 node: no Tier 1 state at all.
    const nodes = [
      {
        id: 't3',
        provider: 'mock',
        protocol: 'openai',
        surfaces: ['chat_completions'],
        base_url: 'https://t3.example.com/v1',
        tier: 'tier-3',
        models: { air: 'up-air' },
      },
    ];
    // No Tier 1 state -> runtime is 'unobserved' for this node
    const list = getPublicModelStatus(nodes, ENV, new Set(['air']), now());
    // D1 has evidence -> available (case D)
    assert.equal(findModelStatus(list, 'air'), 'available');
  });

  // --- 19. output has exactly the five documented states ----------------------

  test('output only ever returns the five documented status values', () => {
    const nodes = [node('a', { air: 'up-air' }), node('b', { max: 'up-max' })];
    // Various scenarios across recent + historical evidence combinations.
    const seen = new Set();
    for (const recent of [new Set(), new Set(['air']), new Set(['air', 'max']), new Set(['max'])]) {
      for (const history of [new Set(), new Set(['air']), new Set(['max'])]) {
        for (const arr of [nodes, [], [node('a', { air: 'up-air' })]]) {
          for (const result of [getPublicModelStatus(arr, ENV, recent, now(), history)]) {
            for (const m of result.models) seen.add(m.status);
          }
        }
      }
    }
    for (const s of seen) {
      assert.ok(['available', 'fluctuating', 'no_recent', 'no_record', 'down'].includes(s), `unexpected status: ${s}`);
    }
  });

  // --- 19b. Historical evidence: no recent but has history -> no_recent --------

  test('historical evidence without recent -> no_recent', () => {
    const nodes = [node('a', { air: 'up-air' })];
    // No recent evidence, no runtime sample (unobserved), but historical
    // evidence exists -> no_recent (was served before, just not recently).
    const list = getPublicModelStatus(nodes, ENV, new Set(), now(), new Set(['air']));
    assert.equal(findModelStatus(list, 'air'), 'no_recent');
  });

  test('all candidates down + no recent + historical -> still down', () => {
    // allDown short-circuits before historical evidence: a model whose every
    // candidate is explicitly down with no recent success is `down`, regardless
    // of older historical evidence.
    const nodes = [node('a', { air: 'up-air' })];
    const t1Model = getTier1Model('a', 'air');
    t1Model.cooldownUntil = now() + 60_000;
    t1Model.failureState = 'cooldown';
    const list = getPublicModelStatus(nodes, ENV, new Set(), now(), new Set(['air']));
    assert.equal(findModelStatus(list, 'air'), 'down');
  });

  test('canonical historical evidence matches official-cased model', () => {
    const nodes = [node('a', { 'Code-Max': 'up-cm' })];
    // Historical evidence is canonical (code-max), model is official-cased.
    const list = getPublicModelStatus(nodes, ENV, new Set(), now(), new Set(['code-max']));
    assert.equal(findModelStatus(list, 'Code-Max'), 'no_recent');
  });

  // --- 20. Dashboard wiring: queryRecentModelEvidence rides the existing 45s cache

  await testAsync('dashboard path issues queryRecentModelEvidence at most once per 45s cache window', async () => {
    const d1 = createMockD1();
    const env = { AIG_ACCESS_KEY_AIR: 'k', TOKEN_STATS_DB: d1, AIG_MODELS_CONFIG: JSON.stringify({ air: { policy: 'fast' } }) };
    const { dashboardResponse, __resetDashboardCacheForTests } = await import('#target/src/dashboard/pages.ts');
    __resetDashboardCacheForTests();
    const h0 = Math.floor((now() - 30 * 60_000) / HOUR) * HOUR;
    const { persistTokenUsage } = await import('#target/src/observability/token-usage-store.ts');
    await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'air');
    // Issue two concurrent page loads — the model-status query must be
    // coalesced by the existing dashboard cache, not re-issued.
    const readsBefore = d1._reads.length;
    const req = () => new Request('https://gateway.example.com/', { headers: { accept: 'text/html' } });
    const [h1, h2] = await Promise.all([(await dashboardResponse(req(), env)).text(), (await dashboardResponse(req(), env)).text()]);
    // Each render mints its own CSP nonce, so strip it before comparing.
    const stripNonce = (html) => html.replace(/nonce="[^"]*"/g, 'nonce=""');
    assert.equal(stripNonce(h1), stripNonce(h2), 'cached');
    // Two concurrent pages should add at most ONE new read of the model table
    // (the cache coalesces). The recent-evidence and historical-evidence queries
    // are both GROUP BY model and distinct from the model-usage GROUP BY model
    // query, so the cache window adds 2 evidence reads plus 1 TTFT read.
    const readsAfter = d1._reads.length;
    const delta = readsAfter - readsBefore;
    assert.ok(delta <= 9, `expected <=9 reads for one page load, got ${delta}`);
  });

  // --- 21. Config-driven model order and grouping ------------------------------

  test('config-driven model order: display_order controls sort order', () => {
    const env = {
      AIG_ACCESS_KEY_AIR: 'k',
      AIG_MODELS_CONFIG: JSON.stringify({
        alpha: { policy: 'default', display_order: 30, group: 'general' },
        beta: { policy: 'default', display_order: 10, group: 'general' },
        gamma: { policy: 'default', display_order: 20, group: 'general' },
      }),
    };
    const nodes = [node('n1', { alpha: 'up', beta: 'up', gamma: 'up' })];
    const list = getPublicModelStatus(nodes, env, new Set(['alpha', 'beta', 'gamma']), now());
    assert.deepEqual(
      list.models.map((m) => m.id),
      ['beta', 'gamma', 'alpha'],
    );
  });

  test('config-driven grouping: group field controls which block a model appears in', () => {
    const env = {
      AIG_ACCESS_KEY_AIR: 'k',
      AIG_MODELS_CONFIG: JSON.stringify({
        air: { policy: 'default', display_order: 10, group: 'general' },
        pro: { policy: 'default', display_order: 20, group: 'general' },
        codeair: { policy: 'default', display_order: 10, group: 'coding' },
        codepro: { policy: 'default', display_order: 20, group: 'coding' },
      }),
    };
    const nodes = [node('n1', { air: 'up', pro: 'up', codeair: 'up', codepro: 'up' })];
    const list = getPublicModelStatus(nodes, env, new Set(['air', 'pro', 'codeair', 'codepro']), now());
    const generalModels = list.models.filter((m) => m.group === 'general');
    const codingModels = list.models.filter((m) => m.group === 'coding');
    assert.deepEqual(
      generalModels.map((m) => m.id),
      ['air', 'pro'],
    );
    assert.deepEqual(
      codingModels.map((m) => m.id),
      ['codeair', 'codepro'],
    );
  });

  test('display_order missing uses default 100', () => {
    const env = {
      AIG_ACCESS_KEY_AIR: 'k',
      AIG_MODELS_CONFIG: JSON.stringify({
        zebra: { policy: 'default' },
        alpha: { policy: 'default', display_order: 10 },
      }),
    };
    const nodes = [node('n1', { zebra: 'up', alpha: 'up' })];
    const list = getPublicModelStatus(nodes, env, new Set(['zebra', 'alpha']), now());
    assert.deepEqual(
      list.models.map((m) => m.id),
      ['alpha', 'zebra'],
    );
  });

  test('group missing defaults to general', () => {
    const env = {
      AIG_ACCESS_KEY_AIR: 'k',
      AIG_MODELS_CONFIG: JSON.stringify({
        solo: { policy: 'default', display_order: 5 },
      }),
    };
    const nodes = [node('n1', { solo: 'up' })];
    const list = getPublicModelStatus(nodes, env, new Set(['solo']), now());
    assert.equal(list.models[0].group, 'general');
  });

  test('node-mapped model without AIG_MODELS_CONFIG gets default order=100 and group=general', () => {
    const nodes = [node('n1', { mymodel: 'up' })];
    const list = getPublicModelStatus(nodes, ENV, new Set(['mymodel']), now());
    assert.equal(list.models[0].display_order, 100);
    assert.equal(list.models[0].group, 'general');
  });

  // --- 22. v1.2.7 Model Governance: ui_visible and 10-model catalog ---------

  test('ui_visible=false hides model from public status', () => {
    const env = {
      AIG_ACCESS_KEY_AIR: 'k',
      AIG_MODELS_CONFIG: JSON.stringify({
        Air: { policy: 'default', group: 'general', ui_visible: true },
        Omni: { policy: 'default', group: 'omni', ui_visible: false },
      }),
    };
    const nodes = [node('n1', { Air: 'up', Omni: 'up' })];
    const list = getPublicModelStatus(nodes, env, new Set(['Air', 'Omni']), now());
    assert.deepEqual(
      list.models.map((m) => m.id),
      ['Air'],
    );
  });

  test('ui_visible defaults to true when not specified', () => {
    const env = {
      AIG_ACCESS_KEY_AIR: 'k',
      AIG_MODELS_CONFIG: JSON.stringify({
        Air: { policy: 'default', group: 'general' },
      }),
    };
    const nodes = [node('n1', { Air: 'up' })];
    const list = getPublicModelStatus(nodes, env, new Set(['Air']), now());
    assert.equal(list.models.length, 1);
    assert.equal(list.models[0].id, 'Air');
  });

  test('Omni and OCR excluded from public status with ui_visible=false', () => {
    const env = {
      AIG_ACCESS_KEY_AIR: 'k',
      AIG_MODELS_CONFIG: JSON.stringify({
        Air: { policy: 'default', group: 'general', ui_visible: true, display_order: 10 },
        Pro: { policy: 'default', group: 'general', ui_visible: true, display_order: 20 },
        Max: { policy: 'default', group: 'general', ui_visible: true, display_order: 30 },
        Ultra: { policy: 'default', group: 'general', ui_visible: true, display_order: 40 },
        'Code-Air': { policy: 'default', group: 'code', ui_visible: true, display_order: 10 },
        'Code-Pro': { policy: 'default', group: 'code', ui_visible: true, display_order: 20 },
        'Code-Max': { policy: 'default', group: 'code', ui_visible: true, display_order: 30 },
        'Code-Ultra': { policy: 'default', group: 'code', ui_visible: true, display_order: 40 },
        Omni: { policy: 'default', group: 'omni', ui_visible: false, display_order: 10 },
        OCR: { policy: 'default', group: 'ocr', ui_visible: false, display_order: 10 },
      }),
    };
    const nodes = [
      node('n1', {
        Air: 'up',
        Pro: 'up',
        Max: 'up',
        Ultra: 'up',
        'Code-Air': 'up',
        'Code-Pro': 'up',
        'Code-Max': 'up',
        'Code-Ultra': 'up',
        Omni: 'up',
        OCR: 'up',
      }),
    ];
    const list = getPublicModelStatus(
      nodes,
      env,
      new Set(['Air', 'Pro', 'Max', 'Ultra', 'Code-Air', 'Code-Pro', 'Code-Max', 'Code-Ultra', 'Omni', 'OCR']),
      now(),
    );
    const ids = list.models.map((m) => m.id);
    assert.deepEqual(ids, ['Air', 'Pro', 'Max', 'Ultra', 'Code-Air', 'Code-Pro', 'Code-Max', 'Code-Ultra']);
    assert.ok(!ids.includes('Omni'), 'Omni must not appear in public status');
    assert.ok(!ids.includes('OCR'), 'OCR must not appear in public status');
  });

  test('group values: general, code, omni, ocr from config', () => {
    const env = {
      AIG_ACCESS_KEY_AIR: 'k',
      AIG_MODELS_CONFIG: JSON.stringify({
        Air: { policy: 'default', group: 'general', ui_visible: true },
        'Code-Air': { policy: 'default', group: 'code', ui_visible: true },
        Omni: { policy: 'default', group: 'omni', ui_visible: false },
        OCR: { policy: 'default', group: 'ocr', ui_visible: false },
      }),
    };
    const nodes = [node('n1', { Air: 'up', 'Code-Air': 'up', Omni: 'up', OCR: 'up' })];
    const list = getPublicModelStatus(nodes, env, new Set(['Air', 'Code-Air', 'Omni', 'OCR']), now());
    // Only Air and Code-Air are ui_visible=true
    const air = list.models.find((m) => m.id === 'Air');
    const codeAir = list.models.find((m) => m.id === 'Code-Air');
    assert.equal(air.group, 'general');
    assert.equal(codeAir.group, 'code');
  });

  test('deriveGroup fallback: Code- prefix -> code, Omni -> omni, OCR -> ocr', () => {
    // No AIG_MODELS_CONFIG, so deriveGroup is the fallback
    const nodes = [node('n1', { Air: 'up', 'Code-Max': 'up', Omni: 'up', OCR: 'up' })];
    const list = getPublicModelStatus(nodes, null, new Set(['Air', 'Code-Max', 'Omni', 'OCR']), now());
    const air = list.models.find((m) => m.id === 'Air');
    const codeMax = list.models.find((m) => m.id === 'Code-Max');
    const omni = list.models.find((m) => m.id === 'Omni');
    const ocr = list.models.find((m) => m.id === 'OCR');
    assert.equal(air.group, 'general');
    assert.equal(codeMax.group, 'code');
    assert.equal(omni.group, 'omni');
    assert.equal(ocr.group, 'ocr');
  });

  test('ui_visible=false with visibility=public still hidden from public status', () => {
    const env = {
      AIG_ACCESS_KEY_AIR: 'k',
      AIG_MODELS_CONFIG: JSON.stringify({
        Omni: { policy: 'default', visibility: 'public', ui_visible: false, group: 'omni' },
      }),
    };
    const nodes = [node('n1', { Omni: 'up' })];
    const list = getPublicModelStatus(nodes, env, new Set(['Omni']), now());
    assert.equal(list.models.length, 0);
  });

  // --- 23. Evidence canonicalization: statistics key vs official model ID ------
  //
  // D1 statistics keys are trim + lowercase; official logical model IDs keep
  // their official casing. Matching must always go through the canonical
  // statistics key — a model named `Code-Max` must find its `code-max`
  // evidence row, in every case variant, without touching routing/auth
  // model-ID semantics.

  test('canonical evidence: logical Code-Max matches lowercase code-max evidence', () => {
    const nodes = [node('a', { 'Code-Max': 'up-cm' })];
    const list = getPublicModelStatus(nodes, ENV, new Set(['code-max']), now());
    assert.equal(findModelStatus(list, 'Code-Max'), 'available', 'lowercase stats evidence must count as recent for the official ID');
  });

  test('canonical evidence: every evidence case variant yields the same result', () => {
    const nodes = [node('a', { 'Code-Max': 'up-cm' })];
    for (const variant of ['CODE-MAX', 'Code-Max', 'code-max', ' Code-Max ']) {
      const list = getPublicModelStatus(nodes, ENV, new Set([variant]), now());
      assert.equal(findModelStatus(list, 'Code-Max'), 'available', `evidence variant "${variant}"`);
    }
  });

  test('canonical evidence drives the fluctuating state too', () => {
    const nodes = [node('a', { 'Code-Max': 'up-cm' })];
    const t1Model = getTier1Model('a', 'Code-Max');
    t1Model.cooldownUntil = now() + 60_000;
    t1Model.failureState = 'cooldown';
    // Lowercase D1 evidence for an officially-cased model must still produce
    // `fluctuating` (transient outage with recent success), not `down`.
    const list = getPublicModelStatus(nodes, ENV, new Set(['code-max']), now());
    assert.equal(findModelStatus(list, 'Code-Max'), 'fluctuating');
  });

  test('canonicalization does not alter the official model ID surface', () => {
    const nodes = [node('a', { 'Code-Max': 'up-cm' })];
    const list = getPublicModelStatus(nodes, ENV, new Set(['code-max']), now());
    assert.deepEqual(
      list.models.map((m) => m.id),
      ['Code-Max'],
      'public output keeps the official logical ID; only evidence matching is canonical',
    );
  });

  console.log(`\nmodel-status tests: ${passed} passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  } else {
    console.log('All model-status tests passed.');
  }
  console.log('ok - file:model-status');
} catch (error) {
  console.error('not ok - model-status-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// model-status-window-contract-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs
  //
  // Model Status Recent-Evidence Window Contract.
  //
  // Design fact: the Public Model Status "Recent Evidence" window is exactly
  // MODEL_STATUS_RECENT_WINDOW_MS (24h), with ONE definition point next to the
  // D1 query that parameterizes it. A previous drift had the dashboard call the
  // evidence query with a hardcoded 7-day window, so design (24h) and behavior
  // (7d) diverged. These contracts pin the single source and keep the magic
  // numbers out of the evidence chain:
  //
  //   C01  The window constants are defined exactly once (token-usage-store
  //        queries.ts): 24h recent + 7d historical, exported through the store
  //        facade and re-exported by src/runtime/model-status.ts — same binding.
  //   C02  queryRecentModelEvidence defaults to the 24h constant.
  //   C03  23h-old success IS recent evidence; 25h-old is NOT (default window).
  //   C04  The dashboard passes the constants: recent-evidence 24h, TTFT 24h,
  //        historical-evidence 7d — not magic numbers.
  //   C05  No second RECENT-evidence window literal (7d / 168h / 604800000) in
  //        the evidence chain modules (the 7d HISTORICAL window uses DAY_MS).





  const HOUR = 3_600_000;
  const now = () => 1_700_000_000_000;

  let failures = 0;
  function check(name, ok, detail) {
    if (ok) console.log(`  ok  ${name}`);
    else {
      failures++;
      console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
  }

  // ---- C01: one definition, consistent re-exports ------------------------------
  const storeConstant = (await import('#target/src/observability/token-usage-store.ts')).MODEL_STATUS_RECENT_WINDOW_MS;
  const runtimeConstant = (await import('#target/src/runtime/model-status.ts')).MODEL_STATUS_RECENT_WINDOW_MS;
  check(
    'C01 store and runtime expose the SAME 24h binding',
    storeConstant === runtimeConstant && runtimeConstant === 24 * HOUR,
    `store=${storeConstant} runtime=${runtimeConstant}`,
  );
  const storeHist = (await import('#target/src/observability/token-usage-store.ts')).MODEL_STATUS_HISTORICAL_WINDOW_MS;
  const runtimeHist = (await import('#target/src/runtime/model-status.ts')).MODEL_STATUS_HISTORICAL_WINDOW_MS;
  check(
    'C01 store and runtime expose the SAME 7d historical binding',
    storeHist === runtimeHist && runtimeHist === 7 * 24 * HOUR,
    `store=${storeHist} runtime=${runtimeHist}`,
  );

  // ---- C02 + C03: default window is the constant; boundary behavior -------------
  {
    const { queryRecentModelEvidence, persistTokenUsage } = await import('#target/src/observability/token-usage-store.ts');
    const { createMockD1 } = await import('#kit/mock-d1-database.mjs');

    const src = readFileSync(join(root, 'src/observability/token-usage-store/queries.ts'), 'utf8');
    check(
      'C02 queryRecentModelEvidence default window is the constant',
      /queryRecentModelEvidence\(\s*env: GatewayEnv,\s*windowMs: number = MODEL_STATUS_RECENT_WINDOW_MS/.test(src) &&
        /export const MODEL_STATUS_RECENT_WINDOW_MS = 24 \* HOUR_MS;/.test(src),
    );

    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    const h23 = Math.floor((now() - 23 * HOUR) / HOUR) * HOUR; // in window
    const h25 = Math.floor((now() - 25 * HOUR) / HOUR) * HOUR; // out of window
    await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h23, 'in-23h');
    await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h25, 'out-25h');
    const evidence = await queryRecentModelEvidence(env, undefined, now());
    check(
      'C03 23h-old success is evidence, 25h-old is not',
      evidence.has('in-23h') && !evidence.has('out-25h'),
      `evidence=${JSON.stringify([...evidence])}`,
    );
  }

  // ---- C04 + C05: dashboard call site and magic-number ban ----------------------
  {
    const usageView = readFileSync(join(root, 'src/dashboard/usage-view.ts'), 'utf8');
    check(
      'C04 dashboard recent-evidence call passes MODEL_STATUS_RECENT_WINDOW_MS',
      /queryRecentModelEvidence\(env, MODEL_STATUS_RECENT_WINDOW_MS, now\)/.test(usageView),
    );
    check(
      'C04b dashboard TTFT call passes MODEL_STATUS_RECENT_WINDOW_MS (24h)',
      /queryAllModelsTtftPercentiles\(env, MODEL_STATUS_RECENT_WINDOW_MS, now\)/.test(usageView),
    );
    check(
      'C04c dashboard historical-evidence call passes MODEL_STATUS_HISTORICAL_WINDOW_MS (7d)',
      /queryRecentModelEvidence\(env, MODEL_STATUS_HISTORICAL_WINDOW_MS, now\)/.test(usageView),
    );

    const banned = [/7 \* 24 \* 60 \* 60 \* 1000/, /604_?800_000/, /168 \* 60 \* 60 \* 1000/, /168 \* HOUR/, /7 \* 24 \* HOUR/];
    const chainFiles = [
      'src/dashboard/usage-view.ts',
      'src/dashboard/pages.ts',
      'src/dashboard/model-status-view.ts',
      'src/runtime/model-status.ts',
      'src/observability/token-usage-store/queries.ts',
    ];
    let hit = '';
    for (const f of chainFiles) {
      const src = readFileSync(join(root, f), 'utf8');
      for (const re of banned) {
        if (re.test(src)) hit += `${f}:${re} `;
      }
    }
    check('C05 no second RECENT-evidence window literal in the chain', hit === '', hit);
    // The runtime module must re-export both constants, not redefine them.
    const runtimeSrc = readFileSync(join(root, 'src/runtime/model-status.ts'), 'utf8');
    check(
      'C05b runtime model-status re-exports both window constants (no redefine)',
      /export \{[^}]*MODEL_STATUS_RECENT_WINDOW_MS[^}]*\} from '\.\.\/observability\/token-usage-store\.ts'/.test(runtimeSrc) &&
        /export \{[^}]*MODEL_STATUS_HISTORICAL_WINDOW_MS[^}]*\} from '\.\.\/observability\/token-usage-store\.ts'/.test(runtimeSrc) &&
        !/MODEL_STATUS_RECENT_WINDOW_MS = 24 \* 3600_000/.test(runtimeSrc) &&
        !/MODEL_STATUS_HISTORICAL_WINDOW_MS = /.test(runtimeSrc),
    );
  }

  if (failures > 0) {
    console.error(`model-status-window-contract: ${failures} contract(s) FAILED`);
    suiteExit(1);
  }
  console.log('model-status-window-contract: all contracts passed');
  console.log('ok - file:model-status-window-contract');
} catch (error) {
  console.error('not ok - model-status-window-contract-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// model-catalog-policy-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs
  //
  // Model catalog / runtime policy separation contracts:
  //   - catalog facts (capabilities, reasoning efforts, modalities) and
  //     runtime policy (failover policy binding, visibility, UI grouping)
  //     are distinct concepts with disjoint field ownership
  //   - the flat AIG_MODELS_CONFIG operator schema is unchanged
  //   - adding a model (and even a new model family) is configuration-only:
  //     no router, scheduler, reliability, or transport source change








  let passed = 0;
  function test(name, fn) {
    try {
      fn();
      passed++;
      console.log(`ok - ${name}`);
    } catch (e) {
      console.error(`FAIL - ${name}`);
      console.error(e?.stack || e);
      process.exitCode = 1;
    }
  }

  const ACCESS_KEY = 'model-catalog-policy-test-key';
  const FLAT_ENTRY = {
    policy: 'fast',
    capabilities: { vision: true },
    reasoning_efforts: ['high'],
    modalities: { input: ['text', 'image'], output: ['text'] },
    visibility: 'internal',
    display_order: 7,
    group: 'lab',
    ui_visible: false,
  };
  const ENV_WITH_ENTRY = { AIG_MODELS_CONFIG: JSON.stringify({ 'code-pro': FLAT_ENTRY }) };

  test('the operator-facing AIG_MODELS_CONFIG schema stays flat', () => {
    assert.deepEqual(getModelsConfigDiagnostics(ENV_WITH_ENTRY), [], 'a pre-separation flat entry must parse without any diagnostic');
    const models = loadModelsConfig(ENV_WITH_ENTRY);
    assert.ok(models['code-pro'], 'entry loads');
  });

  test('catalog facts and runtime policy resolve into disjoint concepts', () => {
    const reg = loadModelRegistry(ENV_WITH_ENTRY);
    const entry = reg['code-pro'];
    const catalogKeys = Object.keys(entry.catalog).sort();
    const policyKeys = Object.keys(entry.policy).sort();
    assert.deepEqual(catalogKeys, ['capabilities', 'modalities', 'reasoning_efforts']);
    assert.deepEqual(policyKeys, ['display_order', 'group', 'policy', 'ui_visible', 'visibility']);
    for (const key of policyKeys) {
      assert.ok(!(key in entry.catalog), `policy field "${key}" must not appear on catalog facts`);
    }
    for (const key of catalogKeys) {
      assert.ok(!(key in entry.policy), `catalog field "${key}" must not appear on runtime policy`);
    }
  });

  test('each side keeps its declared values and independent defaults', () => {
    const reg = loadModelRegistry(ENV_WITH_ENTRY);
    const entry = reg['code-pro'];
    assert.deepEqual(
      entry.catalog.capabilities,
      { tools: false, reasoning: false, vision: true, stream: true, ocr: false },
      'catalog defaults merge with declared capabilities',
    );
    assert.deepEqual(entry.catalog.reasoning_efforts, ['high']);
    assert.deepEqual(entry.catalog.modalities, { input: ['text', 'image'], output: ['text'] });
    assert.deepEqual(entry.policy, { policy: 'fast', visibility: 'internal', display_order: 7, group: 'lab', ui_visible: false });

    const plain = loadModelRegistry({ AIG_MODELS_CONFIG: '{"fresh-model":{}}' })['fresh-model'];
    assert.deepEqual(plain.catalog.capabilities, { tools: false, reasoning: false, vision: false, stream: true, ocr: false });
    assert.deepEqual(plain.catalog.reasoning_efforts, []);
    assert.equal('modalities' in plain.catalog, false);
    assert.deepEqual(plain.policy, { policy: 'default', visibility: 'public', display_order: 100, group: 'general', ui_visible: true });
  });

  test('unknown models get the same conservative catalog/policy defaults', () => {
    const def = modelRegistryEntry({}, 'never-configured');
    assert.equal(def.catalog.capabilities.tools, false);
    assert.deepEqual(def.catalog.reasoning_efforts, []);
    assert.equal(def.policy.policy, 'default');
    assert.equal(def.policy.visibility, 'public');
  });

  test('policy tier inference stays unchanged (Air fast / tiered long-reasoning)', () => {
    const builtins = loadPoliciesConfig({});
    const models = loadModelsConfig({ AIG_MODELS_CONFIG: JSON.stringify({ 'Code-Air': {}, 'Code-Pro': {} }) });
    assert.equal(getPolicy('Code-Air', models, builtins), builtins.fast);
    assert.equal(getPolicy('Code-Pro', models, builtins), builtins['long-reasoning']);
    assert.equal(getPolicy('Anything', models, builtins), builtins.default);
  });

  test('new model families stay data-driven through the known-model catalog', () => {
    const known = new Set(['Draft-Ultra', 'Draft-Max', 'Draft-Pro']);
    const rounds = buildModelFallbackRounds('Draft-Ultra', known);
    assert.deepEqual(
      rounds[0],
      ['Draft-Ultra', 'Draft-Max', 'Draft-Pro'],
      'an arbitrary future family needs no source change, only catalog/config entries',
    );
  });

  // ---- Scenario: adding a model is configuration-only, end to end ----

  const rawNode = (id, models) => ({
    id,
    provider: 'mock',
    base_url: `https://${id}.example.com/v1`,
    models,
  });
  const envFor = (nodes, extra = {}) => ({
    AIG_ACCESS_KEY_ULTRA: ACCESS_KEY,
    AIG_ACCESS_MODELS_ULTRA: '*',
    AIG_PROTOCOL_FALLBACKS: 'disable',
    TIER1_SCHEDULER_SEED: 'model-catalog-policy',
    AIG_TIER1_NODES_01: JSON.stringify(nodes),
    AIG_TIER1_CREDENTIALS_01: JSON.stringify(Object.fromEntries(nodes.map((n) => [n.id, `secret-${n.id}`]))),
    ...extra,
  });

  test('scenario: a brand-new model routes and reports via configuration alone', async () => {
    const upstreamCalls = [];
    const finish = () => {
      globalThis.fetch = undefined;
    };
    globalThis.fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      upstreamCalls.push(url.hostname);
      assert.equal(url.pathname, '/v1/chat/completions');
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-x',
          object: 'chat.completion',
          model: 'gpt-brand-new',
          choices: [{ index: 0, message: { role: 'assistant', content: 'fresh model served' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    try {
      const env = envFor([rawNode('brand-new-node', { 'Brand-New': 'gpt-brand-new' })], {
        AIG_MODELS_CONFIG: JSON.stringify({
          'Brand-New': { capabilities: { tools: true }, reasoning_efforts: ['medium'] },
        }),
      });

      const chat = await worker.fetch(
        new Request('https://gateway.example.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
          body: JSON.stringify({ model: 'Brand-New', messages: [{ role: 'user', content: 'hi' }] }),
        }),
        env,
        {},
      );
      assert.equal(chat.status, 200, 'the new model must be callable with zero source changes');
      assert.match(await chat.text(), /fresh model served/);
      assert.deepEqual(upstreamCalls, ['brand-new-node.example.com']);

      const list = await worker.fetch(
        new Request('https://gateway.example.com/v1/models', {
          headers: { authorization: `Bearer ${ACCESS_KEY}` },
        }),
        env,
        {},
      );
      assert.equal(list.status, 200);
      const payload = await list.json();
      const entry = payload.data.find((m) => m.id === 'Brand-New');
      assert.ok(entry, 'the new model appears in /v1/models driven by its catalog facts');
      assert.equal(entry.supports_tools, true);
      assert.deepEqual(entry.reasoning_efforts, ['medium']);
    } finally {
      finish();
    }
  });

  console.log(`[model-catalog-policy-test] ${passed} checks passed`);
  console.log('ok - file:model-catalog-policy');
} catch (error) {
  console.error('not ok - model-catalog-policy-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// model-discovery-live-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT





  const GENERIC_SECRET = 'never-print-generic-key';
  const OPENAI_SECRET = 'never-print-openai-key';
  const ANTHROPIC_SECRET = 'never-print-anthropic-key';
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

  // Node Config stays account-level only. Discovery must derive protocol/surfaces
  // from the same Provider Wire Profile used by runtime.
  const env = {
    AIG_TIER1_NODES_01: JSON.stringify([
      {
        id: 'provider-a-01',
        provider: 'provider-a',
        base_url: 'https://provider.example.com/v1',
        models: { Pro: 'old-upstream-name' },
      },
      {
        id: 'openai-01',
        provider: 'openai',
        base_url: 'https://openai.example.com',
        models: { Pro: 'gpt-test' },
      },
      {
        id: 'anthropic-01',
        provider: 'anthropic',
        base_url: 'https://anthropic.example.com',
        models: { Pro: 'claude-test' },
      },
    ]),
    AIG_TIER1_CREDENTIALS_01: JSON.stringify({
      'provider-a-01': GENERIC_SECRET,
      'openai-01': OPENAI_SECRET,
      'anthropic-01': ANTHROPIC_SECRET,
    }),
  };

  const nodes = collectDiscoveryNodes(env);
  assert.equal(nodes.length, 3);
  for (const node of nodes) {
    const profile = providerWire(node.provider);
    assert.equal(node.protocol, profile.protocol);
    assert.deepEqual(node.configuredSurfaces, [...profile.surfaces]);
  }
  const genericNode = nodes.find((node) => node.id === 'provider-a-01');
  const openaiNode = nodes.find((node) => node.id === 'openai-01');
  const anthropicNode = nodes.find((node) => node.id === 'anthropic-01');
  assert.deepEqual(genericNode.configuredSurfaces, ['chat_completions']);
  assert.deepEqual(openaiNode.configuredSurfaces, ['chat_completions', 'responses']);
  assert.equal(anthropicNode.protocol, 'anthropic');
  assert.deepEqual(anthropicNode.configuredSurfaces, ['messages']);

  // Discovery must accept the same narrow browser/IME punctuation repair as the
  // deployment bridge.
  const punctuationEnv = {
    AIG_TIER1_NODES_03: '[{"id":"cfworkers-02","provider":"cfworkers","base_url":"https://api.example.com/v1","models":{"Pro":"upstream"}、}]',
    AIG_TIER1_CREDENTIALS_03: JSON.stringify({ 'cfworkers-02': GENERIC_SECRET }),
  };
  const punctuationNodes = collectDiscoveryNodes(punctuationEnv);
  assert.equal(punctuationNodes.length, 1);
  assert.equal(punctuationNodes[0].id, 'cfworkers-02');
  assert.equal(punctuationNodes[0].protocol, 'openai');
  assert.deepEqual(punctuationNodes[0].configuredSurfaces, ['chat_completions']);

  const genericCalls = [];
  const genericFetch = async (input, init = {}) => {
    const url = new URL(String(input));
    genericCalls.push({ url: url.toString(), method: init.method, headers: init.headers });
    assert.equal(init.headers.authorization, `Bearer ${GENERIC_SECRET}`);
    if (init.method === 'GET' && url.pathname === '/v1/models') {
      return new Response(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-a' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname === '/v1/chat/completions') return new Response('{"error":"missing model"}', { status: 400 });
    throw new Error(`unexpected generic-provider URL: ${url}`);
  };

  const currentNode = await scanDiscoveryNode(genericNode, { fetchImpl: genericFetch, lookupImpl: publicLookup });
  assert.equal(currentNode.status, 'ok');
  assert.deepEqual(currentNode.models, ['model-a', 'model-b']);
  assert.equal(currentNode.capabilities.chat_completions.status, 'supported');
  assert.equal(currentNode.capabilities.responses, undefined);
  assert.ok(genericCalls.some((c) => new URL(c.url).pathname === '/v1/models'));
  assert.ok(!JSON.stringify(currentNode).includes(GENERIC_SECRET), 'sanitized result must never include credential material');

  // Native OpenAI owns both Chat Completions and Responses in the shared profile.
  const openaiFetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(init.headers.authorization, `Bearer ${OPENAI_SECRET}`);
    if (init.method === 'GET') {
      return new Response(JSON.stringify({ data: [{ id: 'gpt-test' }] }), { status: 200 });
    }
    if (url.pathname === '/v1/chat/completions') return new Response('{}', { status: 400 });
    if (url.pathname === '/v1/responses') return new Response('', { status: 404 });
    throw new Error(`unexpected OpenAI URL: ${url}`);
  };
  const openaiResult = await scanDiscoveryNode(openaiNode, { fetchImpl: openaiFetch, lookupImpl: publicLookup });
  assert.equal(openaiResult.status, 'ok');
  assert.equal(openaiResult.capabilities.chat_completions.status, 'supported');
  assert.equal(openaiResult.capabilities.responses.status, 'unsupported');

  const previous = {
    schema_version: 1,
    generated_at: '2026-09-11T00:00:00.000Z',
    nodes: [
      {
        node_id: 'provider-a-01',
        provider: 'provider-a',
        status: 'ok',
        models: ['model-a', 'model-old'],
        capabilities: {},
      },
    ],
  };
  const current = {
    schema_version: 1,
    generated_at: '2026-09-12T00:00:00.000Z',
    nodes: [currentNode],
  };
  const diff = diffModelSnapshots(previous, current);
  assert.equal(diff.has_baseline, true);
  assert.deepEqual(diff.changes[0].added, ['model-b']);
  assert.deepEqual(diff.changes[0].removed, ['model-old']);
  assert.deepEqual(diff.changes[0].unchanged, ['model-a']);
  const md = formatDiscoveryMarkdown(previous, current, diff);
  assert.match(md, /Added: 1; Removed: 1; Unchanged: 1/);
  assert.match(md, /\+ model-b/);
  assert.match(md, /- model-old/);

  // A scan failure must never be presented as every previous model disappearing.
  const failedCurrent = {
    schema_version: 1,
    generated_at: '2026-09-12T01:00:00.000Z',
    nodes: [
      {
        node_id: 'provider-a-01',
        provider: 'provider-a',
        status: 'scan_failed',
        models: [],
        capabilities: {},
        error: 'HTTP 503',
      },
    ],
  };
  const failedDiff = diffModelSnapshots(previous, failedCurrent);
  assert.deepEqual(failedDiff.changes[0].removed, []);
  assert.deepEqual(failedDiff.changes[0].unchanged, ['model-a', 'model-old']);

  // Anthropic config contains no protocol/surfaces fields. Discovery still uses
  // native x-api-key auth and probes /v1/messages because the provider profile
  // is the single wire contract.
  let anthropicMessagesProbe = false;
  const anthropicFetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(init.headers['x-api-key'], ANTHROPIC_SECRET);
    assert.equal(init.headers['anthropic-version'], '2023-06-01');
    assert.equal(init.headers.authorization, undefined);
    if (init.method === 'GET') {
      return new Response(JSON.stringify({ data: [{ id: 'claude-test' }] }), { status: 200 });
    }
    if (url.pathname === '/v1/messages') {
      anthropicMessagesProbe = true;
      return new Response('{}', { status: 422 });
    }
    throw new Error(`unexpected anthropic URL: ${url}`);
  };
  const anthropicResult = await scanDiscoveryNode(anthropicNode, { fetchImpl: anthropicFetch, lookupImpl: publicLookup });
  assert.equal(anthropicResult.status, 'ok');
  assert.deepEqual(anthropicResult.models, ['claude-test']);
  assert.equal(anthropicResult.capabilities.messages.status, 'supported');
  assert.equal(anthropicMessagesProbe, true);
  assert.ok(!JSON.stringify(anthropicResult).includes(ANTHROPIC_SECRET));

  console.log('live model discovery tests passed.');
  console.log('ok - file:model-discovery-live');
} catch (error) {
  console.error('not ok - model-discovery-live-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// closed-catalog-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Closed Model Catalog regression contracts.





  let passed = 0;
  function test(name, fn) {
    try {
      fn();
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (error) {
      console.error(`FAIL: ${name}`);
      console.error(error?.stack || error);
      process.exitCode = 1;
    }
  }

  const node = (id, models) => ({
    id,
    provider: 'mock',
    tier: 'tier-1',
    protocol: 'openai',
    surfaces: ['chat_completions'],
    baseUrl: `https://${id}.example.com/v1`,
    credential: 'secret',
    priority: 10,
    models,
  });
  const wildcard = (id) => node(id, {});
  const requestFor = (model) => ({ model, protocol: 'openai', surface: 'chat_completions' });
  const allowAll = { authorized: true, allowAll: true, allowlist: new Set() };
  const allowlist = (...models) => ({ authorized: true, allowAll: false, allowlist: new Set(models) });

  test('wildcard + empty catalog rejects arbitrary model', () => {
    const n = wildcard('w1');
    const known = collectKnownModels([n], {});
    assert.equal(known.size, 0);
    assert.deepEqual(authorizeModel('gpt-unknown', known, allowAll), { allowed: false, status: 404 });
    assert.equal(servesModel(n, 'gpt-unknown', known), false);
    assert.equal(supportsRequest(n, requestFor('gpt-unknown'), known), false);
  });

  test('AIG_MODELS_CONFIG can bound an intentional wildcard node', () => {
    const n = wildcard('w1');
    const env = { AIG_MODELS_CONFIG: JSON.stringify({ 'Code-Max': { policy: 'default' } }) };
    const known = collectKnownModels([n], env);
    assert.ok(known.has('Code-Max'));
    assert.deepEqual(authorizeModel('Code-Max', known, allowAll), { allowed: true });
    assert.equal(servesModel(n, 'Code-Max', known), true);
    assert.equal(supportsRequest(n, requestFor('Code-Max'), known), true);
  });

  test('wildcard never expands beyond the known catalog', () => {
    const n = wildcard('w1');
    const known = collectKnownModels([n], { AIG_MODELS_CONFIG: JSON.stringify({ 'Code-Max': {} }) });
    for (const unknown of ['gpt-4.1', 'made-up-model', 'anything']) {
      assert.equal(authorizeModel(unknown, known, allowAll).allowed, false);
      assert.equal(servesModel(n, unknown, known), false);
      assert.equal(supportsRequest(n, requestFor(unknown), known), false);
    }
  });

  test('known catalog is the union of explicit node mappings and AIG_MODELS_CONFIG', () => {
    const nodes = [node('n1', { 'Code-Pro': 'up-pro', Air: 'up-air' })];
    const env = { AIG_MODELS_CONFIG: JSON.stringify({ 'Code-Max': { policy: 'default' }, Omni: {} }) };
    const known = collectKnownModels(nodes, env);
    assert.deepEqual([...known].sort(), ['Air', 'Code-Max', 'Code-Pro', 'Omni']);
  });

  test('mapped node serves only its declared logical models', () => {
    const n = node('n1', { Air: 'up-air' });
    const known = collectKnownModels([n], {});
    assert.equal(isWildcardNode(n), false);
    assert.equal(servesModel(n, 'Air', known), true);
    assert.equal(servesModel(n, 'Pro', known), false);
  });

  test('wildcard requires an explicit known catalog even when called directly', () => {
    const n = wildcard('w1');
    assert.equal(isWildcardNode(n), true);
    assert.equal(servesModel(n, 'anything'), false);
    assert.equal(servesModel(n, 'anything', new Set()), false);
    assert.equal(servesModel(n, 'Air', new Set(['Air'])), true);
  });

  test('allow-all visible models are exactly the known catalog', () => {
    const nodes = [node('n1', { Air: 'up-air', 'Code-Pro': 'up-pro' }), wildcard('w1')];
    const known = collectKnownModels(nodes, { AIG_MODELS_CONFIG: JSON.stringify({ 'Code-Max': {} }) });
    const visible = filterVisibleModels(known, allowAll);
    assert.deepEqual(visible, [...known].sort());
    for (const model of visible) {
      assert.equal(authorizeModel(model, known, allowAll).allowed, true);
      assert.equal(supportsRequest(wildcard('w1'), requestFor(model), known), true);
    }
  });

  test('per-key allowlist is intersected with the known catalog', () => {
    const known = collectKnownModels([node('n1', { Air: 'a', 'Code-Pro': 'p' })], {
      AIG_MODELS_CONFIG: JSON.stringify({ 'Code-Max': {} }),
    });
    const key = allowlist('Code-Pro', 'Code-Max');
    assert.deepEqual(filterVisibleModels(known, key), ['Code-Max', 'Code-Pro']);
    assert.equal(authorizeModel('Code-Pro', known, key).allowed, true);
    assert.equal(authorizeModel('Code-Max', known, key).allowed, true);
    assert.deepEqual(authorizeModel('Air', known, key), { allowed: false, status: 403 });
  });

  test('allowlisted-but-nonexistent model is still a 404', () => {
    const known = new Set(['Air']);
    const key = allowlist('ghost');
    assert.deepEqual(authorizeModel('ghost', known, key), { allowed: false, status: 404 });
    assert.deepEqual(filterVisibleModels(known, key), []);
  });

  test('empty catalog exposes and authorizes zero models', () => {
    const known = collectKnownModels([wildcard('w1')], {});
    assert.deepEqual(filterVisibleModels(known, allowAll), []);
    assert.deepEqual(authorizeModel('anything', known, allowAll), { allowed: false, status: 404 });
  });

  if (process.exitCode) suiteExit(1);
  console.log(`\nclosed-catalog tests passed (${passed}).`);
  console.log('ok - file:closed-catalog');
} catch (error) {
  console.error('not ok - closed-catalog-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}
