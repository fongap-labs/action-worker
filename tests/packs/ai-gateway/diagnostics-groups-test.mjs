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
const deploymentHealthErrors = (env) => preflight(env).errors.filter((error) => error.includes('AIG_DEPLOY_HEALTH_KEY'));

test('deployment preflight requires a dedicated health secret', () => {
  const errors = deploymentHealthErrors(deployEnv({ AIG_ACCESS_KEY_AIR: 'k' }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /at least 32 characters/);
});

test('deployment preflight accepts a dedicated health secret without changing user diagnostics groups', () => {
  const env = deployEnv({
    AIG_ACCESS_KEY_AIR: 'k',
    AIG_DEPLOY_HEALTH_KEY: 'deployment-health-key-0123456789abcdef0123456789abcdef',
    AIG_DIAGNOSTICS_GROUPS: 'MAX',
  });
  assert.deepEqual(deploymentHealthErrors(env), []);
  assert.deepEqual(preflight(env).errors, []);
});

test('the dedicated deployment health key is restricted to health probes', async () => {
  const deployKey = 'deployment-health-key-0123456789abcdef0123456789abcdef';
  const env = makeEnv({
    AIG_DEPLOY_HEALTH_KEY: deployKey,
    AIG_DIAGNOSTICS_GROUPS: 'MAX',
  });

  const health = await get('/health', deployKey, env);
  assert.equal(health.status, 200);

  const metrics = await get('/metrics', deployKey, env);
  assert.equal(metrics.status, 401);

  const models = await get('/v1/models', deployKey, env);
  assert.equal(models.status, 200);
  assert.deepEqual((await models.json()).data, []);

  const countTokens = (messages, extra = {}) =>
    worker.fetch(
      new Request('https://gateway.example.com/v1/messages/count_tokens', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${deployKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'gateway-health-check', messages, ...extra }),
      }),
      env,
      {},
    );

  assert.equal((await countTokens([])).status, 200);
  assert.equal((await countTokens([{ role: 'user', content: 'not a health probe' }])).status, 403);
  assert.equal((await countTokens([], { system: 'not a health probe' })).status, 403);

  const generation = await worker.fetch(
    new Request('https://gateway.example.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${deployKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'Code-Max', messages: [{ role: 'user', content: 'no' }] }),
    }),
    env,
    {},
  );
  assert.equal(generation.status, 401);

  const reusedEnv = makeEnv({
    AIG_DEPLOY_HEALTH_KEY: deployKey,
    AIG_ACCESS_KEY_AGENT: deployKey,
    AIG_ACCESS_MODELS_AGENT: '*',
  });
  const reusedGeneration = await worker.fetch(
    new Request('https://gateway.example.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${deployKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'Code-Max', messages: [{ role: 'user', content: 'no' }] }),
    }),
    reusedEnv,
    {},
  );
  assert.equal(reusedGeneration.status, 401);
});
