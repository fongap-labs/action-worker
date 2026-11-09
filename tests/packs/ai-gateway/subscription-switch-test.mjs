// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// AIG-003 replacement: retired subscription switches and OAuth nodes must
// reject the entire configuration. The public Gateway must never resume a
// hidden membership proxy or dispatch to the private execution center.

import { assert, beforeEach, test } from '#kit/harness.mjs';
import worker from '#target/src/index.ts';
import { loadGatewayConfig } from '#target/src/config/nodes.ts';
import { MAX_KEY, makeEnv, oauthNode, resetCaches } from './hardening-fixtures.mjs';

beforeEach(resetCaches);

function isolatedEnv(overrides = {}) {
  const env = makeEnv(overrides);
  let centerCalls = 0;
  env.AIG_INFERENCE_ACTIVE = 'true';
  env.AIG_INFERENCE_SERVICE = {
    fetch: async () => {
      centerCalls += 1;
      throw new Error('retired OAuth traffic must not dispatch');
    },
  };
  return { env, centerCalls: () => centerCalls };
}

test('ordinary free and paid Token nodes remain available without membership config', () => {
  const { env } = isolatedEnv();
  const config = loadGatewayConfig(env);
  assert.equal(config.status, 'ready');
  assert.deepEqual(Object.keys(config.tiers).sort(), ['1', '2']);
  assert.ok(config.tiers[1].some((node) => node.id === 'static1'));
  assert.ok(config.tiers[2].some((node) => node.id === 'token1'));
});

test('all old subscription-switch spellings fail closed rather than silently disabling a tier', () => {
  for (const value of ['false', '0', 'no', 'off', 'true']) {
    const { env } = isolatedEnv({ AIG_IS_SUBSCRIPTION_ENABLED: value });
    const config = loadGatewayConfig(env);
    assert.equal(config.status, 'invalid', value);
    assert.equal(config.nodesUsable, 0);
    assert.ok(config.diagnostics.some((line) => line.includes('AIG_IS_SUBSCRIPTION_ENABLED')));
  }
});

test('old subscription OAuth node in a mixed Tier 2 pool fails the entire config', () => {
  const base = makeEnv();
  const current = JSON.parse(base.AIG_TIER2_NODES_01);
  const config = loadGatewayConfig({
    ...base,
    AIG_TIER2_NODES_01: JSON.stringify([...current, oauthNode('sub1')]),
  });
  assert.equal(config.status, 'invalid');
  assert.equal(config.nodesUsable, 0, 'old subscriber capacity must not leak static Token fallback');
});

test('OAuth start, paste and callback routes stay 404 for both old switch states', async () => {
  for (const value of ['false', 'true']) {
    const { env, centerCalls } = isolatedEnv({ AIG_IS_SUBSCRIPTION_ENABLED: value });
    for (const [method, path] of [
      ['GET', '/oauth/start?provider=mock&node=sub1'],
      ['POST', '/oauth/start'],
      ['GET', '/oauth/paste?state=s'],
      ['GET', '/oauth/callback/mock?code=c&state=s'],
    ]) {
      const res = await worker.fetch(new Request('https://gateway.example.com' + path, { method }), env, {});
      assert.equal(res.status, 404, method + ' ' + path);
      assert.equal(res.headers.get('set-cookie'), null);
    }
    assert.equal(centerCalls(), 0, 'retired OAuth must never call private inference');
  }
});

test('health remains metadata-only and never dispatches inference', async () => {
  const { env, centerCalls } = isolatedEnv();
  const res = await worker.fetch(
    new Request('https://gateway.example.com/health', { headers: { authorization: 'Bearer ' + MAX_KEY } }),
    env,
    {},
  );
  assert.equal(res.status, 200);
  assert.equal(centerCalls(), 0);
});
