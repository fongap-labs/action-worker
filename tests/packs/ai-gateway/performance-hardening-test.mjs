// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Regression tests for the hot-path performance and stability fixes: bounded body reads that report
// truncation, the oversized buffered reply stop, stale-while-revalidate session affinity, the
// pull-driven first-event guard, the streaming model-name rewrite, the isolate retry budget, the
// cached access-key digests and the 30s usage flush window.

import { assert, test } from '#kit/harness.mjs';
import { withMockFetch } from '#kit/fetch.mjs';
import { createMockD1 } from '#kit/mock-d1-database.mjs';
import { __resetAccessKeysCacheForTests } from '#target/src/config/access-keys.ts';
import worker from '#target/src/index.ts';
import { __resetUsageBufferForTests, flushUsageBuffer, persistTokenUsage } from '#target/src/observability/token-usage-store.ts';
import { MAX_BUFFERED_REPLY_BYTES, readBodyTextBounded, safeReadErrorBody } from '#target/src/protocol/http.ts';
import { __resetAllStateForTests } from '#target/src/reliability/node-state.ts';
import { RETRY_BUDGET_MIN, RetrySlot, __resetRetryBudgetForTests, isSpeculativeRetryAfter, snapshotRetryBudget } from '#target/src/reliability/retry-budget.ts';
import { __resetTier1StateForTests } from '#target/src/reliability/tier1-state.ts';
import { authorize } from '#target/src/request/auth.ts';
import { __resetTier1AffinityForTests, readTier1Affinity, snapshotTier1Affinity } from '#target/src/scheduler/tier1-affinity.ts';
import { ensureFirstSseEvent } from '#target/src/stream/guard.ts';
import { trackStreamResponse } from '#target/src/stream/track.ts';

const ACCESS_KEY = 'perf-access-key';
const enc = new TextEncoder();

function bytesResponse(chunks, headers = { 'content-type': 'application/json' }) {
  let i = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (i >= chunks.length) controller.close();
        else controller.enqueue(chunks[i++]);
      },
    }),
    { status: 200, headers },
  );
}

function resetGatewayState() {
  __resetAllStateForTests();
  __resetTier1StateForTests();
  __resetTier1AffinityForTests();
  __resetRetryBudgetForTests();
  __resetAccessKeysCacheForTests();
}

const node = (id) => ({ id, provider: 'openai', base_url: `https://${id}.example.com/v1`, models: { 'code-max': 'up-model' } });

function makeEnv(ids, extra = {}) {
  return {
    AIG_ACCESS_KEY_AIR: ACCESS_KEY,
    AIG_ACCESS_MODELS_AIR: '*',
    TIER1_SCHEDULER_SEED: 'performance-hardening-test',
    AIG_TIER1_NODES_01: JSON.stringify(ids.map(node)),
    AIG_TIER1_CREDENTIALS_01: JSON.stringify(Object.fromEntries(ids.map((id) => [id, `key-${id}`]))),
    ...extra,
  };
}

// Real clients send Content-Length; without it the body budget charges the worst case
// and concurrent requests would be serialized, which is not what these tests are about.
function chatRequest(body = { model: 'code-max', messages: [{ role: 'user', content: 'hi' }] }) {
  const text = JSON.stringify(body);
  return new Request('https://gateway.example.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(enc.encode(text).byteLength), authorization: `Bearer ${ACCESS_KEY}` },
    body: text,
  });
}

