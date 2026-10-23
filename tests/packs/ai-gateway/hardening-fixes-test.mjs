// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Regression tests for the hardening fixes: failed-authorization throttle, streamed edge-cache
// hit accounting, fail-closed edge-cache scope, worst-case body budget, buffered usage writes,
// and the single-decode request body reader.

import { assert, test } from '#kit/harness.mjs';
import { createMockD1 } from '#kit/mock-d1-database.mjs';
import { getLimits } from '#target/src/config/timeouts.ts';
import { gatewayStats, trackClientResponse } from '#target/src/observability/gateway-stats.ts';
import { flushUsageBuffer, normalizeHour, persistTokenUsage, __resetUsageBufferForTests } from '#target/src/observability/token-usage-store.ts';
import { BodyTooLargeError, readBodyTextWithLimit } from '#target/src/protocol/http.ts';
import { __resetKeyRpmForTests, admitAuthAttempt, clearAuthFailures, recordAuthFailure } from '#target/src/ratelimit/key-rpm.ts';
import { __resetBodyBudgetForTests, admitRequestBody } from '#target/src/ratelimit/body-budget.ts';
import { buildEdgeCacheKeyRequest, callerCacheScope, matchEdgeCache, resolveEdgeCachePlan } from '#target/src/request/edge-cache.ts';
import worker from '#target/src/index.ts';
import { AIR_KEY, makeEnv } from './hardening-fixtures.mjs';

const MB = 1024 * 1024;
const H0 = Date.UTC(2026, 8, 15, 12);
const body = { temperature: 0, messages: [{ role: 'user', content: 'hi' }] };
const ENV = { AIG_TOKEN_ENCRYPTION_KEY: 'k'.repeat(32) };

function req(headers = {}) {
  return new Request('https://gateway.example.com/v1/chat/completions', { method: 'POST', headers });
}

// ---- failed-authorization throttle (FIX-1) ----

test('admitAuthAttempt refuses once the cap of recorded failures is reached, with retry-after from the oldest failure', () => {
  __resetKeyRpmForTests();
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) recordAuthFailure('fp', t0 + i * 1000);
  assert.deepEqual(admitAuthAttempt('fp', 3, t0 + 3000), { ok: false, retryAfterSec: 57 });
  assert.deepEqual(admitAuthAttempt('fp', 3, t0 + 59_999), { ok: false, retryAfterSec: 1 });
});

test('the failure window slides: a slot frees once its failure is 60 seconds old', () => {
  __resetKeyRpmForTests();
  const t0 = 2_000_000;
  for (let i = 0; i < 3; i++) recordAuthFailure('fp', t0 + i * 1000);
  assert.deepEqual(admitAuthAttempt('fp', 3, t0 + 60_000), { ok: false, retryAfterSec: 1 }, 'the failure at t0 still counts at exactly 60s');
  assert.equal(admitAuthAttempt('fp', 3, t0 + 60_001).ok, true, 'it leaves the window one millisecond later');
});

test('admitAuthAttempt is a check only: admitted attempts consume no budget until they fail', () => {
  __resetKeyRpmForTests();
  for (let i = 0; i < 10; i++) assert.equal(admitAuthAttempt('fp', 3, 5_000).ok, true);
  recordAuthFailure('fp', 5_000);
  recordAuthFailure('fp', 5_000);
  assert.equal(admitAuthAttempt('fp', 3, 5_000).ok, true, 'two failures leave one slot under a cap of three');
});

test('a successful authorization clears the fingerprint failure window', () => {
  __resetKeyRpmForTests();
  for (let i = 0; i < 5; i++) recordAuthFailure('valid', 9_000);
  assert.equal(admitAuthAttempt('valid', 5, 9_000).ok, false);
  clearAuthFailures('valid');
  assert.equal(admitAuthAttempt('valid', 5, 9_000).ok, true);
});

test('fingerprints keep independent windows and a cap of zero disables the throttle', () => {
  __resetKeyRpmForTests();
  for (let i = 0; i < 3; i++) recordAuthFailure('ANON', 1_000);
  assert.equal(admitAuthAttempt('ANON', 3, 1_000).ok, false);
  assert.equal(admitAuthAttempt('other-credential', 3, 1_000).ok, true);
  assert.equal(admitAuthAttempt('ANON', 0, 1_000).ok, true);
});

