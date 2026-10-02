// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// /health lists only the nodes behind models the caller's key may use; counts stay gateway-wide.

import { assert, test } from '#kit/harness.mjs';
import { __resetAccessKeysCacheForTests } from '#target/src/config/access-keys.ts';
import worker from '#target/src/index.ts';

const node = (id, models) => ({ id, provider: 'mock', base_url: `https://${id}.example.com/v1`, models });

function makeEnv() {
  __resetAccessKeysCacheForTests();
  return {
    AIG_ACCESS_KEY_AIR: 'air-key',
    AIG_ACCESS_MODELS_AIR: 'model-a',
    AIG_ACCESS_KEY_PRO: 'pro-key',
    AIG_ACCESS_MODELS_PRO: '*',
    AIG_TIER1_NODES_01: JSON.stringify([node('node-a', { 'model-a': 'up-a' }), node('node-b', { 'model-b': 'up-b' })]),
    AIG_TIER1_CREDENTIALS_01: JSON.stringify({ 'node-a': 'k', 'node-b': 'k' }),
  };
}

async function health(key) {
  const res = await worker.fetch(
    new Request('https://gateway.example.com/health', { headers: { authorization: `Bearer ${key}` } }),
    makeEnv(),
    {},
  );
  assert.equal(res.status, 200);
  return res.json();
}

test('a restricted key sees only the nodes behind its allowed models', async () => {
  const body = await health('air-key');
  assert.deepEqual(
    body.endpoints.map((e) => e.id),
    ['node-a'],
  );
  assert.equal(body.nodes_total, 2, 'aggregate counts stay gateway-wide');
});

test('a key allowed every model sees every node', async () => {
  const body = await health('pro-key');
  assert.deepEqual(body.endpoints.map((e) => e.id).sort(), ['node-a', 'node-b']);
});

test('/health still requires a valid key', async () => {
  const res = await worker.fetch(new Request('https://gateway.example.com/health'), makeEnv(), {});
  assert.equal(res.status, 401);
});
