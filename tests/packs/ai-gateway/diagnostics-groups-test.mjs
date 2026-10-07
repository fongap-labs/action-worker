// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// AIG-005: AIG_DIAGNOSTICS_GROUPS narrows /health and /metrics to named key groups.

import { assert, beforeEach, test } from '#kit/harness.mjs';
import worker from '#target/src/index.ts';
import { AGENT_KEY, AIR_KEY, makeEnv, resetCaches } from './hardening-fixtures.mjs';

beforeEach(resetCaches);

const get = (path, key, env) =>
  worker.fetch(new Request(`https://gateway.example.com${path}`, { headers: { authorization: `Bearer ${key}` } }), env, {});

test('without the variable every valid key reads diagnostics', async () => {
  const env = makeEnv();
  for (const path of ['/health', '/metrics']) {
    assert.equal((await get(path, AIR_KEY, env)).status, 200, path);
    assert.equal((await get(path, AGENT_KEY, env)).status, 200, path);
  }
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
