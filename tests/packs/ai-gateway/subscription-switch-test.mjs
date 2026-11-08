// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// AIG-003: AIG_IS_SUBSCRIPTION_ENABLED=false removes subscription proxying entirely.

import { assert, beforeEach, test } from '#kit/harness.mjs';
import worker from '#target/src/index.ts';
import { MAX_KEY, makeEnv, resetCaches } from './hardening-fixtures.mjs';

beforeEach(resetCaches);

// Only Gateway metadata and management endpoints are tested here.
function guardedCenterEnv(extra = {}) {
  const env = makeEnv({ ...extra, AIG_INFERENCE_ACTIVE: 'true' });
  delete env.AIG_TIER1_CREDENTIALS_01;
  let centerCalls = 0;
  env.AIG_INFERENCE_SERVICE = {
    fetch: async () => {
      centerCalls++;
      return new Response('unexpected inference dispatch', { status: 503 });
    },
  };
  return { env, getCenterCalls: () => centerCalls };
}



const health = async (env) => {
  const res = await worker.fetch(new Request('https://gateway.example.com/health', { headers: { authorization: `Bearer ${MAX_KEY}` } }), env, {});
  return res.json();
};
const nodeIds = (body) => (body.endpoints ?? body.nodes ?? []).map((node) => node.id);

test('subscription nodes load by default', async () => {
  const guard = guardedCenterEnv();
  const body = await health(guard.env);
  assert.ok(nodeIds(body).includes('sub1'), JSON.stringify(body).slice(0, 400));
  assert.equal(guard.getCenterCalls(), 0);
});

test('with the switch off no subscription node is loaded and the rest stays ready', async () => {
  const guard = guardedCenterEnv({ AIG_IS_SUBSCRIPTION_ENABLED: 'false' });
  const body = await health(guard.env);
  assert.ok(!nodeIds(body).includes('sub1'));
  assert.ok(nodeIds(body).includes('static1'));
  assert.equal(body.status, 'ready');
  assert.equal(guard.getCenterCalls(), 0);
});

test('with the switch off every OAuth route is a 404', async () => {
  const guard = guardedCenterEnv({ AIG_IS_SUBSCRIPTION_ENABLED: 'false' });
  for (const [method, path] of [
    ['GET', '/oauth/start?provider=mock&node=sub1'],
    ['POST', '/oauth/start'],
    ['GET', '/oauth/paste?state=s'],
    ['GET', '/oauth/callback/mock?code=c&state=s'],
  ]) {
    const res = await worker.fetch(new Request(`https://gateway.example.com${path}`, { method }), guard.env, {});
    assert.equal(res.status, 404, `${method} ${path}`);
  }
  assert.equal(guard.getCenterCalls(), 0, 'disabled OAuth management endpoints must not dispatch inference');
});

test('the switch accepts the usual false spellings only', async () => {
  for (const value of ['false', '0', 'no', 'off']) {
    const guard = guardedCenterEnv({ AIG_IS_SUBSCRIPTION_ENABLED: value });
    const res = await worker.fetch(new Request('https://gateway.example.com/oauth/start'), guard.env, {});
    assert.equal(res.status, 404, value);
    assert.equal(guard.getCenterCalls(), 0);
  }
  const enabled = guardedCenterEnv({ AIG_IS_SUBSCRIPTION_ENABLED: 'true' });
  const on = await worker.fetch(new Request('https://gateway.example.com/oauth/start'), enabled.env, {});
  assert.notEqual(on.status, 404);
  assert.equal(enabled.getCenterCalls(), 0);
});
