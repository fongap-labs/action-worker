// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// AIG-006: AIG_PUBLIC_DASHBOARD=false removes the public dashboard and status badge.

import { assert, beforeEach, test } from '#kit/harness.mjs';
import worker from '#target/src/index.ts';
import { AIR_KEY, makeEnv, resetCaches } from './hardening-fixtures.mjs';

beforeEach(resetCaches);

const page = (env) => worker.fetch(new Request('https://gateway.example.com/', { headers: { accept: 'text/html' } }), env, {});
const badge = (env) => worker.fetch(new Request('https://gateway.example.com/readme-status.svg'), env, {});

test('the dashboard and badge are public by default', async () => {
  assert.equal((await page(makeEnv())).status, 200);
  assert.equal((await badge(makeEnv())).status, 200);
});

test('with the switch off both answer 404', async () => {
  const env = makeEnv({ AIG_PUBLIC_DASHBOARD: 'false' });
  assert.equal((await page(env)).status, 404);
  assert.equal((await badge(env)).status, 404);
});

test('the API keeps working with the dashboard off', async () => {
  const env = makeEnv({ AIG_PUBLIC_DASHBOARD: 'false' });
  const res = await worker.fetch(
    new Request('https://gateway.example.com/v1/models', { headers: { authorization: `Bearer ${AIR_KEY}` } }),
    env,
    {},
  );
  assert.equal(res.status, 200);
});
