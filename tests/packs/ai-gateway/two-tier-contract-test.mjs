// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Two-tier replacement contract: free Tier 1 -> static API Token Tier 2.
// This is additive to the existing full test pack, not a waiver.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { targetRoot } from '#kit/target.mjs';
import { preflight } from '#target/apps/gateway/preflight.ts';
import { TIER_ORDER } from '#target/apps/gateway/policy/router.ts';
import { redistributeUnusedTierAttempts } from '#target/apps/gateway/scheduling/tier-policy.ts';
import { loadExecutionConfig, loadGatewayConfig } from '#target/src/config/nodes.ts';
import { getPoliciesConfigDiagnostics } from '#target/src/config/policies.ts';
import { routingStrategyFor } from '#target/src/scheduler/routing-strategy.ts';

function node(id, fields = {}) {
  return {
    id,
    provider: 'openai',
    base_url: 'https://provider.example.invalid/v1',
    models: { 'Code-Pro': 'upstream-model' },
    ...fields,
  };
}
const env = {
  AIG_ACCESS_KEY_AIR: 'fake-client-access-key',
  AIG_TIER1_NODES_01: JSON.stringify([node('free-a')]),
  AIG_TIER2_NODES_01: JSON.stringify([node('token-a')]),
};

assert.deepEqual(TIER_ORDER, [1, 2], 'the router may only schedule free and API Token tiers');
assert.equal(routingStrategyFor(1).id, 'p2c_ttft', 'Tier 1 remains adaptive free capacity');
assert.equal(routingStrategyFor(2).id, 'priority_lru', 'Tier 2 remains health-aware Token reserve');

const publicConfig = loadGatewayConfig(env);
assert.equal(publicConfig.status, 'ready');
assert.deepEqual(Object.keys(publicConfig.tiers).sort(), ['1', '2']);
assert.deepEqual(publicConfig.tiers[2].map((n) => n.id), ['token-a']);
assert.equal(publicConfig.tiers[1][0]?.credential, '', 'public gateway cannot read a free Provider credential');
assert.equal(publicConfig.tiers[2][0]?.credential, '', 'public gateway cannot read paid Token credentials');

const privateConfig = loadExecutionConfig({
  ...env,
  AIG_TIER1_CREDENTIALS_01: JSON.stringify({ 'free-a': 'free-fixture-token' }),
  AIG_TIER2_CREDENTIALS_01: JSON.stringify({ 'token-a': 'paid-fixture-token' }),
});
assert.equal(privateConfig.status, 'ready');
assert.equal(privateConfig.tiers[2][0]?.credential, 'paid-fixture-token', 'private center owns the static Token');

const caps = { 1: 3, 2: 1 };
assert.deepEqual(
  redistributeUnusedTierAttempts({ ...caps }, 1, 2, { maxAttempts: 5, tierAttempts: null }),
  { 1: 3, 2: 3 },
  'unused free capacity can move to the final Token tier within request budget',
);
assert.deepEqual(
  redistributeUnusedTierAttempts({ ...caps }, 1, 2, { maxAttempts: 5, tierAttempts: { tier2: 1 } }),
  caps,
  'explicit Token tier attempt caps must not be inflated',
);
assert.deepEqual(
  redistributeUnusedTierAttempts({ ...caps }, 2, 2, { maxAttempts: 5, tierAttempts: null }),
  caps,
  'no implicit third fallback tier may exist',
);

for (const legacyBinding of ['AIG_TIER3_NODES_01', 'AIG_TIER3_CREDENTIALS_01']) {
  const legacy = loadGatewayConfig({ ...env, [legacyBinding]: legacyBinding.includes('NODES') ? '[]' : '{}' });
  assert.equal(legacy.status, 'invalid', 'legacy Tier 3 cannot silently disappear');
  assert.equal(legacy.nodesUsable, 0);
  assert.ok(legacy.diagnostics.some((line) => line.includes(legacyBinding)));
}
const privateLegacy = loadExecutionConfig({
  ...env,
  AIG_TIER2_CREDENTIALS_01: JSON.stringify({ 'token-a': 'paid-fixture-token' }),
  AIG_TIER3_CREDENTIALS_01: JSON.stringify({ 'old-paid': 'old-fixture-token' }),
});
assert.equal(privateLegacy.status, 'invalid', 'private center must reject unconverted Tier 3 credentials');
assert.equal(privateLegacy.nodesUsable, 0);

