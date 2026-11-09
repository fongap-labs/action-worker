// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Retired OAuth membership execution regression. These tests deliberately do
// not import removed subscription modules. Their former positive behavior is
// forbidden; no request may start OAuth, refresh a token or access OAuth D1.

import { assert, beforeEach, test } from '#kit/harness.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { targetRoot } from '#kit/target.mjs';
import worker from '#target/src/index.ts';
import { loadExecutionConfig, loadGatewayConfig } from '#target/src/config/nodes.ts';
import { AIR_KEY, makeEnv, oauthNode, RecordingD1, resetCaches, staticNode } from './hardening-fixtures.mjs';

beforeEach(resetCaches);

const retiredPaths = [
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

test('membership OAuth, subscriber provider adapters and token-store execution files are absent', () => {
  for (const path of retiredPaths) {
    assert.equal(existsSync(join(targetRoot, path)), false, 'retired executable source may not return: ' + path);
  }
});

test('new Tier 2 is static Token capacity rather than an OAuth entitlement', () => {
  const cfg = loadGatewayConfig(makeEnv());
  assert.equal(cfg.status, 'ready');
  assert.deepEqual(Object.keys(cfg.tiers).sort(), ['1', '2']);
  assert.ok(cfg.tiers[2].some((node) => node.id === 'token1'));
  assert.equal(cfg.tiers[2][0].credential, '');
});

test('old OAuth-only Tier 2 nodes fail closed rather than being ignored', () => {
  const cfg = loadGatewayConfig(makeEnv({
    AIG_TIER2_NODES_01: JSON.stringify([oauthNode('sub1')]),
  }));
  assert.equal(cfg.status, 'invalid');
  assert.equal(cfg.nodesUsable, 0);
});

test('mixed subscriber and Token Tier 2 nodes also fail closed', () => {
  const cfg = loadGatewayConfig(makeEnv({
    AIG_TIER2_NODES_01: JSON.stringify([staticNode('token1'), oauthNode('sub1')]),
  }));
  assert.equal(cfg.status, 'invalid');
  assert.equal(cfg.nodesUsable, 0);
});

test('no subscription toggle value reactivates subscriber capacity', () => {
  for (const value of ['true', 'false', '1', '0', 'yes', 'no', 'off', 'on']) {
    const cfg = loadGatewayConfig(makeEnv({ AIG_IS_SUBSCRIPTION_ENABLED: value }));
    assert.equal(cfg.status, 'invalid', value);
    assert.equal(cfg.nodesUsable, 0);
  }
});

test('all OAuth provider configuration and old encryption keys are retired', () => {
  for (const key of ['AIG_OAUTH_PROVIDERS', 'AIG_OAUTH_ADMIN_GROUPS', 'AIG_TOKEN_ENCRYPTION_KEY']) {
    const cfg = loadGatewayConfig(makeEnv({ [key]: 'fake-secret-do-not-log' }));
    assert.equal(cfg.status, 'invalid', key);
    assert.equal(cfg.nodesUsable, 0);
    assert.doesNotMatch(JSON.stringify(cfg), /fake-secret-do-not-log/);
  }
});

test('public Gateway never carries Tier 1 or Tier 2 Provider Secret values', () => {
  const cfg = loadGatewayConfig(makeEnv());
  assert.equal(cfg.status, 'ready');
  assert.doesNotMatch(JSON.stringify(cfg), /upstream-key|paid-fixture-key/);
  assert.equal(cfg.tiers[1][0].credential, '');
  assert.equal(cfg.tiers[2][0].credential, '');
});

test('private Inference Center only resolves the active static Tier credentials', () => {
  const cfg = loadExecutionConfig(makeEnv());
  assert.equal(cfg.status, 'ready');
  assert.equal(cfg.tiers[1][0].credential, 'upstream-key');
  assert.equal(cfg.tiers[2][0].credential, 'paid-fixture-key');
});

test('private center must reject old Tier 3 paid credentials instead of losing capacity silently', () => {
  const cfg = loadExecutionConfig(makeEnv({
    AIG_TIER3_CREDENTIALS_01: JSON.stringify({ 'old-paid': 'retired-fixture' }),
  }));
  assert.equal(cfg.status, 'invalid');
  assert.equal(cfg.nodesUsable, 0);
});

test('no live RuntimeNode or Provider registry may declare a subscriber adapter', () => {
  const type = readFileSync(join(targetRoot, 'src/types/node.ts'), 'utf8');
  const providers = readFileSync(join(targetRoot, 'src/providers/types.ts'), 'utf8');
  assert.doesNotMatch(type, /auth\?\s*:\s*['"]oauth['"]/);
  assert.doesNotMatch(providers, /subscription\?\s*:/);
});

test('GET and POST legacy onboarding routes return 404, never create sessions or dispatch', async () => {
  const db = new RecordingD1();
  const pending = [];
  let centerCalls = 0;
  const env = makeEnv({
    TOKEN_STATS_DB: db,
    AIG_INFERENCE_SERVICE: {
      fetch: async () => {
        centerCalls += 1;
        throw new Error('OAuth must not call inference');
      },
    },
  });
  for (const [method, pathname] of [
    ['GET', '/oauth/start?provider=mock&node=sub1'],
    ['POST', '/oauth/start'],
    ['GET', '/oauth/paste?state=s'],
    ['POST', '/oauth/paste'],
    ['GET', '/oauth/callback/mock?code=c&state=s'],
    ['POST', '/oauth/callback/mock'],
    ['GET', '/oauth/refresh'],
  ]) {
    const response = await worker.fetch(
      new Request('https://gateway.example.com' + pathname, {
        method,
        headers: { authorization: 'Bearer ' + AIR_KEY },
      }),
      env,
      { waitUntil: (work) => pending.push(work) },
    );
    assert.equal(response.status, 404, method + ' ' + pathname);
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('set-cookie'), null);
  }
  assert.deepEqual(db.statements, [], 'legacy flow-state and token tables must not be accessed');
  assert.equal(centerCalls, 0, 'retired OAuth traffic must not enter private centers');
  assert.equal(pending.length, 0, 'retired OAuth must not register background refresh or cleanup');
});

test('old subscription resets cannot bypass two-tier policy or enable Tier 3', () => {
  for (const attempts of [{ tier1: 1, tier3: 1 }, { tier1: 1, tier2: 1, tier3: 1 }]) {
    const cfg = loadGatewayConfig(makeEnv({
      AIG_POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 4, tier_attempts: attempts } }),
    }));
    assert.equal(cfg.status, 'invalid');
    assert.equal(cfg.nodesUsable, 0);
  }
});