test('anonymous floods get 429 gateway_auth_throttled from the 61st attempt, while a valid key still works', async () => {
  __resetKeyRpmForTests();
  const env = makeEnv();
  const anonymous = () =>
    worker.fetch(new Request('https://gateway.example.com/v1/chat/completions', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }), env, {
      waitUntil() {},
    });
  for (let i = 0; i < 60; i++) assert.equal((await anonymous()).status, 401, `attempt ${i + 1} is an ordinary 401`);
  const throttled = await anonymous();
  assert.equal(throttled.status, 429);
  assert.match(throttled.headers.get('retry-after') || '', /^\d+$/);
  assert.equal((await throttled.json()).error.code, 'gateway_auth_throttled');

  const valid = await worker.fetch(new Request('https://gateway.example.com/v1/models', { headers: { authorization: `Bearer ${AIR_KEY}` } }), env, {
    waitUntil() {},
  });
  assert.equal(valid.status, 200, 'a valid key is not affected by the failed-attempt window');
  __resetKeyRpmForTests();
});

test('the gateway key RPM defaults to 120 and the attempt throttle to 60; an explicit 0 disables the RPM cap', () => {
  assert.equal(getLimits({}).gatewayKeyRpm, 120);
  assert.equal(getLimits({}).authAttemptRpm, 60);
  assert.equal(getLimits({ AIG_ACCESS_KEY_RPM: '0' }).gatewayKeyRpm, 0);
});

// ---- streamed edge-cache hit accounting (FIX-2) ----

// Serves `cached()` as the edge-cache entry for the duration of `run`.
function cachedHitTest(name, cached, run) {
  test(name, async () => {
    const previous = globalThis.caches;
    globalThis.caches = { default: { match: async () => cached(), put: async () => {} } };
    try {
      await run();
    } finally {
      globalThis.caches = previous;
    }
  });
}

async function hitFor() {
  const keyRequest = await buildEdgeCacheKeyRequest('openai_chat', 'Code-Max', body, 'AIR', { stream: true, scope: 'x' });
  return matchEdgeCache(keyRequest, req(), ENV);
}

cachedHitTest(
  'a streamed edge-cache hit on a counted route settles activeRequests and counts one success once read',
  () => new Response('data: {"a":1}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  async () => {
    const activeBefore = gatewayStats.activeRequests;
    const successesBefore = gatewayStats.successes;
    gatewayStats.activeRequests += 1;
    const response = trackClientResponse(await hitFor());
    assert.equal(response.headers.get('x-gateway-internal-synthetic-stream'), null, 'the internal marker is stripped');
    assert.equal(await response.text(), 'data: {"a":1}\n\ndata: [DONE]\n\n');
    assert.equal(gatewayStats.activeRequests, activeBefore, 'activeRequests returns to its baseline');
    assert.equal(gatewayStats.successes, successesBefore + 1);
  },
);

cachedHitTest(
  'a streamed edge-cache hit that the client cancels is counted as a cancellation',
  () => new Response('data: {"a":1}\n\ndata: {"a":2}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  async () => {
    const activeBefore = gatewayStats.activeRequests;
    const cancellationsBefore = gatewayStats.cancellations;
    gatewayStats.activeRequests += 1;
    const response = trackClientResponse(await hitFor());
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    assert.equal(gatewayStats.activeRequests, activeBefore);
    assert.equal(gatewayStats.cancellations, cancellationsBefore + 1);
  },
);

cachedHitTest(
  'a non-streamed edge-cache hit still settles immediately and counts one success',
  () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
  async () => {
    const activeBefore = gatewayStats.activeRequests;
    const successesBefore = gatewayStats.successes;
    gatewayStats.activeRequests += 1;
    const response = trackClientResponse(await hitFor());
    assert.equal(await response.text(), '{"ok":true}');
    assert.equal(gatewayStats.activeRequests, activeBefore);
    assert.equal(gatewayStats.successes, successesBefore + 1);
  },
);

// ---- fail-closed edge-cache scope (FIX-7) ----

