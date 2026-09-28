// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Merged suite. Each section below was a standalone suite and keeps its own scope:
//   - gateway-configuration-test.mjs
//   - config-matrix-test.mjs
//   - config-cli-test.mjs
//   - node-config-shards-test.mjs
//   - github-deployment-config-test.mjs

import { targetRoot as root } from '#kit/target.mjs';
import { buildDeploymentSummary, buildRuntimeFromEnv, buildWranglerConfig, collectSecretsFromEnv, collectVarsFromEnv, loadRuntimeConfig, normalizeNodeConfigJsonText, normalizeRuntimeConfig, preflight, validateGatewayRuntime, withStaleNodeSecretsRemoved } from '#target/scripts/github-deployment-config.mjs';
import { MANAGED_SECRET_PATTERN, MANAGED_VAR_PATTERN, MAX_SHARD_NUMBER, assertNodesArray, assertSecretsObject, buildPlan } from '#target/scripts/node-config-shards.mjs';
import { getModelsConfigDiagnostics } from '#target/src/config/models.ts';
import { SECRET_SHARD_PATTERN, TIER_SHARD_PATTERN, collectShards, loadGatewayConfig } from '#target/src/config/nodes.ts';
import { getPoliciesConfigDiagnostics, loadPoliciesConfig } from '#target/src/config/policies.ts';
import { isWildcardNode, loadModelRegistry, modelRegistryEntry, servesModel } from '#target/src/config/registry.ts';
import { renderModels } from '#target/src/dashboard/model-status-view.ts';
import { __resetAllStateForTests } from '#target/src/reliability/node-state.ts';
import { __resetTier1StateForTests, recordTier1Ttft } from '#target/src/reliability/tier1-state.ts';
import { computeTierCaps } from '#target/src/request/tier-loop.ts';
import { getPublicModelStatus } from '#target/src/runtime/model-status.ts';
import { supportsRequest } from '#target/src/scheduler/scheduler.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ==========================================================================
// gateway-configuration-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT






  let passed = 0;
  function test(name, fn) {
    try { fn(); passed++; console.log(`ok - ${name}`); }
    catch (e) { console.error(`FAIL: ${name}`); console.error(e?.stack || e); process.exitCode = 1; }
  }

  const node = (id, extra = {}) => ({
    id,
    provider: 'mock',
    base_url: `https://${id}.example.com/v1`,
    models: { 'general-air': 'up-model' },
    ...extra,
  });
  function makeEnv({ tier1, secrets, extraEnv } = {}) {
    return {
      AIG_ACCESS_KEY_AIR: 'k',
      AIG_ACCESS_MODELS_AIR: '*',
      ...(tier1 ? { AIG_TIER1_NODES_01: JSON.stringify(tier1) } : {}),
      ...(secrets ? { AIG_TIER1_CREDENTIALS_01: JSON.stringify(secrets) } : {}),
      ...extraEnv,
    };
  }
  const policyDiags = (policies) => getPoliciesConfigDiagnostics(makeEnv({ extraEnv: { AIG_POLICIES_CONFIG: JSON.stringify(policies) } }));
  const modelDiags = (models) => getModelsConfigDiagnostics(makeEnv({ extraEnv: { AIG_MODELS_CONFIG: JSON.stringify(models) } }));

  // Shards.
  test('collectShards accepts 01..10 and reports out-of-range/malformed names', () => {
    const diags = [];
    const secrets = collectShards(
      { AIG_TIER1_CREDENTIALS_01: '{}', AIG_TIER1_CREDENTIALS_09: '{}', AIG_TIER1_CREDENTIALS_12: '{}' },
      SECRET_SHARD_PATTERN, 'AIG_TIER1_CREDENTIALS_', 'AIG_TIER1_CREDENTIALS_01', 2, diags,
    );
    assert.deepEqual(secrets.map((s) => s.index), [1, 9]);
    assert.ok(diags.some((d) => /12.*out of range/.test(d)));
    const tiers = collectShards({ AIG_TIER2_NODES_03: '[]' }, TIER_SHARD_PATTERN, 'AIG_TIER2_NODES_', 'AIG_TIER2_NODES_01', 2, []);
    assert.equal(tiers[0].tierNumber, 2);
    assert.equal(tiers[0].index, 3);
  });

  // Current node schema: account data only; provider owns wire structure.
  test('account-level node config is ready and gets provider wire profile', () => {
    const cfg = loadGatewayConfig(makeEnv({ tier1: [node('good')], secrets: { good: 'x' } }));
    assert.equal(cfg.status, 'ready');
    assert.equal(cfg.nodes.length, 1);
    assert.equal(cfg.nodes[0].protocol, 'openai');
    assert.deepEqual(cfg.nodes[0].surfaces, ['chat_completions']);
  });

  test('provider, base_url and models are required account fields', () => {
    for (const field of ['provider', 'base_url', 'models']) {
      const n = node(`missing-${field}`);
      delete n[field];
      const cfg = loadGatewayConfig(makeEnv({ tier1: [n], secrets: { [n.id]: 'x' } }));
      assert.equal(cfg.nodes.length, 0, `${field} omission must fail`);
      assert.ok(cfg.diagnostics.some((d) => d.includes(field)), `missing ${field} diagnostic required`);
    }
  });

  test('provider wire profiles are single-sourced', () => {
    const anthropic = loadGatewayConfig(makeEnv({ tier1: [node('an', { provider: 'anthropic' })], secrets: { an: 'x' } }));
    assert.equal(anthropic.nodes[0].protocol, 'anthropic');
    assert.deepEqual(anthropic.nodes[0].surfaces, ['messages']);

    const openai = loadGatewayConfig(makeEnv({ tier1: [node('oa', { provider: 'openai' })], secrets: { oa: 'x' } }));
    assert.equal(openai.nodes[0].protocol, 'openai');
    assert.deepEqual(openai.nodes[0].surfaces, ['chat_completions', 'responses']);

    const compatible = loadGatewayConfig(makeEnv({ tier1: [node('groq', { provider: 'groq' })], secrets: { groq: 'x' } }));
    assert.equal(compatible.nodes[0].protocol, 'openai');
    assert.deepEqual(compatible.nodes[0].surfaces, ['chat_completions']);
  });

  test('protocol and surfaces are not node fields', () => {
    for (const extra of [
      { protocol: 'openai' },
      { surfaces: ['chat_completions'] },
    ]) {
      const cfg = loadGatewayConfig(makeEnv({ tier1: [node('wire-field', extra)], secrets: { 'wire-field': 'x' } }));
      assert.equal(cfg.nodes.length, 0);
      assert.ok(cfg.diagnostics.some((d) => d.includes('unknown field')));
    }
  });

  test('models accepts object only; explicit empty object is intentional wildcard', () => {
    const wildcard = loadGatewayConfig(makeEnv({ tier1: [node('w', { models: {} })], secrets: { w: 'x' } }));
    assert.equal(wildcard.status, 'ready');
    assert.deepEqual(wildcard.nodes[0].models, {});
    for (const bad of [['general-air'], 'deepseek', 5, true]) {
      const cfg = loadGatewayConfig(makeEnv({ tier1: [node('bad-models', { models: bad })], secrets: { 'bad-models': 'x' } }));
      assert.equal(cfg.nodes.length, 0, `models=${JSON.stringify(bad)} must be rejected`);
    }
  });

  test('unknown, credential and retired capacity fields are rejected', () => {
    for (const extra of [
      { prioirty: 5 },
      { limits: { concurrency: 2 } },
      { api_key: 'secret' },
    ]) {
      const cfg = loadGatewayConfig(makeEnv({ tier1: [node('bad-field', extra)], secrets: { 'bad-field': 'x' } }));
      assert.equal(cfg.nodes.length, 0);
    }
  });

  test('priority is numeric-only; absent priority uses current default 100', () => {
    const normal = loadGatewayConfig(makeEnv({ tier1: [node('prio')], secrets: { prio: 'x' } }));
    assert.equal(normal.nodes[0].priority, 100);
    for (const bad of [-1, '10', 1.5]) {
      const cfg = loadGatewayConfig(makeEnv({ tier1: [node('prio-bad', { priority: bad })], secrets: { 'prio-bad': 'x' } }));
      assert.equal(cfg.nodes.length, 0);
      assert.ok(cfg.diagnostics.some((d) => d.includes('priority')));
    }
  });

  // Registry / wildcard behavior.
  test('registry carries declared capabilities and conservative defaults', () => {
    const env = makeEnv({
      tier1: [node('r', { models: {} })], secrets: { r: 'x' },
      extraEnv: { AIG_MODELS_CONFIG: JSON.stringify({ 'code-pro': { policy: 'fast', capabilities: { vision: true }, reasoning_efforts: ['high'] } }) },
    });
    const reg = loadModelRegistry(env);
    assert.equal(reg['code-pro'].catalog.capabilities.vision, true);
    assert.deepEqual(reg['code-pro'].catalog.reasoning_efforts, ['high']);
    assert.equal(reg['code-pro'].policy.policy, 'fast');
    const def = modelRegistryEntry(env, 'unknown-model');
    assert.equal(def.catalog.capabilities.tools, false);
    assert.equal(def.catalog.capabilities.reasoning, false);
    assert.equal(def.catalog.capabilities.vision, false);
  });

  test('wildcard and explicit model mappings remain distinct', () => {
    assert.equal(isWildcardNode(node('w', { models: {} })), true);
    assert.equal(servesModel(node('w', { models: {} }), 'known', new Set(['known'])), true);
    assert.equal(servesModel(node('w', { models: {} }), 'unknown', new Set(['known'])), false,
      'wildcard must be bounded by known catalog');
    assert.equal(servesModel(node('m', { models: { only: 'x' } }), 'only', new Set(['only'])), true);
    assert.equal(servesModel(node('m', { models: { only: 'x' } }), 'other', new Set(['only', 'other'])), false);
  });

  test('AIG_MODELS_CONFIG rejects malformed or unknown capability fields', () => {
    const malformed = loadGatewayConfig(makeEnv({ tier1: [node('m1')], secrets: { m1: 'x' }, extraEnv: { AIG_MODELS_CONFIG: '{bad' } }));
    assert.equal(malformed.status, 'invalid');
    assert.equal(malformed.ready, false);
    const diags = modelDiags({ m: { capabilities: { visionz: true, reasoning: 'yes' } } });
    assert.ok(diags.some((d) => d.includes('visionz')));
    assert.ok(diags.some((d) => d.includes('reasoning')));
  });

  test('AIG_MODELS_CONFIG accepts current modalities/ocr/ui fields', () => {
    const env = makeEnv({ extraEnv: { AIG_MODELS_CONFIG: JSON.stringify({
      Omni: { modalities: { input: ['text', 'image', 'audio'], output: ['text', 'audio'] } },
      OCR: { capabilities: { ocr: true }, ui_visible: false },
    }) } });
    assert.deepEqual(getModelsConfigDiagnostics(env), []);
    const reg = loadModelRegistry(env);
    assert.deepEqual(reg.Omni.catalog.modalities, { input: ['text', 'image', 'audio'], output: ['text', 'audio'] });
    assert.equal(reg.OCR.catalog.capabilities.ocr, true);
    assert.equal(reg.OCR.policy.ui_visible, false);
  });

  test('AIG_MODELS_CONFIG rejects obvious capability contradictions without provider inference', () => {
    const reasoning = modelDiags({ m: { capabilities: { reasoning: false }, reasoning_efforts: ['high'] } });
    assert.ok(reasoning.some((d) => d.includes('reasoning_efforts conflicts with capabilities.reasoning=false')));

    const ocr = modelDiags({ m: { capabilities: { ocr: true, vision: false } } });
    assert.ok(ocr.some((d) => d.includes('capabilities.ocr=true conflicts with capabilities.vision=false')));

    const vision = modelDiags({
      m: {
        capabilities: { vision: true },
        modalities: { input: ['text'], output: ['text'] },
      },
    });
    assert.ok(vision.some((d) => d.includes('modalities.input to include "image"')));

    assert.deepEqual(modelDiags({
      m: {
        capabilities: { reasoning: true, vision: true, ocr: true },
        reasoning_efforts: ['high'],
        modalities: { input: ['text', 'image'], output: ['text'] },
      },
    }), []);
  });

  // Strict policy schema.
  test('max_attempts and tier_attempts accept only bounded integer numbers', () => {
    for (const bad of ['5', -1, 0, 9, 1.5, null]) {
      assert.ok(policyDiags({ p: { max_attempts: bad } }).some((d) => d.includes('max_attempts')));
    }
    for (const bad of ['2', -1, 9, 1.5]) {
      assert.ok(policyDiags({ p: { tier_attempts: { tier1: bad } } }).some((d) => d.includes('tier_attempts.tier1')));
    }
    assert.deepEqual(policyDiags({ p: { max_attempts: 5, tier_attempts: { tier1: 3, tier2: 1, tier3: 1 } } }), []);
  });

  test('budget_split and other retired policy fields are rejected as unknown', () => {
    for (const value of ['even', 'weighted', null]) {
      const diags = policyDiags({ p: { max_attempts: 5, budget_split: value } });
      assert.ok(diags.some((d) => d.includes('unknown field "budget_split"')),
        `budget_split=${JSON.stringify(value)} must not be accepted`);
    }
  });

  test('hedge and max_in_flight current fields validate without coercion', () => {
    const policies = loadPoliciesConfig(makeEnv({ extraEnv: { AIG_POLICIES_CONFIG: JSON.stringify({ p: {
      max_attempts: 5,
      hedge: { enabled: true, delay_ms: 4000, tiers: ['tier1'] },
      max_in_flight: 4,
    } }) } }));
    assert.equal(policies.p.hedge.enabled, true);
    assert.equal(policies.p.hedge.delayMs, 4000);
    assert.deepEqual(policies.p.hedge.tiers, ['tier1']);
    assert.equal(policies.p.maxInFlight, 4);
    assert.ok(policyDiags({ p: { max_in_flight: '4' } }).some((d) => d.includes('max_in_flight')));
  });

  test('invalid policy/model references are fatal end-to-end', () => {
    const badAttempts = loadGatewayConfig(makeEnv({
      tier1: [node('f1')], secrets: { f1: 'x' },
      extraEnv: { AIG_POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 0 } }) },
    }));
    assert.equal(badAttempts.ready, false);
    const missingPolicy = loadGatewayConfig(makeEnv({
      tier1: [node('f2')], secrets: { f2: 'x' },
      extraEnv: { AIG_MODELS_CONFIG: JSON.stringify({ 'general-air': { policy: 'missing' } }) },
    }));
    assert.equal(missingPolicy.ready, false);
    assert.ok(missingPolicy.diagnostics.some((d) => d.includes('missing')));
  });

  if (!process.exitCode) console.log(`gateway configuration tests passed (${passed}).`);
  else suiteExit(1);
  console.log('ok - file:gateway-configuration');
} catch (error) {
  console.error('not ok - gateway-configuration-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// config-matrix-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT










  let passed = 0;
  function test(name, fn) {
    try {
      __resetTier1StateForTests();
      __resetAllStateForTests();
      fn();
      passed++;
      console.log(`ok - ${name}`);
    } catch (e) {
      console.error(`FAIL: ${name}`);
      console.error(e?.stack || e);
      process.exitCode = 1;
    }
  }

  const access = { AIG_ACCESS_KEY_AIR: 'k', AIG_ACCESS_MODELS_AIR: '*' };
  const env = (models) => ({ ...access, ...(models ? { AIG_MODELS_CONFIG: JSON.stringify(models) } : {}) });
  const runtimeNode = (id, models) => ({
    id, provider: 'mock', tier: 'tier-1', protocol: 'openai', surfaces: ['chat_completions'],
    base_url: `https://${id}.example.com/v1`, models,
  });
  const configNode = (id) => ({
    id, provider: 'mock',
    base_url: `https://${id}.example.com/v1`, models: { 'Code-Max': 'up-model' },
  });
  const budgetNode = (id, tier) => ({
    id, tier, provider: 'mock', protocol: 'openai', surfaces: ['chat_completions'],
    baseUrl: `https://${id}.example.com/v1`, credential: 'k', priority: 10,
    models: { 'Code-Max': 'up-model' },
  });
  const now = () => 1_700_000_000_000;
  const req = { model: 'Code-Max', protocol: 'openai', surface: 'chat_completions' };
  const ids = (result) => result.models.map((m) => m.id);

  test('node-mapped models are public without AIG_MODELS_CONFIG', () => {
    const nodes = [runtimeNode('a', { 'public-air': 'up-air', 'public-max': 'up-max' })];
    recordTier1Ttft('a', 'public-air', 100, now() - 1000);
    const result = getPublicModelStatus(nodes, env(null), new Set(), now());
    assert.ok(ids(result).includes('public-air'));
    assert.ok(ids(result).includes('public-max'));
  });

  test('visibility internal hides a mapped model but does not make it unrequestable', () => {
    const nodes = [runtimeNode('a', { pub: 'up-pub', hidden: 'up-hidden' })];
    recordTier1Ttft('a', 'pub', 100, now() - 1000);
    recordTier1Ttft('a', 'hidden', 100, now() - 1000);
    const result = getPublicModelStatus(nodes, env({ pub: {}, hidden: { visibility: 'internal' } }), new Set(), now());
    assert.ok(ids(result).includes('pub'));
    assert.ok(!ids(result).includes('hidden'));
    const { html } = renderModels(result);
    assert.ok(html.includes('pub'));
    assert.ok(!html.includes('hidden'));
    assert.equal(nodes.some((n) => supportsRequest(n, { model: 'hidden', protocol: 'openai', surface: 'chat_completions' })), true);
  });

  test('AIG_MODELS_CONFIG alone never widens public/requestable models', () => {
    const result = getPublicModelStatus([], env({ orphan: { policy: 'fast' } }), new Set(), now());
    assert.ok(!ids(result).includes('orphan'));
    assert.equal([].some((n) => supportsRequest(n, { model: 'orphan', protocol: 'openai', surface: 'chat_completions' })), false);
  });

  test('same-tier credential may live in a different shard suffix', () => {
    const cfg = loadGatewayConfig({
      ...access,
      AIG_TIER1_NODES_01: JSON.stringify([configNode('same-tier')]),
      AIG_TIER1_CREDENTIALS_07: JSON.stringify({ 'same-tier': 'secret' }),
    });
    assert.equal(cfg.status, 'ready');
    assert.equal(cfg.nodes[0].credential, 'secret');
  });

  test('cross-tier credential binding is rejected', () => {
    const cfg = loadGatewayConfig({
      ...access,
      AIG_TIER2_NODES_01: JSON.stringify([configNode('tier2-cross')]),
      AIG_TIER1_CREDENTIALS_01: JSON.stringify({ 'tier2-cross': 'secret' }),
    });
    assert.equal(cfg.ready, false);
    assert.ok(cfg.diagnostics.some((d) => d.includes('tier2-cross') && d.includes('TIER2') && d.includes('TIER1')));
  });

  test('explicit tier_attempts remains a hard cap', () => {
    const tiers = { 1: [], 2: [budgetNode('t2', 'tier-2')], 3: [] };
    const policy = { maxAttempts: 6, tierAttempts: { tier2: 3 }, hedge: null, firstEventTimeoutMs: null, maxInFlight: null };
    const caps = computeTierCaps(tiers, req, new Set(), policy, new Set());
    assert.equal(caps[2], 3);
  });

  test('unset lower tier receives remaining budget after explicit higher-tier cap', () => {
    const tiers = { 1: [], 2: [budgetNode('t2', 'tier-2')], 3: [budgetNode('t3', 'tier-3')] };
    const policy = { maxAttempts: 6, tierAttempts: { tier2: 3 }, hedge: null, firstEventTimeoutMs: null, maxInFlight: null };
    const caps = computeTierCaps(tiers, req, new Set(), policy, new Set());
    assert.equal(caps[2], 3);
    assert.equal(caps[3], 3);
  });

  test('surplus goes to the first adjustable dispatchable tier', () => {
    const tiers = {
      1: [budgetNode('t1a', 'tier-1'), budgetNode('t1b', 'tier-1')],
      2: [budgetNode('t2', 'tier-2')], 3: [budgetNode('t3', 'tier-3')],
    };
    const policy = { maxAttempts: 5, tierAttempts: null, hedge: null, firstEventTimeoutMs: null, maxInFlight: null };
    assert.deepEqual(computeTierCaps(tiers, req, new Set(), policy, new Set()), { 1: 3, 2: 1, 3: 1 });
  });

  test('explicit zero disables a tier', () => {
    const tiers = { 1: [budgetNode('t1', 'tier-1')], 2: [budgetNode('t2', 'tier-2')], 3: [budgetNode('t3', 'tier-3')] };
    const policy = { maxAttempts: 4, tierAttempts: { tier2: 0 }, hedge: null, firstEventTimeoutMs: null, maxInFlight: null };
    const caps = computeTierCaps(tiers, req, new Set(), policy, new Set());
    assert.equal(caps[2], 0);
    assert.equal(caps[1], 3);
    assert.equal(caps[3], 1);
  });

  test('tier_attempts total above max_attempts is rejected', () => {
    const diags = getPoliciesConfigDiagnostics({ AIG_POLICIES_CONFIG: JSON.stringify({ over: { max_attempts: 6, tier_attempts: { tier2: 4, tier3: 4 } } }) });
    assert.ok(diags.some((d) => d.includes('tier_attempts total exceeds max_attempts')));
  });

  test('budget_split is not a current policy field', () => {
    const diags = getPoliciesConfigDiagnostics({ AIG_POLICIES_CONFIG: JSON.stringify({ bad: { max_attempts: 5, budget_split: 'weighted' } }) });
    assert.ok(diags.some((d) => d.includes('unknown field "budget_split"')));
  });

  console.log(`\nconfig-matrix tests: ${passed} passed.`);
  if (process.exitCode) suiteExit(1);
  console.log('ok - file:config-matrix');
} catch (error) {
  console.error('not ok - config-matrix-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// config-cli-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT






  const here = path.dirname(fileURLToPath(import.meta.url));

  const cli = path.join(root, 'scripts', 'config-cli.mjs');
  const cfg = (p) => path.join(root, 'config', p);
  function writeJSON(file, obj) { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); return file; }
  function tmp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), `cfg-cli-${name}-`)); }
  function run(args) { const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' }); return { status: result.status, stdout: result.stdout, stderr: result.stderr }; }
  function check(cond, msg) { if (!cond) throw new Error(`assertion failed: ${msg}`); }
  function explicitNode(id, base = `https://${id}.example.com/v1`, model = 'u') {
    return { id, provider: 'mock', base_url: base, models: { m: model } };
  }
  function tier1ExampleSecrets() {
    const nodes = JSON.parse(fs.readFileSync(cfg('tier1-nodes.example.json'), 'utf8'));
    const dir = tmp('example-secrets');
    return writeJSON(path.join(dir, 'secrets.json'), Object.fromEntries(nodes.map((n) => [n.id, `secret-${n.id}`])));
  }

  {
    const secrets = tier1ExampleSecrets();
    const r = run(['check', '--tier1', cfg('tier1-nodes.example.json'), '--secrets', secrets]);
    check(r.status === 0, `valid config should pass, got status=${r.status} stderr=${r.stderr}`);
    check(r.stdout.includes('Configuration valid'), 'prints valid header');
    check(r.stdout.includes('Tier 1: 3'), 'reports tier-1 node count');
    check(r.stdout.includes('All configured nodes have credentials'), 'reports credentials ok');
  }
  {
    const dir = tmp('dup');
    const tier1 = writeJSON(path.join(dir, 'tier1.json'), [explicitNode('dup', 'https://a.example.com/v1'), explicitNode('dup', 'https://b.example.com/v1')]);
    const secrets = writeJSON(path.join(dir, 'secrets.json'), { dup: 'k' });
    const r = run(['check', '--tier1', tier1, '--secrets', secrets]);
    check(r.status !== 0, 'duplicate node id must fail');
    check(/duplicate node id "dup"/.test(r.stderr + r.stdout), 'names the duplicate id');
  }
  {
    const dir = tmp('strict');
    const broken = explicitNode('broken'); delete broken.provider;
    const tier1 = writeJSON(path.join(dir, 'tier1.json'), [broken]);
    const secrets = writeJSON(path.join(dir, 'secrets.json'), { broken: 'k' });
    const r = run(['check', '--tier1', tier1, '--secrets', secrets]);
    check(r.status !== 0, 'missing provider must fail');
    check(/provider/i.test(r.stderr + r.stdout), 'strict-schema error names provider');
  }
  {
    const dir = tmp('orphan');
    const tier1 = writeJSON(path.join(dir, 'tier1.json'), [explicitNode('lonely')]);
    const secrets = writeJSON(path.join(dir, 'secrets.json'), { other: 'k' });
    const r = run(['check', '--tier1', tier1, '--secrets', secrets]);
    check(r.status !== 0, 'node without secret must fail');
    check(/no credential/.test(r.stderr + r.stdout), 'names missing credential');
  }
  {
    const dir = tmp('orphan-secret');
    const tier1 = writeJSON(path.join(dir, 'tier1.json'), [explicitNode('a')]);
    const secrets = writeJSON(path.join(dir, 'secrets.json'), { a: 'k-a', orphan: 'very-secret-orphan' });
    const r = run(['check', '--tier1', tier1, '--secrets', secrets]);
    check(r.status === 0, 'orphan credential only warns');
    check(/orphan/i.test(r.stderr + r.stdout), 'warns on orphan credential');
    check(!r.stdout.includes('very-secret-orphan') && !r.stderr.includes('very-secret-orphan'), 'never prints credential value');
  }
  {
    const dir = tmp('bad');
    const tier1 = path.join(dir, 'tier1.json'); fs.writeFileSync(tier1, '{not json');
    const secrets = writeJSON(path.join(dir, 'secrets.json'), {});
    const r = run(['check', '--tier1', tier1, '--secrets', secrets]);
    check(r.status !== 0, 'malformed JSON must fail');
    check(/invalid JSON/.test(r.stderr + r.stdout), 'reports invalid JSON');
  }
  {
    const secrets = tier1ExampleSecrets();
    const r = run(['show', '--tier1', cfg('tier1-nodes.example.json'), '--secrets', secrets]);
    check(r.status === 0, 'show exits 0');
    check(r.stdout.includes('nvidia-01'), 'lists nvidia-01');
    check(/Tier: 1/.test(r.stdout), 'reports tier 1');
    check(/Credential: configured/.test(r.stdout), 'reports credential configured');
    check(!/secret-nvidia/.test(r.stdout), 'never prints credential values');
  }
  {
    const dir = tmp('diff');
    const oldTier = writeJSON(path.join(dir, 'old.json'), [explicitNode('a', 'https://a.example.com/v1', 'u1'), explicitNode('b')]);
    const newTier = writeJSON(path.join(dir, 'new.json'), [explicitNode('a', 'https://a.example.com/v1', 'u2'), explicitNode('c')]);
    const oldSec = writeJSON(path.join(dir, 'old-secrets.json'), { a: 'k1', b: 'k2' });
    const newSec = writeJSON(path.join(dir, 'new-secrets.json'), { a: 'k1', c: 'k3' });
    const r = run(['diff', '--old-tier1', oldTier, '--new-tier1', newTier, '--old-secrets', oldSec, '--new-secrets', newSec]);
    check(r.status === 0, 'diff exits 0');
    check(r.stdout.includes('+ c'), 'added node detected'); check(r.stdout.includes('- b'), 'removed node detected'); check(r.stdout.includes('~ a'), 'changed node detected');
    check(/Secrets:/.test(r.stdout), 'secrets section present'); check(!/k1|k2|k3/.test(r.stdout), 'never prints secret values');
  }
  console.log('config-cli tests passed.');
  console.log('ok - file:config-cli');
} catch (error) {
  console.error('not ok - config-cli-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// node-config-shards-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT



  const node = (id, extra = {}) => ({
    id,
    provider: 'mock',
    base_url: 'https://api.example.com/v1',
    priority: 10,
    models: { 'general-air': 'model-a' },
    ...extra,
  });

  let passed = 0;
  function test(name, fn) {
    try { fn(); passed += 1; console.log(`ok - ${name}`); }
    catch (error) { console.error(`FAIL: ${name}`); console.error(error?.stack || error); process.exitCode = 1; }
  }

  test('valid plan shards current nodes and tier-scoped secrets', () => {
    const plan = buildPlan({ tiers: { 1: [node('a'), node('b')], 2: [node('c')] }, secretsMap: { a: 'cred-a', b: 'cred-b', c: 'cred-c' } });
    assert.ok(plan.vars.AIG_TIER1_NODES_01.startsWith('[{'));
    assert.ok(plan.vars.AIG_TIER2_NODES_01.startsWith('[{'));
    assert.ok(plan.secrets.AIG_TIER1_CREDENTIALS_01);
    assert.ok(plan.secrets.AIG_TIER2_CREDENTIALS_01);
    for (const value of Object.values(plan.vars)) JSON.parse(value);
    for (const value of Object.values(plan.secrets)) JSON.parse(value);
  });

  test('credential fields and tier field are rejected', () => {
    assert.throws(() => buildPlan({ tiers: { 1: [node('a', { token: 'x' })] } }), /forbidden credential field/);
    assert.throws(() => buildPlan({ tiers: { 1: [node('a', { tier: 'tier-1' })] } }), /must not declare "tier"/);
  });

  test('node ids must be unique inside and across tiers', () => {
    assert.throws(() => buildPlan({ tiers: { 1: [node('a'), node('a')] } }), /duplicate node id/);
    assert.throws(() => buildPlan({ tiers: { 1: [node('a')], 2: [node('a')] } }), /duplicate node id.*across/i);
  });

  test('provider base_url and models are explicit required fields', () => {
    for (const field of ['provider', 'base_url', 'models']) {
      const n = node('a');
      delete n[field];
      assert.throws(() => assertNodesArray([n]), new RegExp(field));
    }
  });

  test('protocol and surfaces are provider-owned, not node fields', () => {
    assert.throws(() => assertNodesArray([node('a', { protocol: 'openai' })]), /unknown field "protocol"/);
    assert.throws(() => assertNodesArray([node('a', { surfaces: ['chat_completions'] })]), /unknown field "surfaces"/);
  });

  test('base_url must be valid https without credentials', () => {
    assert.throws(() => assertNodesArray([node('a', { base_url: 'http://api.example.com' })]), /https:\/\//);
    assert.throws(() => assertNodesArray([node('a', { base_url: 'https://u:p@example.com' })]), /username\/password/);
    assert.throws(() => assertNodesArray([node('a', { base_url: 'not-a-url' })]), /invalid base_url/);
  });

  test('priority accepts only non-negative integer numbers', () => {
    assert.throws(() => assertNodesArray([node('a', { priority: '10' })]), /priority/);
    assert.throws(() => assertNodesArray([node('a', { priority: 1.5 })]), /priority/);
    assert.throws(() => assertNodesArray([node('a', { priority: -1 })]), /priority/);
    assert.doesNotThrow(() => assertNodesArray([node('a', { priority: 0 })]));
  });

  test('models accepts object only; explicit empty object is wildcard', () => {
    assert.doesNotThrow(() => assertNodesArray([node('a', { models: {} })]));
    assert.throws(() => assertNodesArray([node('a', { models: undefined })]), /models is required/);
    assert.throws(() => assertNodesArray([node('a', { models: ['m'] })]), /models is required/);
    assert.throws(() => assertNodesArray([node('a', { models: { m: 1 } })]), /models\["m"\]/);
  });

  test('retired limits and unknown fields are rejected', () => {
    assert.throws(() => assertNodesArray([node('a', { limits: { concurrency: 2 } })]), /unknown field "limits"/);
    assert.throws(() => assertNodesArray([node('a', { prioirty: 5 })]), /unknown field "prioirty"/);
  });

  test('node without credential and orphan credential both fail planning', () => {
    assert.throws(() => buildPlan({ tiers: { 1: [node('a')] }, secretsMap: {} }), /no credential/);
    assert.throws(() => buildPlan({ tiers: { 1: [node('a')] }, secretsMap: { a: 'x', ghost: 'y' } }), /no matching node/);
  });

  test('secret object is strict', () => {
    assert.throws(() => assertSecretsObject([]), /JSON object/);
    assert.throws(() => assertSecretsObject({ a: '' }), /non-empty string/);
    assert.throws(() => assertSecretsObject({ 'BAD ID': 'x' }), /valid node id/);
  });

  test('oversized entry fails before producing invalid shards', () => {
    assert.throws(() => buildPlan({ tiers: { 1: [node('big', { provider: 'x'.repeat(5000) })] }, secretsMap: { big: 'x' } }), /exceeds the .*-byte shard limit/);
  });

  test('stale managed shard lists are computed', () => {
    const plan = buildPlan({
      tiers: { 1: [node('a')] }, secretsMap: { a: 'x' },
      existingVarNames: ['AIG_TIER1_NODES_01', 'AIG_TIER1_NODES_02', 'AIG_TIER3_NODES_01'],
      existingSecretNames: ['AIG_TIER1_CREDENTIALS_01', 'AIG_TIER1_CREDENTIALS_02', 'UNMANAGED_GATEWAY_KEY'],
    });
    assert.deepEqual(plan.deleteVars, ['AIG_TIER1_NODES_02', 'AIG_TIER3_NODES_01']);
    assert.deepEqual(plan.deleteSecrets, ['AIG_TIER1_CREDENTIALS_02']);
  });

  test('managed patterns cover current shards only', () => {
    assert.ok(MANAGED_VAR_PATTERN.test('AIG_TIER2_NODES_07'));
    assert.ok(MANAGED_SECRET_PATTERN.test('AIG_TIER1_CREDENTIALS_03'));
    assert.ok(!MANAGED_SECRET_PATTERN.test('UNMANAGED_GATEWAY_KEY'));
    assert.ok(!MANAGED_SECRET_PATTERN.test('AIG_TIER1_CREDENTIALS_11'));
  });

  test('planner never emits shard index above 10', () => {
    assert.equal(MAX_SHARD_NUMBER, 10);
    const nodes = Array.from({ length: 240 }, (_, i) => node(`n${i}`));
    const secretsMap = Object.fromEntries(nodes.map((n) => [n.id, 'x']));
    const plan = buildPlan({ tiers: { 1: nodes }, secretsMap });
    for (const key of [...Object.keys(plan.vars), ...Object.keys(plan.secrets)]) {
      const match = /(\d{2})$/.exec(key);
      assert.ok(match);
      assert.ok(Number(match[1]) >= 1 && Number(match[1]) <= 10, key);
    }
  });

  if (process.exitCode) suiteExit(1);
  console.log(`node-config-shards tests passed (${passed}).`);
  console.log('ok - file:node-config-shards');
} catch (error) {
  console.error('not ok - node-config-shards-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// github-deployment-config-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT




  const currentNode = (id = 'node-a') => ({
    id,
    provider: 'mock',
    base_url: 'https://provider.example.com/v1',
    models: { 'code-pro': 'upstream-code-pro' },
  });

  function fixture() {
    return {
      vars: {
        AIG_TIER1_NODES_01: [currentNode()],
        AIG_ACCESS_MODELS_AIR: 'code-pro',
        AIG_MODELS_CONFIG: { 'code-pro': { policy: 'default' } },
        AIG_POLICIES_CONFIG: { default: { max_attempts: 5 } },
      },
      secrets: {
        AIG_ACCESS_KEY_AIR: 'gateway-key',
        AIG_TIER1_CREDENTIALS_01: { 'node-a': 'upstream-key' },
      },
    };
  }

  const loaded = loadRuntimeConfig(JSON.stringify(fixture().vars), JSON.stringify(fixture().secrets));
  const cfg = validateGatewayRuntime(loaded);
  assert.equal(cfg.ready, true);
  assert.equal(cfg.nodesUsable, 1);
  assert.equal(JSON.parse(loaded.vars.AIG_TIER1_NODES_01)[0].provider, 'mock');
  assert.equal(JSON.parse(loaded.secrets.AIG_TIER1_CREDENTIALS_01)['node-a'], 'upstream-key');

  assert.throws(
    () => normalizeRuntimeConfig({ vars: { ...fixture().vars, AIG_ACCESS_KEY_AIR: 'nope' }, secrets: fixture().secrets }),
    /credentials belong in secrets/,
  );
  assert.throws(
    () => normalizeRuntimeConfig({ vars: fixture().vars, secrets: { AIG_ACCESS_KEY_AIR: 'x' } }),
    /TIER\[123\]_CREDENTIALS|TIER[123]_CREDENTIALS/,
  );
  assert.throws(
    () => validateGatewayRuntime(normalizeRuntimeConfig({
      vars: {
        ...fixture().vars,
        AIG_MODELS_CONFIG: { 'code-pro': { policy: 'missing' } },
        AIG_POLICIES_CONFIG: {},
      },
      secrets: fixture().secrets,
    })),
    /references unknown policy/,
  );

  const wrangler = buildWranglerConfig(loaded.vars, 'd1-id', 'kv-id');
  assert.equal(wrangler.keep_vars, false);
  assert.equal(wrangler.vars.AIG_TIER1_NODES_01, loaded.vars.AIG_TIER1_NODES_01);
  assert.equal(wrangler.d1_databases[0].database_id, 'd1-id');
  assert.deepEqual(wrangler.kv_namespaces, [{ binding: 'TIER1_AFFINITY', id: 'kv-id' }]);
  assert.ok(path.isAbsolute(wrangler.main));
  assert.ok(path.isAbsolute(wrangler.d1_databases[0].migrations_dir));

  assert.deepEqual(
    withStaleNodeSecretsRemoved(loaded.secrets, [
      { name: 'AIG_TIER1_CREDENTIALS_01' },
      { name: 'AIG_TIER1_CREDENTIALS_02' },
      { name: 'UNRELATED_SECRET' },
    ]),
    { ...loaded.secrets, AIG_TIER1_CREDENTIALS_02: null },
  );

  function envFixture() {
    return {
      CLOUDFLARE_ACCOUNT_ID: 'acct',
      CLOUDFLARE_API_TOKEN: 'cf-token',
      AIG_USAGE_D1_ID: 'd1-id',
      AIG_AFFINITY_KV_ID: 'kv-id',
      AIG_PUBLIC_URL: 'https://gw.example.com',
      AIG_BUILD_SHA: 'a'.repeat(40),
      AIG_RATE_LIMIT_COOLDOWN_MS: '15000',
      AIG_FIRST_EVENT_TIMEOUT_MS: '15000',
      AIG_MODELS_CONFIG: JSON.stringify({ 'code-pro': { policy: 'default' } }),
      AIG_POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 5 } }),
      AIG_TIER1_NODES_01: JSON.stringify([currentNode()]),
      AIG_ACCESS_KEY_AIR: 'gw-key',
      AIG_ACCESS_MODELS_AIR: 'code-pro',
      AIG_TIER1_CREDENTIALS_01: JSON.stringify({ 'node-a': 'upstream-key' }),
    };
  }

  {
    const repaired = normalizeNodeConfigJsonText('[{"id":"a","models":{"label":"A、B"}}、{"id":"b"}]');
    assert.equal(repaired, '[{"id":"a","models":{"label":"A、B"}},{"id":"b"}]');
    assert.equal(normalizeNodeConfigJsonText('[{"id":"a"、}]'), '[{"id":"a"}]');
  }

  {
    const env = envFixture();
    env.AIG_TIER1_NODES_01 = JSON.stringify([currentNode()]).replace(/}]$/, '}、]');
    const built = buildRuntimeFromEnv(env);
    assert.equal(validateGatewayRuntime(built.runtime).ready, true);
    assert.ok(preflight(env).warnings.some((w) => w.includes('full-width JSON punctuation')));
  }

  {
    const built = buildRuntimeFromEnv(envFixture());
    assert.equal(validateGatewayRuntime(built.runtime).ready, true);
    assert.equal(built.runtime.vars.AIG_RATE_LIMIT_COOLDOWN_MS, '15000');
    assert.equal(JSON.parse(built.runtime.secrets.AIG_TIER1_CREDENTIALS_01)['node-a'], 'upstream-key');
  }

  {
    const env = envFixture();
    const vars = collectVarsFromEnv(env).vars;
    const secrets = collectSecretsFromEnv(env).secrets;
    assert.ok('AIG_BUILD_SHA' in vars);
    assert.ok(!('GITHUB_SHA' in vars));
    assert.ok('AIG_TIER1_NODES_01' in vars);
    assert.ok(!('AIG_TIER1_NODES_01' in secrets));
    assert.ok('AIG_TIER1_CREDENTIALS_01' in secrets);
    assert.ok(!('AIG_TIER1_CREDENTIALS_01' in vars));
    assert.ok('AIG_ACCESS_MODELS_AIR' in vars);
    assert.ok('AIG_ACCESS_KEY_AIR' in secrets);
    assert.ok(!('AIG_ACCESS_KEY_AIR' in vars));
  }

  {
    const env = envFixture();
    env.AIG_TIER1_NODES_02 = '';
    env.AIG_TIER1_CREDENTIALS_02 = '';
    assert.ok(!('AIG_TIER1_NODES_02' in collectVarsFromEnv(env).vars));
    assert.ok(!('AIG_TIER1_CREDENTIALS_02' in collectSecretsFromEnv(env).secrets));
  }

  {
    const result = preflight(envFixture());
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  }

  {
    const env = envFixture();
    delete env.CLOUDFLARE_ACCOUNT_ID;
    delete env.AIG_PUBLIC_URL;
    delete env.AIG_TIER1_NODES_01;
    delete env.AIG_TIER1_CREDENTIALS_01;
    delete env.AIG_ACCESS_KEY_AIR;
    delete env.CLOUDFLARE_API_TOKEN;
    const result = preflight(env);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('CLOUDFLARE_ACCOUNT_ID')));
    assert.ok(result.errors.some((e) => e.includes('AIG_ACCESS_KEY_<GROUP>')));
    assert.ok(result.errors.some((e) => e.includes('No AIG_TIER')));
  }

  {
    const env = envFixture();
    delete env.AIG_MODELS_CONFIG;
    delete env.AIG_POLICIES_CONFIG;
    const result = preflight(env);
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((w) => w.includes('AIG_MODELS_CONFIG')));
    assert.ok(result.warnings.some((w) => w.includes('AIG_POLICIES_CONFIG')));
  }

  {
    const built = buildRuntimeFromEnv({
      ...envFixture(),
      AIG_TIER1_CREDENTIALS_01: JSON.stringify({ 'other-node': 'key' }),
    });
    assert.throws(() => validateGatewayRuntime(built.runtime), /no credential|no matching node|invalid/i);
  }

  {
    const summary = buildDeploymentSummary({
      config: cfg,
      runtime: loaded,
      d1Configured: 'd1-id',
      affinityKvConfigured: 'kv-id',
      removedSecretShards: 1,
    });
    for (const fragment of ['Deployment completed', 'Nodes: 1/1 usable', 'Models: 1', 'Status: ready', 'OK']) assert.ok(summary.includes(fragment), fragment);
    for (const secret of ['upstream-key', 'gateway-key', 'Bearer', 'authorization']) assert.ok(!summary.includes(secret), `summary leaks ${secret}`);
  }

  {
    const env = envFixture();
    env.AIG_TIER1_NODES_10 = env.AIG_TIER1_NODES_01;
    env.AIG_TIER1_NODES_11 = env.AIG_TIER1_NODES_01;
    env.AIG_TIER1_CREDENTIALS_10 = env.AIG_TIER1_CREDENTIALS_01;
    env.AIG_TIER1_CREDENTIALS_11 = env.AIG_TIER1_CREDENTIALS_01;
    assert.ok('AIG_TIER1_NODES_10' in collectVarsFromEnv(env).vars);
    assert.ok(!('AIG_TIER1_NODES_11' in collectVarsFromEnv(env).vars));
    assert.ok('AIG_TIER1_CREDENTIALS_10' in collectSecretsFromEnv(env).secrets);
    assert.ok(!('AIG_TIER1_CREDENTIALS_11' in collectSecretsFromEnv(env).secrets));
  }

  console.log('github deployment config tests passed.');
  console.log('ok - file:github-deployment-config');
} catch (error) {
  console.error('not ok - github-deployment-config-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}
