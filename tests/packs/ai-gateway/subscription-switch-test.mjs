// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// AIG-003: AIG_ENABLE_SUBSCRIPTION=false removes subscription proxying entirely.

import { assert, beforeEach, test } from '#kit/harness.mjs';
import worker from '#target/src/index.ts';
import { AIR_KEY, makeEnv, resetCaches } from './hardening-fixtures.mjs';

beforeEach(resetCaches);

const health = async (env) => {
  const res = await worker.fetch(new Request('https://gateway.example.com/health', { headers: { authorization: `Bearer ${AIR_KEY}` } }), env, {});
  return res.json();
};
const nodeIds = (body) => (body.endpoints ?? body.nodes ?? []).map((node) => node.id);

test('subscription nodes load by default', async () => {
  const body = await health(makeEnv());
  assert.ok(nodeIds(body).includes('sub1'), JSON.stringify(body).slice(0, 400));
});

test('with the switch off no subscription node is loaded and the rest stays ready', async () => {
  const body = await health(makeEnv({ AIG_ENABLE_SUBSCRIPTION: 'false' }));
  assert.ok(!nodeIds(body).includes('sub1'));
  assert.ok(nodeIds(body).includes('static1'));
  assert.equal(body.status, 'ready');
});

test('with the switch off every OAuth route is a 404', async () => {
  const env = makeEnv({ AIG_ENABLE_SUBSCRIPTION: 'false' });
  for (const [method, path] of [
    ['GET', '/oauth/start?provider=mock&node=sub1'],
    ['POST', '/oauth/start'],
    ['GET', '/oauth/paste?state=s'],
    ['GET', '/oauth/callback/mock?code=c&state=s'],
  ]) {
    const res = await worker.fetch(new Request(`https://gateway.example.com${path}`, { method }), env, {});
    assert.equal(res.status, 404, `${method} ${path}`);
  }
});

test('the switch accepts the usual false spellings only', async () => {
  for (const value of ['false', '0', 'no', 'off']) {
    const res = await worker.fetch(new Request('https://gateway.example.com/oauth/start'), makeEnv({ AIG_ENABLE_SUBSCRIPTION: value }), {});
    assert.equal(res.status, 404, value);
  }
  const on = await worker.fetch(new Request('https://gateway.example.com/oauth/start'), makeEnv({ AIG_ENABLE_SUBSCRIPTION: 'true' }), {});
  assert.notEqual(on.status, 404);
});