test('without AIG_TOKEN_ENCRYPTION_KEY the edge cache is disabled even when the caller opts in', async () => {
  assert.equal(await callerCacheScope(req({ authorization: 'Bearer secret-a' }), {}), null);
  const plan = await resolveEdgeCachePlan(
    'openai_chat',
    'Code-Max',
    body,
    req({ authorization: 'Bearer secret-a', 'x-gateway-cache': 'true' }),
    {},
    'AIR',
    false,
  );
  assert.equal(plan, null, 'no plan means no cache lookup or store');
});

// ---- worst-case body budget (FIX-3) ----

test('requests without a usable Content-Length are charged the worst case and released back', () => {
  __resetBodyBudgetForTests();
  const first = admitRequestBody(NaN, 12 * MB);
  const second = admitRequestBody(0, 12 * MB);
  const third = admitRequestBody(-1, 12 * MB);
  assert.ok(first && second, 'two 12 MB worst cases fit in 32 MB');
  assert.equal(third, null, 'a third 12 MB worst case (36 MB) is refused');
  first();
  assert.ok(admitRequestBody(0, 12 * MB), 'the budget is returned on release');
  __resetBodyBudgetForTests();
});

test('with maxBodyBytes at 20 MB two bodies without Content-Length exceed the 32 MB budget', () => {
  __resetBodyBudgetForTests();
  const first = admitRequestBody(0, 20 * MB);
  assert.ok(first, 'the first 20 MB worst case is admitted when nothing else is in flight');
  assert.equal(admitRequestBody(0, 20 * MB), null, '20 + 20 MB exceeds 32 MB');
  first();
  __resetBodyBudgetForTests();
});

test('a declared Content-Length is charged as declared and is unaffected by the worst case', () => {
  __resetBodyBudgetForTests();
  const releases = [admitRequestBody(10 * MB, 20 * MB), admitRequestBody(10 * MB, 20 * MB), admitRequestBody(10 * MB, 20 * MB)];
  assert.ok(releases.every(Boolean), 'three 10 MB declared bodies (30 MB) fit');
  assert.equal(admitRequestBody(10 * MB, 20 * MB), null, 'a fourth would reach 40 MB');
  for (const release of releases) release();
  __resetBodyBudgetForTests();
});

// ---- buffered usage writes (FIX-4) ----

test('100 recorded events flush in at most three D1 batches and merge into one row per hour and model', async () => {
  __resetUsageBufferForTests();
  const d1 = createMockD1();
  let batches = 0;
  const batchOf = d1.batch.bind(d1);
  d1.batch = async (statements) => {
    batches += 1;
    return batchOf(statements);
  };
  const env = { TOKEN_STATS_DB: d1 };
  for (let i = 0; i < 100; i++) await persistTokenUsage(env, { prompt_tokens: 1, completion_tokens: 1 }, H0, 'Code-Max');
  await flushUsageBuffer();
  assert.ok(batches <= 3, `at most three D1 batches for 100 events; saw ${batches}`);
  const hourly = d1._rows.get(normalizeHour(H0));
  assert.equal(hourly.requests, 100);
  assert.equal(hourly.total, 200);
  const model = d1._modelRows.get(`${normalizeHour(H0)}|code-max`);
  assert.equal(model.requests, 100);
  assert.equal(model.total, 200);
  __resetUsageBufferForTests();
});

// ---- single-decode request body reader (FIX-6) ----

test('a multi-byte body split across chunks decodes the same as one decode', async () => {
  const text = '中文 🎉 emoji 测试 '.repeat(4000);
  const bytes = new TextEncoder().encode(text);
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 7) chunks.push(bytes.slice(offset, offset + 7));
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const request = new Request('https://gateway.example.com/v1/chat/completions', { method: 'POST', body: stream, duplex: 'half' });
  assert.equal(await readBodyTextWithLimit(request, 10 * MB), text);
});

test('a body over the limit still throws BodyTooLargeError', async () => {
  const request = new Request('https://gateway.example.com/v1/chat/completions', { method: 'POST', body: 'x'.repeat(2048) });
  await assert.rejects(readBodyTextWithLimit(request, 1024), BodyTooLargeError);
});
