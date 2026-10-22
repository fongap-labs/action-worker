// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// AIG-005: AIG_DIAGNOSTICS_GROUPS names the key groups that read /health and /metrics;
// unset, only MAX and ULTRA keys do.

import { assert, beforeEach, test } from '#kit/harness.mjs';
import worker from '#target/src/index.ts';
import { preflight } from '#target/scripts/github-deployment-config.mjs';
import { AGENT_KEY, AIR_KEY, MAX_KEY, makeEnv, resetCaches } from './hardening-fixtures.mjs';

beforeEach(resetCaches);

const get = (path, key, env) =>
  worker.fetch(new Request(`https://gateway.example.com${path}`, { headers: { authorization: `Bearer ${key}` } }), env, {});

test('without the variable only MAX and ULTRA keys read diagnostics', async () => {
  const env = makeEnv({ AIG_ACCESS_KEY_ULTRA: 'ultra-test-key', AIG_ACCESS_MODELS_ULTRA: '*' });
  for (const path of ['/health', '/metrics']) {
    assert.equal((await get(path, MAX_KEY, env)).status, 200, path);
    assert.equal((await get(path, 'ultra-test-key', env)).status, 200, path);
    assert.equal((await get(path, AIR_KEY, env)).status, 403, path);
    assert.equal((await get(path, AGENT_KEY, env)).status, 403, path);
  }
});

test('"*" lets every valid key read diagnostics', async () => {
  const env = makeEnv({ AIG_DIAGNOSTICS_GROUPS: '*' });
  for (const path of ['/health', '/metrics']) {
    assert.equal((await get(path, AIR_KEY, env)).status, 200, path);
    assert.equal((await get(path, AGENT_KEY, env)).status, 200, path);
  }
  assert.equal((await get('/health', 'wrong-key', env)).status, 401);
});

test('with the variable only the named groups read diagnostics', async () => {
  const env = makeEnv({ AIG_DIAGNOSTICS_GROUPS: 'AGENT' });
  for (const path of ['/health', '/metrics']) {
    assert.equal((await get(path, AIR_KEY, env)).status, 403, path);
    assert.equal((await get(path, AGENT_KEY, env)).status, 200, path);
  }
  assert.equal((await get('/health', 'wrong-key', env)).status, 401);
});

test('group names are case-insensitive and may be listed together', async () => {
  const env = makeEnv({ AIG_DIAGNOSTICS_GROUPS: ' air , agent ' });
  assert.equal((await get('/metrics', AIR_KEY, env)).status, 200);
  assert.equal((await get('/metrics', AGENT_KEY, env)).status, 200);
});

test('the model list stays open to every key', async () => {
  const env = makeEnv({ AIG_DIAGNOSTICS_GROUPS: 'AGENT' });
  assert.equal((await get('/v1/models', AIR_KEY, env)).status, 200);
});

// The post-deploy check reads /health, so a deploy needs at least one key that may.
const deployEnv = (extra) => ({
  CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_API_TOKEN: 'token',
  AIG_PUBLIC_URL: 'https://gateway.example.com',
  AIG_TIER1_NODES_01: JSON.stringify([{ id: 'n1', provider: 'mock', base_url: 'https://n1.example.com/v1', models: { m: 'up' } }]),
  AIG_TIER1_CREDENTIALS_01: JSON.stringify({ n1: 'upstream-key' }),
  AIG_AFFINITY_KV_ID: 'kv-id',
  ...extra,
});
const healthErrors = (env) => preflight(env).errors.filter((error) => error.includes('/health'));

test('a deploy whose keys cannot read /health fails the preflight', () => {
  const errors = healthErrors(deployEnv({ AIG_ACCESS_KEY_AIR: 'k' }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /AIG_DIAGNOSTICS_GROUPS allows MAX, ULTRA/);
});

test('a deploy passes the preflight once one configured key may read /health', () => {
  assert.deepEqual(healthErrors(deployEnv({ AIG_ACCESS_KEY_AIR: 'k', AIG_ACCESS_KEY_MAX: 'm' })), []);
  assert.deepEqual(healthErrors(deployEnv({ AIG_ACCESS_KEY_AIR: 'k', AIG_DIAGNOSTICS_GROUPS: 'air' })), []);
  assert.deepEqual(healthErrors(deployEnv({ AIG_ACCESS_KEY_AIR: 'k', AIG_DIAGNOSTICS_GROUPS: '*' })), []);
});