for (const legacyPolicy of [
  { default: { max_attempts: 4, tier_attempts: { tier1: 1, tier3: 2 } } },
  { default: { hedge: { enabled: true, tiers: ['tier3'] } } },
]) {
  const policyEnv = { ...env, AIG_POLICIES_CONFIG: JSON.stringify(legacyPolicy) };
  assert.equal(loadGatewayConfig(policyEnv).status, 'invalid', 'old policy budgets must fail closed');
  assert.ok(getPoliciesConfigDiagnostics(policyEnv).length > 0);
}
const validPolicyEnv = {
  ...env,
  AIG_POLICIES_CONFIG: JSON.stringify({
    default: { max_attempts: 4, tier_attempts: { tier1: 2, tier2: 2 }, hedge: { enabled: true, tiers: ['tier1', 'tier2'] } },
  }),
};
assert.deepEqual(getPoliciesConfigDiagnostics(validPolicyEnv), []);
assert.equal(loadGatewayConfig(validPolicyEnv).status, 'ready');

const obsoleteOauth = loadGatewayConfig({
  ...env,
  AIG_TIER2_NODES_01: JSON.stringify([node('token-a'), node('old-member', { auth: 'oauth' })]),
});
assert.equal(obsoleteOauth.status, 'invalid', 'legacy member nodes cannot become API Token capacity');
assert.equal(obsoleteOauth.nodesUsable, 0);

for (const setting of ['AIG_OAUTH_PROVIDERS', 'AIG_IS_SUBSCRIPTION_ENABLED', 'AIG_TOKEN_ENCRYPTION_KEY']) {
  const bad = loadGatewayConfig({ ...env, [setting]: 'retired-value' });
  assert.equal(bad.status, 'invalid', 'retired membership settings must reject the entire configuration');
  assert.equal(bad.nodesUsable, 0);
}

const retiredModules = [
  'apps/gateway/oauth/routes.ts',
  'apps/inference/credentials/resolve.ts',
  'packages/oauth/crypto.ts',
  'packages/oauth/token-store.ts',
  'src/oauth/crypto.ts',
  'src/oauth/provider-configs.ts',
  'src/oauth/resolve.ts',
  'src/oauth/routes.ts',
  'src/oauth/token-store.ts',
  'src/subscription/anthropic.ts',
  'src/subscription/google-wire.ts',
  'src/subscription/google.ts',
  'src/subscription/index.ts',
  'src/subscription/openai.ts',
  'src/subscription/quota-hints.ts',
  'src/subscription/types.ts',
];
for (const path of retiredModules) {
  assert.equal(existsSync(join(targetRoot, path)), false, 'old member runtime must not be restored: ' + path);
}

for (const method of ['GET', 'POST']) {
  for (const pathname of ['/oauth/start', '/oauth/callback', '/oauth/refresh']) {
    const request = new Request('https://gateway.example.invalid' + pathname, { method });
    const result = await preflight(
      request,
      { ...env, AIG_OAUTH_PROVIDERS: '{}' },
      { waitUntil() { throw new Error('OAuth callback must not start background work'); } },
    );
    assert.equal(result.ok, false);
    assert.equal(result.response.status, 404, method + ' ' + pathname + ' must not start OAuth');
    assert.equal(result.response.headers.get('set-cookie'), null, 'retired callbacks must not create cookies');
  }
}

console.log('Two-tier target contract passed: routing, budget, private keys, legacy rejection and retired OAuth.');
