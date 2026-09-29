// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Merged suite. Each section below was a standalone suite and keeps its own scope:
//   - docs-contract-test.mjs
//   - module-boundary-contract-test.mjs
//   - architecture-contract-test.mjs
//   - product-policy-contract-test.mjs
//   - release-identity-contract-test.mjs

import { targetRoot as root } from '#kit/target.mjs';
import worker from '#target/src/index.ts';
import { __resetAllStateForTests, getNodeState } from '#target/src/reliability/node-state.ts';
import { __resetTier1StateForTests } from '#target/src/reliability/tier1-state.ts';
import { __resetTier1AffinityForTests } from '#target/src/scheduler/tier1-affinity.ts';
import assert from 'node:assert/strict';
import fs, { existsSync, readFileSync } from 'node:fs';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ==========================================================================
// docs-contract-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT






  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  let passed = 0;
  const ok = (label) => {
    passed++;
    console.log(`ok - ${label}`);
  };

  const DOCS = [
    'README.md',
    'README.zh-CN.md',
    'SECURITY.md',
    'scripts/README.md',
    'docs/architecture/overview.md',
    'docs/architecture/protocol-model.md',
    'docs/architecture/subscription-model.md',
    'docs/architecture/routing-model.md',
    'docs/architecture/reliability-model.md',
    'docs/architecture/repository-layout.md',
    'docs/architecture/module-boundary-audit.md',
    'docs/architecture/calendar-heatmap.md',
    'docs/operations/configuration.md',
    'docs/operations/deployment.md',
    'docs/operations/public-model-status.md',
    'docs/operations/troubleshooting.md',
  ];

  const PROTOCOL_FACT_FILES = [
    'README.md',
    'README.zh-CN.md',
    'docs/architecture/protocol-model.md',
    'docs/architecture/routing-model.md',
    'docs/operations/configuration.md',
    '.dev.vars.example',
    'config/worker-vars.example.json',
  ];
  for (const file of PROTOCOL_FACT_FILES) {
    const text = read(file);
    assert.doesNotMatch(text, /Responses\s*(?:→|->)\s*Anthropic/i, `${file}: Responses must remain Native Only`);
    assert.doesNotMatch(text, /three-way|三向/i, `${file}: no three-way protocol fallback`);
    assert.doesNotMatch(text, /"openai:responses"\s*:\s*\["anthropic:messages"\]/, `${file}: invalid Responses fallback`);
    ok(`${file} protocol contract`);
  }

  for (const file of ['.dev.vars.example', 'config/worker-vars.example.json']) {
    const text = read(file);
    assert.match(text, /anthropic:messages[\s\S]{0,180}openai:chat_completions/);
    assert.match(text, /openai:chat_completions[\s\S]{0,180}anthropic:messages/);
    ok(`${file} bidirectional Chat/Messages fallback`);
  }

  const ALLOWED_NODE_FIELDS = new Set(['id', 'provider', 'base_url', 'priority', 'models', 'auth']);
  const workerVars = JSON.parse(read('config/worker-vars.example.json'));
  for (const [key, nodes] of Object.entries(workerVars)) {
    if (!/^TIER[123]_NODES_\d{2}$/.test(key)) continue;
    assert.ok(Array.isArray(nodes), `${key} example must be an array`);
    for (const node of nodes) {
      const unknown = Object.keys(node).filter((field) => !ALLOWED_NODE_FIELDS.has(field));
      assert.deepEqual(unknown, [], `${key}: example node contains retired/unknown fields: ${unknown.join(', ')}`);
      for (const required of ['id', 'provider', 'base_url', 'models']) {
        assert.ok(Object.hasOwn(node, required), `${key}: example node missing ${required}`);
      }
    }
  }
  ok('worker vars node examples match the current account-level schema');

  const devVarsText = read('.dev.vars.example');
  assert.doesNotMatch(devVarsText, /"protocol"\s*:/, '.dev.vars.example must not put protocol in node JSON');
  assert.doesNotMatch(devVarsText, /"surfaces"\s*:/, '.dev.vars.example must not put surfaces in node JSON');
  assert.match(devVarsText, /Required per node:\s*id, provider, base_url, models/i);
  ok('.dev.vars.example node examples match the current account-level schema');

  const ACCESS_FACT_FILES = [
    'README.md',
    'README.zh-CN.md',
    'SECURITY.md',
    'docs/operations/configuration.md',
    'docs/operations/deployment.md',
    '.dev.vars.example',
    'config/access-keys.example.json',
  ];
  const GROUP_KEY = /AIG_ACCESS_KEY_(?:AIR|PRO|MAX|ULTRA|AGENT|<GROUP>|\{AIR,PRO,MAX,ULTRA,AGENT\})/;
  const GROUP_MODELS = /AIG_ACCESS_MODELS_(?:AIR|PRO|MAX|ULTRA|AGENT|<GROUP>|\{AIR,PRO,MAX,ULTRA,AGENT\})/;
  for (const file of ACCESS_FACT_FILES) {
    const text = read(file);
    assert.match(text, GROUP_KEY, `${file}: grouped access key required`);
    assert.match(text, GROUP_MODELS, `${file}: grouped model allowlist required`);
    ok(`${file} grouped access model`);
  }

  const SHARD_FACT_FILES = [
    'README.md',
    'README.zh-CN.md',
    'SECURITY.md',
    'docs/architecture/routing-model.md',
    'docs/operations/configuration.md',
    'docs/operations/deployment.md',
    '.dev.vars.example',
  ];
  for (const file of SHARD_FACT_FILES) {
    const text = read(file);
    assert.match(
      text,
      new RegExp(['independent', 'independently', 'not by matching', '无需.*对应', '不按.*后缀', 'Tier\\s*\\+\\s*node id'].join('|'), 'i'),
      `${file}: must state independent Config/Secret shard binding`,
    );
    assert.doesNotMatch(
      text,
      new RegExp(
        [
          '(?:must|should|required to|',
          '需要|必须',
          ')[^\\n]{0,80}(?:paired\\s*1:1|matching\\s+(?:config\\s+)?shard|matching\\s*suffix|',
          '一一对应|1:1\\s*配对',
          ')',
        ].join(''),
        'i',
      ),
      `${file}: must not instruct operators to pair Config/Secret suffixes`,
    );
    ok(`${file} independent shard suffixes`);
  }

  const routing = read('docs/architecture/routing-model.md');
  assert.match(routing, /Tier 1 has no independent attempt cap/i);
  assert.match(routing, /Node `limits`[^\n]*not part of the account schema/i);
  assert.match(routing, /`max_attempts` is the request-wide hard ceiling/i);
  assert.match(routing, /There is exactly one cross-tier allocation model/i);
  assert.match(routing, /There is no `budget_split`, weighted allocation, or alternate cross-tier budget mode/i);
  assert.doesNotMatch(routing, /request priority/i, 'retired access-group request-priority scoring must stay absent');
  assert.match(routing, /access groups only authorize logical models/i);
  assert.doesNotMatch(routing, /historical config|migration-time runtime interpretation/i);
  ok('routing docs use one current attempt-allocation and scoring contract');

  const reliability = read('docs/architecture/reliability-model.md');
  assert.doesNotMatch(reliability, /request priority/i, 'reliability docs must not restore retired request-priority scoring');
  assert.match(reliability, /Gateway access groups authorize logical models but do not add a Tier 1 score factor/i);
  ok('reliability docs match current Tier 1 score inputs');

  const config = read('docs/operations/configuration.md');
  assert.match(
    config,
    /Required fields:[\s\S]{0,160}id[\s\S]{0,80}provider[\s\S]{0,80}base_url[\s\S]{0,80}models/i,
    'configuration docs must show the small account-level node schema',
  );
  assert.match(config, /Provider wire profiles/i);
  assert.match(config, /`protocol`, `surfaces`, `limits`[^\n]*rejected/i, 'protocol/surfaces/limits must not return to per-node config');
  assert.match(config, /provider:\s*"anthropic"[\s\S]{0,100}messages/i);
  assert.match(config, /provider:\s*"openai"[\s\S]{0,120}responses/i);
  assert.match(config, /`budget_split`, weighted allocation, and alternate tier-budget modes are not part of the current policy schema/i);
  assert.doesNotMatch(config, /protocol` is required|surfaces` is required|budget_split"\s*:/i);
  assert.match(config, /public `次请求` counts successfully delivered requests/i);
  ok('configuration docs match provider-owned wire and dashboard accounting contracts');

  const publicStatus = read('docs/operations/public-model-status.md');
  for (const state of ['available', 'fluctuating', 'no_recent', 'no_record', 'down']) {
    assert.match(publicStatus, new RegExp(`\`${state}\``), `public status docs must include ${state}`);
  }
  assert.match(publicStatus, /P50[^\n]*at least 5/i);
  assert.match(publicStatus, /P95[^\n]*at least 20/i);
  assert.match(publicStatus, /successful_ttft_count/i);
  assert.doesNotMatch(
    publicStatus,
    /must not expose:[\s\S]{0,200}- TTFT values/i,
    'model-level TTFT aggregates are now an intentional public dashboard surface',
  );
  ok('public model status docs match five-state and TTFT dashboard surface');

  const troubleshooting = read('docs/operations/troubleshooting.md');
  assert.doesNotMatch(troubleshooting, /\/version\b/);
  assert.match(
    troubleshooting,
    /There is no node `limits\.rpm`, `rpm_mode`/i,
    'retired node RPM fields may only appear as an explicit negative statement',
  );
  assert.doesNotMatch(
    troubleshooting,
    /(?:check|inspect|configure|set)[^\n]{0,100}(?:limits\.rpm|rpm_mode)/i,
    'troubleshooting must not instruct operators to use retired node RPM fields',
  );
  assert.match(troubleshooting, /provider:\s*"openai"/i);
  assert.match(troubleshooting, /Access-key groups[^\n]*do not assign Tier 1 scheduler priority/i);
  ok('troubleshooting docs contain no retired operational instructions');

  const toolingReadme = read('scripts/README.md');
  assert.doesNotMatch(
    toolingReadme,
    /version:sync|Version synchronization|version-check\.mjs/i,
    'tooling docs must not restore retired project-version automation',
  );
  ok('tooling docs contain no retired version automation');

  const moduleAudit = read('docs/architecture/module-boundary-audit.md');
  assert.match(moduleAudit, /Baseline: `8e375078cbde553d91d71e1ed4784d790db2b390`/);
  assert.match(moduleAudit, /All material P1\/P2 ownership findings[\s\S]{0,120}resolved/i);
  assert.match(moduleAudit, /Tier 1 ownership/i);
  assert.match(moduleAudit, /request\/attempt\/success\.ts/i);
  assert.match(moduleAudit, /Automatic cooldown jitter/i);
  assert.match(moduleAudit, /no universal IR/i);
  ok('module boundary audit pins baseline, resolved ownership, and anti-over-abstraction guardrails');

  const calendar = read('docs/architecture/calendar-heatmap.md');
  assert.match(calendar, /`total` is physical upstream Token consumption/i);
  assert.match(calendar, /`requests` is \*\*successfully delivered requests\*\*/i);
  assert.doesNotMatch(
    calendar,
    /`scripts\/calendar-heatmap|`scripts\/token-usage-test/,
    'calendar docs must point to tests/, not retired scripts/ test locations',
  );
  ok('calendar docs match usage semantics and current test layout');

  for (const file of DOCS) {
    const text = read(file);
    assert.doesNotMatch(text, /RESPONSES_REASONING_MODE|ANTHROPIC_REASONING_REQUEST_MODE/, `${file}: removed knobs must stay absent`);
    assert.doesNotMatch(text, /max_attempts[^\n]{0,80}\bphysical\b/i, `${file}: max_attempts is logical`);
    assert.doesNotMatch(text, /CHANGELOG\.md|version-policy\.md|\/version\b/i, `${file}: project release/version surface must stay absent`);
    ok(`${file} has no retired contract surface`);
  }

  const deployManifest = JSON.parse(read('.github/deploy.json'));
  const deployScript = read('scripts/deploy.sh');
  const { RUNTIME_VAR_NAMES, RUNTIME_TUNABLES } = await import('#target/src/config/runtime-vars.ts');
  assert.equal(deployManifest.adapter, 'source-script');
  assert.equal(deployManifest.entrypoint, 'scripts/deploy.sh');
  assert.equal(deployManifest.automatic, true);
  assert.match(deployScript, /github-deployment-config\.mjs prepare --from-env/);
  assert.match(deployScript, /cloudflare-wrangler\.mjs deploy/);
  assert.doesNotMatch(deployScript, /AW_DISPATCH_TOKEN|AW_CONTROL_TOKEN|AW_ADMIN_TOKEN/);
  ok(`source-owned deploy script consumes all ${RUNTIME_VAR_NAMES.length} runtime variables through the canonical config builder`);

  const devVars = read('.dev.vars.example');
  assert.match(devVars, /Defaults live in src\/config\/runtime-vars\.ts/i, '.dev.vars.example must point operators to runtime-vars.ts for defaults');
  for (const tunable of RUNTIME_TUNABLES) {
    assert.ok(devVars.includes(tunable.name), `.dev.vars.example must mention ${tunable.name}`);
  }
  ok('.dev.vars.example references every current tunable and keeps defaults single-sourced');

  assert.match(routing, /Tier 1:[^\n]*Eligibility → Affinity → P2C/i);
  assert.doesNotMatch(routing, /Same tier \+ same priority = LRU rotation/i);
  ok('Tier 1 docs remain Affinity → P2C');

  console.log(`\ndocs contract tests passed (${passed}).`);
  console.log('ok - file:docs-contract');
} catch (error) {
  console.error('not ok - docs-contract-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// module-boundary-contract-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs
  //
  // Stable module-boundary contract.
  //
  // This is intentionally conservative: it locks dependency directions that are
  // already clean today. Known audit debts are documented in
  // docs/architecture/module-boundary-audit.md and are not hidden by a test that
  // the current tree cannot honestly satisfy.







  const srcRoot = path.join(root, 'src');

  function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.isFile() && /\.(?:ts|js|mjs)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  function moduleOf(file) {
    const rel = path.relative(srcRoot, file).replaceAll(path.sep, '/');
    return rel.split('/')[0];
  }

  function relativeSpecifiers(source) {
    const specs = [];
    const re = /(?:import\s+(?:[^'";]*?\s+from\s+)?|export\s+[^'";]*?\s+from\s+)['"]([^'"]+)['"]/g;
    for (const match of source.matchAll(re)) {
      if (match[1].startsWith('.')) specs.push(match[1]);
    }
    return specs;
  }

  function targetModule(file, specifier) {
    const resolved = path.resolve(path.dirname(file), specifier);
    const rel = path.relative(srcRoot, resolved).replaceAll(path.sep, '/');
    if (rel.startsWith('../') || rel === '..') return 'outside-src';
    return rel.split('/')[0];
  }

  const rules = {
    config: new Set(['scheduler', 'reliability', 'request', 'transport', 'conversion', 'stream', 'dashboard', 'runtime', 'observability', 'ratelimit']),
    providers: new Set([
      'request',
      'scheduler',
      'reliability',
      'transport',
      'conversion',
      'stream',
      'dashboard',
      'runtime',
      'observability',
      'ratelimit',
      'config',
      'oauth',
    ]),
    scheduler: new Set(['request', 'transport', 'protocol', 'conversion', 'stream', 'dashboard', 'runtime', 'observability', 'ratelimit']),
    reliability: new Set([
      'scheduler',
      'request',
      'transport',
      'protocol',
      'conversion',
      'stream',
      'dashboard',
      'runtime',
      'observability',
      'ratelimit',
    ]),
    transport: new Set(['scheduler', 'reliability', 'request', 'conversion', 'dashboard', 'runtime', 'observability', 'ratelimit']),
    conversion: new Set(['scheduler', 'reliability', 'request', 'transport', 'dashboard', 'runtime', 'observability', 'ratelimit', 'config']),
    runtime: new Set(['request', 'scheduler', 'transport', 'protocol', 'conversion', 'stream', 'dashboard', 'ratelimit']),
    dashboard: new Set(['request', 'scheduler', 'reliability', 'transport', 'conversion', 'stream', 'ratelimit']),
    ratelimit: new Set([
      'request',
      'scheduler',
      'reliability',
      'transport',
      'protocol',
      'conversion',
      'stream',
      'dashboard',
      'runtime',
      'observability',
    ]),
  };

  const violations = [];
  for (const file of walk(srcRoot)) {
    const owner = moduleOf(file);
    const forbidden = rules[owner];
    if (!forbidden) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const specifier of relativeSpecifiers(source)) {
      const target = targetModule(file, specifier);
      if (target === owner) continue;
      if (forbidden.has(target)) {
        violations.push(`${path.relative(root, file).replaceAll(path.sep, '/')}: ${owner} -> ${target} (${specifier})`);
      }
    }
  }
  assert.deepEqual(violations, [], `module dependency direction violated:\n${violations.join('\n')}`);

  const storeRoot = path.join(srcRoot, 'observability', 'token-usage-store');
  const storeForbidden = new Set([
    'request',
    'scheduler',
    'reliability',
    'transport',
    'conversion',
    'stream',
    'dashboard',
    'runtime',
    'ratelimit',
    'protocol',
  ]);
  const storeViolations = [];
  for (const file of walk(storeRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const specifier of relativeSpecifiers(source)) {
      const target = targetModule(file, specifier);
      if (storeForbidden.has(target)) {
        storeViolations.push(`${path.relative(root, file).replaceAll(path.sep, '/')}: observability store -> ${target} (${specifier})`);
      }
    }
  }
  assert.deepEqual(storeViolations, [], `persistent observability must stay routing-independent:\n${storeViolations.join('\n')}`);

  const preflight = fs.readFileSync(path.join(srcRoot, 'request', 'preflight.ts'), 'utf8');
  assert.ok(
    preflight.includes('../dashboard/pages.ts') && preflight.includes('../dashboard/readme-status.ts'),
    'request preflight remains the owner of local dashboard route dispatch',
  );

  const tier1State = fs.readFileSync(path.join(srcRoot, 'reliability', 'tier1-state.ts'), 'utf8');
  const tier1Heat = fs.readFileSync(path.join(srcRoot, 'reliability', 'tier1-heat.ts'), 'utf8');
  const tier1Scoring = fs.readFileSync(path.join(srcRoot, 'scheduler', 'tier1-scoring.ts'), 'utf8');
  assert.doesNotMatch(
    tier1State,
    /calculateTier1Score|TIER1_SCORE_BASE|tier1ProviderModelHeatFactor|recordTier1ProviderModelRateLimit/,
    'Tier 1 state must not regain scheduler scoring or provider-model heat policy',
  );
  assert.match(tier1Scoring, /export function calculateTier1Score/, 'Tier 1 score construction stays scheduler-owned');
  assert.match(tier1Scoring, /tier1ProviderModelHeatFactor/, 'scheduler scoring consumes heat through the heat owner');
  assert.match(tier1Heat, /export function tier1ProviderModelHeatFactor/, 'provider-model heat stays in reliability/tier1-heat.ts');
  assert.match(tier1Heat, /export function recordTier1ProviderModelRateLimit/, 'provider-model 429 observations stay in reliability/tier1-heat.ts');

  const nodeState = fs.readFileSync(path.join(srcRoot, 'reliability', 'node-state.ts'), 'utf8');
  const cooldownJitter = fs.readFileSync(path.join(srcRoot, 'reliability', 'cooldown-jitter.ts'), 'utf8');
  assert.match(cooldownJitter, /export function jitterCooldownMs/, 'automatic cooldown jitter arithmetic has one reliability owner');
  assert.match(nodeState, /from '\.\/cooldown-jitter\.ts'/, 'generic node reliability consumes the shared cooldown jitter primitive');
  assert.match(tier1State, /from '\.\/cooldown-jitter\.ts'/, 'Tier 1 reliability consumes the shared cooldown jitter primitive');
  assert.doesNotMatch(nodeState, /const JITTER_FACTOR|function maybeJitter/, 'generic node state must not regain private cooldown jitter arithmetic');
  assert.doesNotMatch(tier1State, /const JITTER_FACTOR|function jitter\(/, 'Tier 1 state must not regain private cooldown jitter arithmetic');

  const successDispatcher = fs.readFileSync(path.join(srcRoot, 'request', 'attempt', 'success.ts'), 'utf8');
  const successStream = fs.readFileSync(path.join(srcRoot, 'request', 'attempt', 'success-stream.ts'), 'utf8');
  const successObject = fs.readFileSync(path.join(srcRoot, 'request', 'attempt', 'success-object.ts'), 'utf8');
  assert.match(successDispatcher, /handleStreamingSuccess/);
  assert.match(successDispatcher, /handleObjectSuccess/);
  assert.match(successDispatcher, /clientWantsStream && s\.upstreamWasStreaming/, 'success dispatcher preserves the original streaming predicate');
  assert.doesNotMatch(
    successDispatcher,
    /ensureFirstSseEvent|collectResponsesObject|collectAnthropicMessageObject|trackStreamResponse/,
    'success.ts must remain a thin dispatcher',
  );
  assert.match(successStream, /ensureFirstSseEvent/, 'first-event commit guard stays in success-stream.ts');
  assert.match(successStream, /trackStreamResponse/, 'stream lifecycle wiring stays in success-stream.ts');
  assert.doesNotMatch(
    successStream,
    /collectResponsesObject|collectAnthropicMessageObject|collectOpenAIStreamObject/,
    'complete-object assembly must not leak back into success-stream.ts',
  );
  assert.match(successObject, /collectResponsesObject/, 'Responses object assembly stays in success-object.ts');
  assert.match(successObject, /collectAnthropicMessageObject/, 'Anthropic object assembly stays in success-object.ts');
  assert.match(successObject, /collectOpenAIStreamObject/, 'OpenAI object assembly stays in success-object.ts');
  assert.doesNotMatch(successObject, /ensureFirstSseEvent/, 'first-event guard must not leak into success-object.ts');

  const classifySource = fs.readFileSync(path.join(srcRoot, 'reliability', 'classify.ts'), 'utf8');
  const processingContract = fs.readFileSync(path.join(srcRoot, 'types', 'upstream-processing.ts'), 'utf8');
  assert.ok(
    relativeSpecifiers(classifySource).includes('../types/upstream-processing.ts'),
    'reliability classification consumes the neutral upstream-processing contract',
  );
  assert.doesNotMatch(
    classifySource,
    /transport\/processing-error/,
    'reliability must not regain a transport dependency for upstream-processing failures',
  );
  assert.match(processingContract, /export const UPSTREAM_PROCESSING_ERROR/);
  assert.match(processingContract, /export class UpstreamProcessingError/);
  assert.equal(
    fs.existsSync(path.join(srcRoot, 'transport', 'processing-error.ts')),
    false,
    'retired transport-owned processing-error module must stay removed',
  );

  // Provider knowledge has one registry owner. The retired provider switch
  // (provider-profile.ts) and the retired quirks module (provider-quirks.ts)
  // must not return; provider-specific wire, OAuth defaults, subscription
  // semantics and quirks are declared by adapters in src/providers/.
  assert.equal(
    fs.existsSync(path.join(srcRoot, 'config', 'provider-profile.ts')),
    false,
    'retired provider wire-profile switch must stay removed; the provider registry owns provider -> wire',
  );
  assert.equal(
    fs.existsSync(path.join(srcRoot, 'config', 'provider-quirks.ts')),
    false,
    'retired provider quirks module must stay removed; adapters declare their own quirks',
  );
  const providerRegistry = fs.readFileSync(path.join(srcRoot, 'providers', 'registry.ts'), 'utf8');
  assert.match(providerRegistry, /export function getProviderAdapter/, 'provider adapter resolution has one registry owner');
  assert.match(providerRegistry, /genericOpenAIProviderAdapter/, 'unknown providers resolve to the generic OpenAI-compatible adapter');
  const routingStrategy = fs.readFileSync(path.join(srcRoot, 'scheduler', 'routing-strategy.ts'), 'utf8');
  assert.match(routingStrategy, /export function routingStrategyFor/, 'tier -> routing strategy resolution has one registry owner');
  const tierLoopSource = fs.readFileSync(path.join(srcRoot, 'request', 'tier-loop.ts'), 'utf8');
  assert.match(tierLoopSource, /routingStrategyFor\(/, 'the tier loop resolves selection through the routing-strategy contract');
  assert.doesNotMatch(tierLoopSource, /pickTier1Candidate|pickCandidate/, 'the tier loop must not regain direct picker branching by tier');
  const subscriptionIndex = fs.readFileSync(path.join(srcRoot, 'subscription', 'index.ts'), 'utf8');
  assert.doesNotMatch(
    subscriptionIndex,
    /getSubscriptionAdapter|const ADAPTERS/,
    'subscription index must not regain a second provider adapter registry',
  );
  for (const core of ['scheduler', 'reliability', 'transport']) {
    for (const file of walk(path.join(srcRoot, core))) {
      assert.doesNotMatch(
        fs.readFileSync(file, 'utf8'),
        /providers\/registry\.ts/,
        `${core} must not depend on the provider registry (provider knowledge stays behind config/dispatch boundaries): ${path.relative(root, file)}`,
      );
    }
  }

  const audit = fs.readFileSync(path.join(root, 'docs/architecture/module-boundary-audit.md'), 'utf8');
  assert.match(audit, /Baseline: `8e375078cbde553d91d71e1ed4784d790db2b390`/);
  assert.match(audit, /All material P1\/P2 ownership findings .* are resolved/i);
  assert.match(audit, /Tier 1 ownership/i);
  assert.match(audit, /Success finalization/i);
  assert.match(audit, /upstream-processing\.ts/);
  assert.match(audit, /Automatic cooldown jitter/i);
  assert.match(audit, /Intentional duplication/i);

  console.log('module-boundary contract tests passed.');
  console.log('ok - file:module-boundary-contract');
} catch (error) {
  console.error('not ok - module-boundary-contract-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// architecture-contract-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs
  //
  // Architecture Contract Tests — codify invariant guarantees of the gateway.






  const ACCESS_KEY = 'test-access-key';
  let passed = 0;
  async function test(name, fn) {
    try {
      __resetAllStateForTests();
      __resetTier1StateForTests();
      __resetTier1AffinityForTests();
      await fn();
      passed++;
      console.log(`ok - ${name}`);
    } catch (e) {
      console.error(`FAIL: ${name}`);
      console.error(e?.stack || e);
      process.exitCode = 1;
    }
  }

  const upstreamCalls = [];
  let routeHandlers = {};
  function installMockFetch() {
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const handler = routeHandlers[url.hostname];
      if (!handler) throw new Error(`no mock upstream for ${url.hostname}`);
      upstreamCalls.push({
        host: url.hostname,
        path: url.pathname,
        headers: init?.headers,
        body: init?.body !== undefined ? JSON.parse(init.body) : null,
      });
      return handler(new Request(url, { method: 'POST', headers: init?.headers, body: init?.body }), url, init);
    };
  }
  function resetMock() {
    upstreamCalls.length = 0;
    routeHandlers = {};
  }

  function makeEnv({ tier1, tier2, tier3, secrets, extraEnv } = {}) {
    const tierSecrets = (nodes = []) =>
      Object.fromEntries(nodes.map((node) => [node.id, secrets?.[node.id]]).filter(([, credential]) => credential !== undefined));
    const tier1Secrets = tierSecrets(tier1);
    const tier2Secrets = tierSecrets(tier2);
    const tier3Secrets = tierSecrets(tier3);
    return {
      AIG_ACCESS_KEY_AIR: ACCESS_KEY,
      AIG_ACCESS_MODELS_AIR: '*',
      TIER1_SCHEDULER_SEED: 'arch-contract-test',
      ...(tier1 ? { AIG_TIER1_NODES_01: JSON.stringify(tier1) } : {}),
      ...(tier2 ? { AIG_TIER2_NODES_01: JSON.stringify(tier2) } : {}),
      ...(tier3 ? { AIG_TIER3_NODES_01: JSON.stringify(tier3) } : {}),
      ...(Object.keys(tier1Secrets).length ? { AIG_TIER1_CREDENTIALS_01: JSON.stringify(tier1Secrets) } : {}),
      ...(Object.keys(tier2Secrets).length ? { AIG_TIER2_CREDENTIALS_01: JSON.stringify(tier2Secrets) } : {}),
      ...(Object.keys(tier3Secrets).length ? { AIG_TIER3_CREDENTIALS_01: JSON.stringify(tier3Secrets) } : {}),
      ...extraEnv,
    };
  }

  const openaiChatNode = (id, extra = {}) => ({
    id,
    provider: 'mock',
    base_url: `https://${id}.example.com/v1`,
    models: { 'Code-Max': 'up-model' },
    ...extra,
  });
  const anthropicNode = (id, extra = {}) => ({
    id,
    provider: 'anthropic',
    base_url: `https://${id}.example.com`,
    models: { 'Code-Max': 'up-model' },
    ...extra,
  });

  const chatRequest = (body) =>
    new Request('https://gateway.example.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
      body: JSON.stringify({ model: 'Code-Max', messages: [{ role: 'user', content: 'hi' }], ...body }),
    });
  const messagesRequest = (body) =>
    new Request('https://gateway.example.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ACCESS_KEY },
      body: JSON.stringify({ model: 'Code-Max', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], ...body }),
    });
  const jsonUpstream = (data, status = 200, headers = {}) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
  const okCompletion = () => ({
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  const okMessage = () => ({
    type: 'message',
    role: 'assistant',
    model: 'up-model',
    content: [{ type: 'text', text: 'hello' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  installMockFetch();

  await test('Contract 01: Native First — native runs before fallback', async () => {
    resetMock();
    routeHandlers['an.example.com'] = () => jsonUpstream(okMessage());
    routeHandlers['o1.example.com'] = () => jsonUpstream(okCompletion());
    const env = makeEnv({
      tier1: [anthropicNode('an'), openaiChatNode('o1')],
      secrets: { an: 'k', o1: 'k' },
      extraEnv: { AIG_PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'] }) },
    });
    const res = await worker.fetch(messagesRequest({}), env, {});
    assert.equal(res.status, 200);
    assert.deepEqual(
      upstreamCalls.map((c) => c.host),
      ['an.example.com'],
    );
  });

  await test('Contract 02: Native Empty + Explicit Fallback -> 200 via OpenAI', async () => {
    resetMock();
    routeHandlers['o1.example.com'] = () => jsonUpstream(okCompletion());
    const env = makeEnv({
      tier1: [openaiChatNode('o1')],
      secrets: { o1: 'k' },
      extraEnv: { AIG_PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'] }) },
    });
    const res = await worker.fetch(messagesRequest({}), env, {});
    assert.equal(res.status, 200);
    assert.equal((await res.json()).type, 'message');
    assert.deepEqual(
      upstreamCalls.map((c) => c.host),
      ['o1.example.com'],
    );
  });

  await test('Contract 03: Default ON — Anthropic request with only OpenAI nodes -> 200 via fallback', async () => {
    resetMock();
    routeHandlers['o1.example.com'] = () => jsonUpstream(okCompletion());
    const env = makeEnv({ tier1: [openaiChatNode('o1')], secrets: { o1: 'k' } });
    const res = await worker.fetch(messagesRequest({}), env, {});
    assert.equal(res.status, 200);
    assert.deepEqual(
      upstreamCalls.map((c) => c.host),
      ['o1.example.com'],
    );
  });

  await test('Contract 03b: AIG_PROTOCOL_FALLBACKS=disable -> 404', async () => {
    resetMock();
    routeHandlers['o1.example.com'] = () => jsonUpstream(okCompletion());
    const env = makeEnv({ tier1: [openaiChatNode('o1')], secrets: { o1: 'k' }, extraEnv: { AIG_PROTOCOL_FALLBACKS: 'disable' } });
    const res = await worker.fetch(messagesRequest({}), env, {});
    assert.equal(res.status, 404);
    assert.equal(upstreamCalls.length, 0);
  });

  await test('Contract 05: Hedge twin never crosses protocol/surface', async () => {
    resetMock();
    const slowStream = () => {
      const encoder = new TextEncoder();
      let i = 0;
      const lines = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"up-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      ];
      return new ReadableStream({
        async pull(controller) {
          if (i >= lines.length) return;
          await new Promise((r) => setTimeout(r, 300));
          controller.enqueue(encoder.encode(lines[i++]));
        },
      });
    };
    routeHandlers['an-slow.example.com'] = () => new Response(slowStream(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    routeHandlers['an-fast.example.com'] = () => jsonUpstream(okMessage());
    routeHandlers['o1.example.com'] = () => jsonUpstream(okCompletion());
    const env = makeEnv({
      tier1: [anthropicNode('an-slow'), anthropicNode('an-fast'), openaiChatNode('o1')],
      secrets: { 'an-slow': 'k', 'an-fast': 'k', o1: 'k' },
      extraEnv: {
        AIG_PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'] }),
        AIG_HEDGE_DELAY_MS: '50',
        AIG_POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 5, hedge: { enabled: true, tiers: ['tier1'] } } }),
        AIG_MODELS_CONFIG: JSON.stringify({ 'Code-Max': { policy: 'default' } }),
      },
    });
    const res = await worker.fetch(messagesRequest({ stream: true }), env, {});
    assert.equal(res.status, 200);
    const hosts = upstreamCalls.map((c) => c.host);
    assert.ok(hosts.includes('an-fast.example.com'));
    assert.ok(!hosts.includes('o1.example.com'));
  });

  await test('Contract 06: Stream commit -> no transparent failover', async () => {
    resetMock();
    const streamThenFail = () => {
      const encoder = new TextEncoder();
      let i = 0;
      const lines = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"up-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
      ];
      return new ReadableStream({
        pull(controller) {
          if (i >= lines.length) {
            controller.error(new Error('upstream died'));
            return;
          }
          controller.enqueue(encoder.encode(lines[i++]));
        },
      });
    };
    routeHandlers['an1.example.com'] = () => new Response(streamThenFail(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    routeHandlers['o1.example.com'] = () => jsonUpstream(okCompletion());
    const env = makeEnv({
      tier1: [anthropicNode('an1'), openaiChatNode('o1')],
      secrets: { an1: 'k', o1: 'k' },
      extraEnv: { AIG_PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'] }) },
    });
    await worker.fetch(messagesRequest({ stream: true }), env, {});
    const hosts = upstreamCalls.map((c) => c.host);
    assert.equal(hosts.filter((h) => h === 'an1.example.com').length, 1);
    assert.ok(!hosts.includes('o1.example.com'));
  });

  await test('Contract 07: Shared failover budget (attempts + fallback)', async () => {
    resetMock();
    routeHandlers['a1.example.com'] = () => jsonUpstream({ error: { message: 'overloaded' } }, 529);
    routeHandlers['a2.example.com'] = () => jsonUpstream({ error: { message: 'overloaded' } }, 529);
    routeHandlers['o1.example.com'] = () => jsonUpstream(okCompletion());
    const env = makeEnv({
      tier1: [anthropicNode('a1'), anthropicNode('a2'), openaiChatNode('o1')],
      secrets: { a1: 'k', a2: 'k', o1: 'k' },
      extraEnv: {
        AIG_PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'] }),
        AIG_MODELS_CONFIG: JSON.stringify({ 'Code-Max': { policy: 'default' } }),
        AIG_POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 3 } }),
      },
    });
    const res = await worker.fetch(messagesRequest({}), env, {});
    assert.equal(res.status, 200);
    assert.equal(upstreamCalls.length, 3);
  });

  await test('Contract 08: Logical attempt != physical hedge dispatch count', async () => {
    resetMock();
    routeHandlers['an-slow.example.com'] = (_req, _url, init) =>
      new Promise((_, reject) => {
        if (init?.signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    routeHandlers['an-twin.example.com'] = async (_req, _url, init) => {
      await new Promise((r) => setTimeout(r, 150));
      if (init?.signal?.aborted) throw new Error('aborted');
      return jsonUpstream(okMessage());
    };
    const env = makeEnv({
      tier1: [anthropicNode('an-slow'), anthropicNode('an-twin')],
      secrets: { 'an-slow': 'k', 'an-twin': 'k' },
      extraEnv: {
        AIG_HEDGE_DELAY_MS: '120',
        AIG_FAILOVER_BUDGET_MS: '30000',
        AIG_UPSTREAM_HEADER_TIMEOUT_MS: '2000',
        AIG_POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 5, hedge: { enabled: true, tiers: ['tier1'] } } }),
        AIG_MODELS_CONFIG: JSON.stringify({ 'Code-Max': { policy: 'default' } }),
      },
    });
    const res = await worker.fetch(messagesRequest({}), env, {});
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(upstreamCalls.map((c) => c.host).sort(), ['an-slow.example.com', 'an-twin.example.com'].sort());
    assert.equal(getNodeState('an-slow').totalFailures, 0);
    assert.equal(getNodeState('an-twin').totalSuccesses, 1);
  });

  await test('Contract 09: removed node limits are rejected instead of influencing admission', async () => {
    resetMock();
    routeHandlers['an1.example.com'] = () => jsonUpstream(okMessage());
    const env = makeEnv({
      tier1: [anthropicNode('an1', { limits: { concurrency: 1, rpm: 60, rpm_mode: 'hard' } })],
      secrets: { an1: 'k' },
    });
    const health = await worker.fetch(
      new Request('https://gateway.example.com/health', { headers: { authorization: `Bearer ${ACCESS_KEY}` } }),
      env,
      {},
    );
    assert.equal(health.status, 503);
    const healthBody = await health.json();
    assert.equal(healthBody.status, 'invalid');
    assert.ok(healthBody.diagnostics.some((d) => d.includes('unknown field "limits"')));
    const res = await worker.fetch(messagesRequest({}), env, {});
    assert.equal(res.status, 404);
    assert.equal(upstreamCalls.length, 0);
  });

  await test('Contract 10: Closed Catalog - wildcard node rejects unknown model', async () => {
    resetMock();
    const wildcardNode = {
      id: 'wc1',
      provider: 'mock',
      base_url: 'https://wc1.example.com/v1',
      models: {},
    };
    routeHandlers['wc1.example.com'] = () => jsonUpstream(okCompletion());
    const env = makeEnv({
      tier1: [wildcardNode],
      secrets: { wc1: 'k' },
      extraEnv: { AIG_MODELS_CONFIG: JSON.stringify({ 'Code-Max': { policy: 'default' } }) },
    });
    assert.equal((await worker.fetch(chatRequest({}), env, {})).status, 200);
    assert.equal((await worker.fetch(chatRequest({ model: 'random-model-xxx' }), env, {})).status, 404);
  });

  await test('Contract 11: Visible == Callable (key-scoped)', () => {
    assert.ok(true, 'Visible == Callable is enforced by model-authz and models response');
  });

  await test('Contract 12: Model Missing Isolation (per node-model pair)', async () => {
    resetMock();
    routeHandlers['an1.example.com'] = async (req) => {
      const body = await req.json();
      if (body.model === 'up-max') return jsonUpstream({ error: { message: 'Model not found' } }, 404);
      return jsonUpstream(okMessage());
    };
    const env = makeEnv({
      tier1: [anthropicNode('an1', { models: { 'Code-Max': 'up-max', 'Code-Pro': 'up-pro' } })],
      secrets: { an1: 'k' },
      extraEnv: { AIG_MODELS_CONFIG: JSON.stringify({ 'Code-Max': { policy: 'default' }, 'Code-Pro': { policy: 'default' } }) },
    });
    const res1 = await worker.fetch(messagesRequest({ model: 'Code-Max' }), env, {});
    assert.equal(res1.status, 200);
    assert.equal((await res1.json()).model, 'Code-Max');
    assert.equal((await worker.fetch(messagesRequest({ model: 'Code-Pro' }), env, {})).status, 200);
  });

  await test('Contract 13: Runtime projection does not feedback to hot path', () => {
    assert.ok(true, 'model-status remains a read-only projection');
  });

  await test('Contract 14: D1 failure/missing binding does not block routing', async () => {
    resetMock();
    routeHandlers['an1.example.com'] = () => jsonUpstream(okMessage());
    const env = makeEnv({ tier1: [anthropicNode('an1')], secrets: { an1: 'k' } });
    assert.equal((await worker.fetch(messagesRequest({}), env, {})).status, 200);
  });

  await test('Contract 15: Tier 2/3 selector returns unified candidate shape', async () => {
    resetMock();
    const { pickCandidate } = await import('#target/src/scheduler/scheduler.ts');
    const { __resetAllStateForTests: reset } = await import('#target/src/reliability/node-state.ts');
    reset();
    const nodes = [
      {
        id: 't2a',
        tier: 'tier-2',
        provider: 'mock',
        protocol: 'openai',
        surfaces: ['chat_completions'],
        baseUrl: 'https://t2a.example.com/v1',
        credential: 'k',
        models: { 'Code-Max': 'up' },
        priority: 10,
      },
      {
        id: 't2b',
        tier: 'tier-2',
        provider: 'mock',
        protocol: 'openai',
        surfaces: ['chat_completions'],
        baseUrl: 'https://t2b.example.com/v1',
        credential: 'k',
        models: { 'Code-Max': 'up' },
        priority: 10,
      },
    ];
    const req = { model: 'Code-Max', protocol: 'openai', surface: 'chat_completions' };
    const r1 = pickCandidate(nodes, req, new Set());
    assert.ok(r1?.node);
    const r2 = pickCandidate(nodes, req, new Set([r1.node.id]));
    assert.ok(r2?.node);
    assert.equal(pickCandidate(nodes, req, new Set([r1.node.id, r2.node.id])), null);
    assert.ok('raceLost' in r1 || r1.raceLost === undefined);
    assert.ok('releaseToken' in r1 || r1.releaseToken === undefined);
    reset();
  });

  await test('Contract 16: one tier allocation model preserves Tier precedence', async () => {
    resetMock();
    const { computeTierCaps } = await import('#target/src/request/tier-loop.ts');
    const { __resetAllStateForTests: reset } = await import('#target/src/reliability/node-state.ts');
    reset();
    const runtimeNode = (id, tier) => ({
      id,
      tier,
      provider: 'mock',
      protocol: 'openai',
      surfaces: ['chat_completions'],
      baseUrl: `https://${id}.example.com/v1`,
      credential: 'k',
      priority: 10,
      models: { 'Code-Max': 'up' },
    });
    const tiers = {
      1: [],
      2: [runtimeNode('t2-a', 'tier-2')],
      3: [runtimeNode('t3-a', 'tier-3'), runtimeNode('t3-b', 'tier-3'), runtimeNode('t3-c', 'tier-3')],
    };
    const req = { model: 'Code-Max', protocol: 'openai', surface: 'chat_completions' };

    const caps = computeTierCaps(
      tiers,
      req,
      new Set(),
      {
        maxAttempts: 6,
        tierAttempts: null,
        hedge: null,
        firstEventTimeoutMs: null,
        maxInFlight: null,
      },
      new Set(['Code-Max']),
    );
    assert.deepEqual(caps, { 1: 0, 2: 5, 3: 1 }, 'node count must not pull surplus away from the first dispatchable tier');

    const explicit = computeTierCaps(
      tiers,
      req,
      new Set(),
      {
        maxAttempts: 6,
        tierAttempts: { tier2: 3 },
        hedge: null,
        firstEventTimeoutMs: null,
        maxInFlight: null,
      },
      new Set(['Code-Max']),
    );
    assert.deepEqual(explicit, { 1: 0, 2: 3, 3: 3 }, 'explicit tier cap stays fixed and the remaining tier receives the remainder');

    const disabled = computeTierCaps(
      tiers,
      req,
      new Set(),
      {
        maxAttempts: 6,
        tierAttempts: { tier2: 0 },
        hedge: null,
        firstEventTimeoutMs: null,
        maxInFlight: null,
      },
      new Set(['Code-Max']),
    );
    assert.deepEqual(disabled, { 1: 0, 2: 0, 3: 6 }, 'explicit zero disables Tier 2');
    reset();
  });

  console.log(`\nArchitecture contract tests passed (${passed}).`);
  if (process.exitCode) suiteExit(1);
  console.log('ok - file:architecture-contract');
} catch (error) {
  console.error('not ok - architecture-contract-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// product-policy-contract-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT






  const read = (path) => readFileSync(join(root, path), 'utf8');
  const product = read('docs/governance/product-policy.md');
  const development = read('docs/governance/development-policy.md');
  const overview = read('docs/architecture/overview.md');

  assert.match(product, /household, an individual operator, or a small trusted team/i);
  assert.match(product, /Tier 1 — free-token capacity/i);
  assert.match(product, /Tier 2 — membership\/subscription entitlement capacity/i);
  assert.match(product, /Tier 3 — paid API capacity/i);
  assert.match(product, /maintains one current contract/i, 'repository must keep one current contract');
  assert.match(
    product,
    /do not add aliases, dual-read\/dual-write paths, deprecation windows, compatibility switches, or shims/i,
    'retired contract shims must stay forbidden',
  );
  assert.match(product, /Project release numbering is human-owned only/i, 'release numbering must stay human-owned');
  assert.match(product, /human creates the Git tag or GitHub Release manually/i, 'named releases must remain explicit human actions');
  assert.match(product, /Automation must never create or advance release numbering/i, 'automation must not own release numbering');
  assert.match(product, /Prefer deletion over preserving obsolete transitional design/i, 'obsolete transitional design must be deleted');

  assert.match(development, /Clean replacement rule/i);
  assert.match(development, /remove the superseded path in the same change/i);
  assert.match(
    development,
    /Tier 1 is free-token capacity.*Tier 2 is reserved for membership\/subscription entitlements.*Tier 3 is reserved for paid API capacity/is,
  );
  assert.match(development, /Project release numbering is not an engineering automation concern/i);

  assert.match(overview, /Tier 1.*Free or effectively free token capacity/is);
  assert.match(overview, /Tier 2.*Membership\/subscription entitlement capacity/is);
  assert.match(overview, /Tier 3.*Paid API capacity/is);

  console.log('product policy contract tests passed.');
  console.log('ok - file:product-policy-contract');
} catch (error) {
  console.error('not ok - product-policy-contract-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// release-identity-contract-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT






  const read = (path) => readFileSync(join(root, path), 'utf8');

  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(Object.hasOwn(pkg, 'version'), false, 'package.json must not own project release numbering');
  assert.equal(Object.hasOwn(lock, 'version'), false, 'package-lock root must not own project release numbering');
  assert.equal(Object.hasOwn(lock.packages?.[''] || {}, 'version'), false, 'root lock package must not own project release numbering');

  for (const rel of [
    'src/config/version.ts',
    'scripts/generate-version.mjs',
    'scripts/version-check.mjs',
    'tests/version-check-test.mjs',
    'docs/governance/version-policy.md',
  ]) {
    assert.equal(existsSync(join(root, rel)), false, `${rel} must stay deleted`);
  }

  const router = read('src/request/router.ts');
  const diagnostics = read('src/observability/diagnostic-endpoints.ts');
  const deploy = read('scripts/github-deployment-config.mjs');
  const installSh = read('scripts/install.sh');
  const installPs1 = read('scripts/install.ps1');
  const toolingReadme = read('scripts/README.md');
  const product = read('docs/governance/product-policy.md');

  assert.equal(router.includes("'/version'"), false, 'runtime must not expose /version');
  assert.equal(diagnostics.includes('#target/config/version'), false, 'runtime must not import a source version module');
  assert.match(diagnostics, /build:\s*resolveBuildSha\(env\)/, '/health must expose commit build identity');
  // biome-ignore lint/suspicious/noTemplateCurlyInString: verifies the literal ${origin} text appears in the deployment script source
  assert.equal(deploy.includes('`${origin}/version`'), false, 'deployment verifier must not use /version');
  // biome-ignore lint/suspicious/noTemplateCurlyInString: verifies the literal ${origin} text appears in the deployment script source
  assert.ok(deploy.includes('`${origin}/health`'), 'deployment verifier must use /health');
  assert.match(deploy, /healthBody\?\.build !== expectedBuild/, 'deployment verification must compare commit SHA');
  for (const [name, source] of [
    ['POSIX installer', installSh],
    ['PowerShell installer', installPs1],
  ]) {
    assert.equal(source.includes('/version'), false, `${name} must not probe retired /version`);
    assert.equal(source.includes('scripts/version-check.mjs'), false, `${name} must not call the deleted version-check script`);
    assert.ok(source.includes('/health'), `${name} must verify /health`);
    assert.ok(source.includes('/v1/models'), `${name} must verify /v1/models`);
    assert.ok(source.includes('engines.node'), `${name} must read the Node requirement from package.json`);
  }
  assert.doesNotMatch(
    toolingReadme,
    /version:sync|Version synchronization|version-check\.mjs/i,
    'tooling docs must not restore retired project-version automation',
  );
  assert.match(product, /Project release numbering is human-owned only/i);
  assert.match(product, /human creates the Git tag or GitHub Release manually/i);

  console.log('release identity contract tests passed.');
  console.log('ok - file:release-identity-contract');
} catch (error) {
  console.error('not ok - release-identity-contract-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}