const completion = (content) => ({
  id: 'c1',
  object: 'chat.completion',
  model: 'up-model',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

// ---- bounded body reads --------------------------------------------------------

test('readBodyTextBounded reports truncation only when bytes were left behind', async () => {
  const exact = await readBodyTextBounded(bytesResponse([enc.encode('abcd'), enc.encode('efgh')]), 8);
  assert.deepEqual(exact, { text: 'abcdefgh', truncated: false });
  const over = await readBodyTextBounded(bytesResponse([enc.encode('abcd'), enc.encode('efghi')]), 8);
  assert.deepEqual(over, { text: 'abcdefgh', truncated: true });
  assert.equal(await safeReadErrorBody(bytesResponse([enc.encode('abcdefghij')]), 4), 'abcd');
});

// ---- oversized buffered reply ---------------------------------------------------

test('a buffered reply over the limit ends the request instead of regenerating it on another node', async () => {
  resetGatewayState();
  const calls = [];
  const huge = JSON.stringify(completion('x'.repeat(MAX_BUFFERED_REPLY_BYTES + 1024)));
  const env = makeEnv(['big-a', 'big-b']);
  const response = await withMockFetch(
    async (input) => {
      calls.push(new URL(typeof input === 'string' ? input : input.url).hostname);
      return new Response(huge, { status: 200, headers: { 'content-type': 'application/json' } });
    },
    () => worker.fetch(chatRequest(), env, { waitUntil() {} }),
  );
  assert.equal(response.status, 502);
  assert.equal(calls.length, 1, 'the oversized reply is not retried on the second node');
  assert.match(await response.text(), /stream:true/);
});

test('a reply under the limit is still delivered', async () => {
  resetGatewayState();
  const env = makeEnv(['small-a']);
  const response = await withMockFetch(
    async () => new Response(JSON.stringify(completion('hello')), { status: 200, headers: { 'content-type': 'application/json' } }),
    () => worker.fetch(chatRequest(), env, { waitUntil() {} }),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'hello');
});

// ---- session affinity: stale-while-revalidate ----------------------------------

test('a known affinity binding is served at once when stale, and refreshed once in the background', async () => {
  __resetTier1AffinityForTests();
  let gets = 0;
  let hang = false;
  const kv = {
    get: async () => {
      gets++;
      if (hang) return new Promise(() => {});
      return 'node-a';
    },
    put: async () => {},
  };
  const env = { TIER1_AFFINITY: kv };
  const realNow = Date.now;
  const t0 = realNow();
  const background = [];
  const ctx = { waitUntil: (p) => background.push(p) };
  try {
    Date.now = () => t0;
    assert.equal(await readTier1Affinity(env, 'session-0123456789', ctx), 'node-a');
    assert.equal(gets, 1);
    Date.now = () => t0 + 1_000;
    assert.equal(await readTier1Affinity(env, 'session-0123456789', ctx), 'node-a');
    assert.equal(gets, 1, 'fresh binding: no KV read');
    Date.now = () => t0 + 20_000;
    hang = true;
    const started = realNow();
    const answers = await Promise.all([1, 2, 3].map(() => readTier1Affinity(env, 'session-0123456789', ctx)));
    assert.deepEqual(answers, ['node-a', 'node-a', 'node-a']);
    assert.ok(realNow() - started < 40, 'a stale binding never waits for KV');
    assert.equal(gets, 2, 'concurrent requests share one background refresh');
    assert.equal(background.length, 1);
    assert.equal(snapshotTier1Affinity(env).staleServes, 1);
  } finally {
    Date.now = realNow;
  }
});

test('an unknown binding still waits for KV, but only up to the read timeout', async () => {
  __resetTier1AffinityForTests();
  const env = { TIER1_AFFINITY: { get: () => new Promise(() => {}), put: async () => {} } };
  const started = Date.now();
  assert.equal(await readTier1Affinity(env, 'session-abcdefghij', { waitUntil() {} }), undefined);
  assert.ok(Date.now() - started < 500);
  assert.equal(snapshotTier1Affinity(env).timeouts, 1);
});

// ---- first-event guard back pressure ---------------------------------------------

test('the first-event guard reads the upstream only as fast as the client drains it', async () => {
  let pulled = 0;
  const total = 500;
  const upstream = new Response(
    new ReadableStream({
      pull(controller) {
        if (pulled >= total) {
          controller.close();
          return;
        }
        controller.enqueue(enc.encode(`data: {"choices":[{"delta":{"content":"t${pulled++}"}}]}\n\n`));
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  const guarded = await ensureFirstSseEvent(upstream, 5_000, null, undefined);
  const reader = guarded.body.getReader();
  await reader.read();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(pulled < 20, `an idle client must not make the guard drain the upstream (pulled ${pulled} of ${total})`);
  await reader.cancel();
});

// ---- streaming model-name rewrite ---------------------------------------------------

function sseChunks(lines, size) {
  const bytes = enc.encode(lines.join(''));
  const out = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}

async function relay(lines, size, rewriteModel) {
  const source = bytesResponse(sseChunks(lines, size), { 'content-type': 'text/event-stream' });
  const tracked = trackStreamResponse(source, {
    idleTimeoutMs: 5_000,
    completionMarker: /data:\s*\[DONE\]/,
    closeMarker: /data:\s*\[DONE\]\s*(?:\r?\n|$)/,
    rewriteModel,
    onSuccess() {},
    onFailure() {},
    onNeutral() {},
  });
  return tracked.text();
}

test('every streamed chunk is rewritten to the logical model name, however the bytes are split', async () => {
  const lines = [];
  for (let i = 0; i < 25; i++) {
    lines.push(`data: ${JSON.stringify({ id: 'c', model: 'glm-4.6', choices: [{ delta: { content: `héllo "model":"glm-4.6" 你好 ${i}` } }] })}\n\n`);
  }
  lines.push('data: [DONE]\n\n');
  for (const size of [1, 7, 64, 4096]) {
    const text = await relay(lines, size, 'Code-Max');
    const events = text.split('\n').filter((line) => line.startsWith('data:') && !line.includes('[DONE]'));
    assert.equal(events.length, 25);
    for (const [index, line] of events.entries()) {
      const json = JSON.parse(line.slice(5));
      assert.equal(json.model, 'Code-Max', `chunk ${index} at split size ${size}`);
      assert.match(json.choices[0].delta.content, /"model":"glm-4.6"/, 'text that merely quotes the model name is left alone');
    }
  }
});

test('a chunk whose upstream model name changes mid-stream is still rewritten', async () => {
  const lines = [
    `data: ${JSON.stringify({ model: 'glm-4.6', choices: [{ delta: { content: 'a' } }] })}\n\n`,
    `data: ${JSON.stringify({ model: 'glm-4.6-0414', choices: [{ delta: { content: 'b' } }] })}\n\n`,
    `data: ${JSON.stringify({ model: 'glm-4.6', choices: [{ delta: { content: 'c' } }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const text = await relay(lines, 50, 'Code-Max');
  const models = text
    .split('\n')
    .filter((line) => line.startsWith('data:') && !line.includes('[DONE]'))
    .map((line) => JSON.parse(line.slice(5)).model);
  assert.deepEqual(models, ['Code-Max', 'Code-Max', 'Code-Max']);
});

// ---- retry budget -----------------------------------------------------------------

test('retry slots: a small deployment is never shed, a crowd is limited to a share of its requests', () => {
  __resetRetryBudgetForTests();
  const few = Array.from({ length: RETRY_BUDGET_MIN }, () => new RetrySlot());
  assert.ok(few.every((slot) => slot.tryAcquire()), 'up to the minimum, every request may retry');
  const extra = new RetrySlot();
  assert.equal(extra.tryAcquire(), false, 'with only a few requests the minimum is the whole budget');
  assert.equal(snapshotRetryBudget().denied, 1);
  few[0].end();
  assert.equal(extra.tryAcquire(), true, 'a finished request frees its slot');
  assert.equal(extra.tryAcquire(), true, 'acquiring again is idempotent');
  for (const slot of [...few.slice(1), extra]) slot.end();
  assert.deepEqual({ ...snapshotRetryBudget(), denied: 0 }, { active: 0, retrying: 0, denied: 0 });

  const crowd = Array.from({ length: 50 }, () => new RetrySlot());
  const admitted = crowd.filter((slot) => slot.tryAcquire()).length;
  assert.equal(admitted, 10, '20% of 50 concurrent requests');
  for (const slot of crowd) slot.end();
});

test('only failures of a slow or broken upstream make the next attempt speculative', () => {
  for (const kind of ['server', 'network', 'headers_timeout', 'first_event_timeout', 'stream_interrupted']) assert.equal(isSpeculativeRetryAfter(kind), true, kind);
  for (const kind of ['rate_limit', 'auth', 'client', 'model_missing', 'endpoint_not_found', 'client_abort']) assert.equal(isSpeculativeRetryAfter(kind), false, kind);
});

test('an upstream outage does not send every concurrent request through the whole pool', async () => {
  resetGatewayState();
  const ids = ['out-a', 'out-b', 'out-c'];
  const env = makeEnv(ids);
  let calls = 0;
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const responses = await withMockFetch(
    async () => {
      calls++;
      await gate;
      // Failing upstreams take time to fail, so retries of different requests overlap.
      await new Promise((resolve) => setTimeout(resolve, 25));
      return new Response('{"error":{"message":"upstream down"}}', { status: 500, headers: { 'content-type': 'application/json' } });
    },
    async () => {
      const pending = Array.from({ length: 12 }, () => worker.fetch(chatRequest(), env, { waitUntil() {} }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      open();
      return Promise.all(pending);
    },
  );
  assert.ok(responses.every((response) => response.status >= 500), 'the outage is reported, not hidden');
  assert.ok(snapshotRetryBudget().denied > 0, 'some retries were refused');
  assert.ok(calls < 12 * ids.length, `the pool was not hammered by every request (calls=${calls})`);
  assert.deepEqual({ active: snapshotRetryBudget().active, retrying: snapshotRetryBudget().retrying }, { active: 0, retrying: 0 }, 'slots are released');
});

test('rotating past a rate-limited key is ordinary pool behaviour and is never budgeted', async () => {
  resetGatewayState();
  const env = makeEnv(['rot-a', 'rot-b']);
  const responses = await withMockFetch(
    async (input) => {
      const host = new URL(typeof input === 'string' ? input : input.url).hostname;
      if (host.startsWith('rot-a')) return new Response('{"error":{"message":"rate limit"}}', { status: 429, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify(completion('ok')), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    () => Promise.all(Array.from({ length: 12 }, () => worker.fetch(chatRequest(), env, { waitUntil() {} }))),
  );
  assert.deepEqual(responses.map((response) => response.status), Array(12).fill(200));
  assert.equal(snapshotRetryBudget().denied, 0);
});

// ---- access-key digests --------------------------------------------------------------

test('cached key digests keep authorizing the right group and rejecting the wrong key', async () => {
  resetGatewayState();
  const env = {
    AIG_ACCESS_KEY_AIR: 'air-secret',
    AIG_ACCESS_MODELS_AIR: '*',
    AIG_ACCESS_KEY_MAX: 'max-secret',
    AIG_ACCESS_MODELS_MAX: '*',
  };
  const request = (key) => new Request('https://gateway.example.com/v1/models', { headers: { authorization: `Bearer ${key}` } });
  for (let i = 0; i < 3; i++) {
    assert.equal((await authorize(request('air-secret'), env)).group, 'AIR');
    assert.equal((await authorize(request('max-secret'), env)).group, 'MAX');
    assert.equal((await authorize(request('nope'), env)).authorized, false);
  }
});

// ---- usage flush window -----------------------------------------------------------------

test('usage events inside the flush window share one D1 batch', async () => {
  __resetUsageBufferForTests();
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  const t0 = Date.UTC(2026, 8, 15, 12);
  await persistTokenUsage(env, { prompt_tokens: 1, completion_tokens: 1 }, t0, 'm');
  const afterFirst = d1._writes.length;
  assert.ok(afterFirst > 0, 'the first event is written at once');
  for (let i = 0; i < 20; i++) await persistTokenUsage(env, { prompt_tokens: 1, completion_tokens: 1 }, t0 + i, 'm');
  assert.equal(d1._writes.length, afterFirst, 'later events inside the window stay buffered');
  await flushUsageBuffer();
  assert.ok(d1._writes.length > afterFirst, 'a forced flush writes the merged increments');
});
