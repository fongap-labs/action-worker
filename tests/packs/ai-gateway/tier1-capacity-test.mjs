// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Tier 1 capacity retention: a Tier 1 key or model is taken out of the pool only
// on evidence that it cannot serve, and a Tier 1-only deployment keeps serving
// through request-local and transient failures.

import { assert, beforeEach, test } from '#kit/harness.mjs';
import { withMockFetch } from '#kit/fetch.mjs';
import { __resetAccessKeysCacheForTests } from '#target/src/config/access-keys.ts';
import { __resetBodyBudgetForTests } from '#target/src/ratelimit/body-budget.ts';
import { loadGatewayConfig } from '#target/src/config/nodes.ts';
import worker from '#target/src/index.ts';
import { __resetAdaptive429StateForTests } from '#target/src/reliability/adaptive-429.ts';
import { classifyUpstreamStatus } from '#target/src/reliability/classify.ts';
import {
  __resetTier1StateForTests,
  applyTier1Outcome,
  classifyTier1Failure,
  isTier1Eligible,
  recordTier1Success,
  recordTier1Ttft,
  releaseTier1Slot,
} from '#target/src/reliability/tier1-state.ts';
import { __resetSharedTier1CooldownsForTests, hydrateSharedTier1Cooldowns, shareLongTier1Cooldowns } from '#target/src/reliability/tier1-shared-cooldowns.ts';
import { __resetTier1AffinityForTests, resolveTier1SessionId } from '#target/src/scheduler/tier1-affinity.ts';
import { buildWranglerConfig, loadRuntimeConfig, preflight, validateGatewayRuntime } from '#target/scripts/github-deployment-config.mjs';
import { pickTier1Candidate } from '#target/src/scheduler/tier1-scheduler.ts';

const ACCESS_KEY = 'tier1-capacity-key';
const AUTH_COOLDOWN_MS = 3_600_000;
const REQ = { protocol: 'openai', surface: 'chat_completions', model: 'm1', bodyChars: 10 };

beforeEach(() => {
  __resetAccessKeysCacheForTests();
  __resetBodyBudgetForTests();
  __resetSharedTier1CooldownsForTests();
  __resetTier1StateForTests();
  __resetTier1AffinityForTests();
  __resetAdaptive429StateForTests();
});

function tier1Node(id, models = { m1: 'up-1', m2: 'up-2' }) {
  return { id, tier: 'tier-1', provider: 'mock', protocol: 'openai', surfaces: ['chat_completions'], baseUrl: 'https://x', credential: 'k', priority: 100, models };
}

function tier1OnlyEnv(nodeIds, extra = {}) {
  const nodes = nodeIds.map((id) => ({ id, provider: 'mock', base_url: `https://${id}.example.com/v1`, models: { 'Code-Pro': 'up-model' } }));
  return {
    AIG_ACCESS_KEY_PRO: ACCESS_KEY,
    AIG_ACCESS_MODELS_PRO: '*',
    AIG_TIER1_NODES_01: JSON.stringify(nodes),
    AIG_TIER1_CREDENTIALS_01: JSON.stringify(Object.fromEntries(nodeIds.map((id) => [id, `secret-${id}`]))),
    AIG_LOG_LEVEL: 'none',
    ...extra,
  };
}

const okChat = () =>
  new Response(
    JSON.stringify({
      id: 'c1',
      object: 'chat.completion',
      model: 'up-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const errorResponse = (status, message, headers = {}) =>
  new Response(JSON.stringify({ error: { message } }), { status, headers: { 'content-type': 'application/json', ...headers } });

const chat = (env, body = {}) =>
  worker.fetch(
    new Request('https://gateway.example.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${ACCESS_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'Code-Pro', messages: [{ role: 'user', content: 'hi' }], ...body }),
    }),
    env,
    { waitUntil() {} },
  );

// Answers upstream calls from a script of responses and records the host of each call.
function scriptedUpstream(script) {
  const hosts = [];
  const handler = async (input) => {
    hosts.push(new URL(typeof input === 'string' ? input : input.url).hostname.split('.')[0]);
    const next = script.shift();
    return next ? next() : okChat();
  };
  return { hosts, handler };
}

// ---- 401 versus 403 ---------------------------------------------------------

test('a 401 says the credential was rejected; a 403 says this request was refused', () => {
  assert.equal(classifyUpstreamStatus(401, new Headers(), {}).forbidden, undefined);
  const forbidden = classifyUpstreamStatus(403, new Headers(), {});
  assert.equal(forbidden.kind, 'auth');
  assert.equal(forbidden.forbidden, true);
});

test('a Tier 1 401 still cools the whole key for the auth cooldown', () => {
  const now = 1_000_000;
  applyTier1Outcome('k1', 'm1', classifyTier1Failure(classifyUpstreamStatus(401, new Headers(), {})), now);
  assert.equal(isTier1Eligible(tier1Node('k1'), REQ, now + AUTH_COOLDOWN_MS - 1), false);
  assert.equal(isTier1Eligible(tier1Node('k1'), { ...REQ, model: 'm2' }, now + 1), false);
});

test('a first Tier 1 403 takes neither the key nor the model out of the pool', () => {
  const now = 1_000_000;
  applyTier1Outcome('k1', 'm1', classifyTier1Failure(classifyUpstreamStatus(403, new Headers(), {})), now);
  assert.equal(isTier1Eligible(tier1Node('k1'), REQ, now + 1), true);
  assert.equal(isTier1Eligible(tier1Node('k1'), { ...REQ, model: 'm2' }, now + 1), true);
});

test('repeated Tier 1 403s cool only that model, on a ladder up to the auth cooldown', () => {
  const forbidden = () => classifyTier1Failure(classifyUpstreamStatus(403, new Headers(), {}));
  let now = 1_000_000;
  const waits = [];
  for (let i = 0; i < 5; i++) {
    applyTier1Outcome('k1', 'm1', forbidden(), now);
    let wait = 0;
    while (!isTier1Eligible(tier1Node('k1'), REQ, now + wait)) wait += 1_000;
    waits.push(wait);
    assert.equal(isTier1Eligible(tier1Node('k1'), { ...REQ, model: 'm2' }, now + 1), true, 'sibling model stays in the pool');
    now += wait + 1;
  }
  assert.deepEqual(waits, [0, 60_000, 600_000, AUTH_COOLDOWN_MS, AUTH_COOLDOWN_MS]);
});

test('a Tier 1 success clears the 403 ladder of that model', () => {
  const forbidden = () => classifyTier1Failure(classifyUpstreamStatus(403, new Headers(), {}));
  const now = 1_000_000;
  applyTier1Outcome('k1', 'm1', forbidden(), now);
  recordTier1Success('k1', 'm1', now + 1);
  applyTier1Outcome('k1', 'm1', forbidden(), now + 2);
  assert.equal(isTier1Eligible(tier1Node('k1'), REQ, now + 3), true);
});

test('Tier 1-only single key: one refused request does not block the next one', async () => {
  const env = tier1OnlyEnv(['solo']);
  const upstream = scriptedUpstream([() => errorResponse(403, 'input flagged by moderation')]);
  await withMockFetch(upstream.handler, async () => {
    const refused = await chat(env);
    assert.equal(refused.status, 502);
    const next = await chat(env);
    assert.equal(next.status, 200);
  });
  assert.deepEqual(upstream.hosts, ['solo', 'solo']);
});

// ---- Half-open recovery on a shared key -------------------------------------

function tripModel(accountId, modelId, now) {
  for (let i = 0; i < 3; i++) applyTier1Outcome(accountId, modelId, classifyTier1Failure({ kind: 'server' }), now + i);
}

test('a tripped model gets its recovery probe while another model of the same key is busy', () => {
  const key = tier1Node('k1');
  const now = 1_000_000;
  tripModel('k1', 'm1', now);
  const busy = pickTier1Candidate([key], { ...REQ, model: 'm2' }, new Set(), { now: now + 10 });
  assert.ok(busy?.node, 'm2 request in flight');
  const later = now + 10 * 60_000;
  const probe = pickTier1Candidate([key], REQ, new Set(), { now: later });
  assert.equal(probe?.node?.id, 'k1', 'm1 probe admitted despite the m2 request in flight');
  assert.equal(pickTier1Candidate([key], REQ, new Set(), { now: later + 1 }), null, 'still one probe at a time');
  releaseTier1Slot('k1', probe.releaseToken);
  releaseTier1Slot('k1', busy.releaseToken);
});

// ---- Last-resort retry of a transient Tier 1 failure ------------------------

test('Tier 1-only single key: one transient 5xx is retried on the same key', async () => {
  const env = tier1OnlyEnv(['solo']);
  const upstream = scriptedUpstream([() => errorResponse(500, 'overloaded')]);
  const res = await withMockFetch(upstream.handler, () => chat(env));
  assert.equal(res.status, 200);
  assert.deepEqual(upstream.hosts, ['solo', 'solo']);
});

test('the same-key retry happens at most once per request', async () => {
  const env = tier1OnlyEnv(['solo']);
  const upstream = scriptedUpstream([() => errorResponse(500, 'overloaded'), () => errorResponse(502, 'bad gateway'), () => errorResponse(503, 'down')]);
  const res = await withMockFetch(upstream.handler, () => chat(env));
  assert.equal(res.status, 502);
  assert.deepEqual(upstream.hosts, ['solo', 'solo']);
});

test('a rate limit, refusal or invalid request is never retried on the same key', async () => {
  for (const failure of [
    () => errorResponse(429, 'rate limit', { 'retry-after': '20' }),
    () => errorResponse(403, 'forbidden'),
    () => errorResponse(400, 'unsupported parameter'),
  ]) {
    __resetTier1StateForTests();
    __resetAdaptive429StateForTests();
    const upstream = scriptedUpstream([failure]);
    const res = await withMockFetch(upstream.handler, () => chat(tier1OnlyEnv(['solo'])));
    assert.notEqual(res.status, 200);
    assert.deepEqual(upstream.hosts, ['solo']);
  }
});

test('with every key failing transiently, the unused attempt budget retries one key once', async () => {
  const env = tier1OnlyEnv(['k1', 'k2']);
  const upstream = scriptedUpstream([() => errorResponse(500, 'overloaded'), () => errorResponse(500, 'overloaded')]);
  const res = await withMockFetch(upstream.handler, () => chat(env));
  assert.equal(res.status, 200);
  assert.equal(upstream.hosts.length, 3);
  assert.equal(upstream.hosts[2], upstream.hosts[1], 'the most recent transient failure is retried');
});

// ---- A configuration error takes out only what it breaks ---------------------

const runtimeOf = (env) => ({
  vars: Object.fromEntries(Object.entries(env).filter(([k]) => !k.includes('CREDENTIALS') && !k.startsWith('AIG_ACCESS_KEY_'))),
  secrets: Object.fromEntries(Object.entries(env).filter(([k]) => k.includes('CREDENTIALS') || k.startsWith('AIG_ACCESS_KEY_'))),
});

test('a policy typo degrades the gateway instead of failing every request', async () => {
  const env = tier1OnlyEnv(['solo'], { AIG_POLICIES_CONFIG: JSON.stringify({ default: { max_attempt: 5 } }) });
  const config = loadGatewayConfig(env);
  assert.equal(config.status, 'degraded');
  assert.equal(config.ready, true);
  assert.equal(config.hasConfigErrors, true);
  assert.ok(config.diagnostics.some((d) => d.includes('max_attempt')));
  const upstream = scriptedUpstream([]);
  const res = await withMockFetch(upstream.handler, () => chat(env));
  assert.equal(res.status, 200);
});

test('a configuration error still blocks a deploy, even when reduced capacity is allowed', () => {
  const env = tier1OnlyEnv(['solo'], { AIG_POLICIES_CONFIG: JSON.stringify({ default: { max_attempt: 5 } }) });
  assert.throws(() => validateGatewayRuntime(runtimeOf(env), { allowDegraded: true }), /max_attempt/);
});

test('a node with a conflicting credential is excluded and the rest keep serving', async () => {
  const env = tier1OnlyEnv(['good', 'bad'], { AIG_TIER3_CREDENTIALS_01: JSON.stringify({ bad: 'other-secret' }) });
  const config = loadGatewayConfig(env);
  assert.equal(config.status, 'degraded');
  assert.deepEqual(
    config.nodes.map((n) => n.id),
    ['good'],
  );
  const upstream = scriptedUpstream([]);
  const res = await withMockFetch(upstream.handler, () => chat(env));
  assert.equal(res.status, 200);
  assert.deepEqual(upstream.hosts, ['good']);
});

test('an ambiguous duplicate node id excludes every copy of it', () => {
  const env = tier1OnlyEnv(['good', 'dup']);
  env.AIG_TIER1_NODES_02 = JSON.stringify([{ id: 'dup', provider: 'mock', base_url: 'https://elsewhere.example.com/v1', models: { 'Code-Pro': 'up-model' } }]);
  const config = loadGatewayConfig(env);
  assert.equal(config.status, 'degraded');
  assert.deepEqual(
    config.nodes.map((n) => n.id),
    ['good'],
  );
});

test('an unparseable node shard is reported as lost capacity', () => {
  const env = tier1OnlyEnv(['good'], { AIG_TIER1_NODES_02: '[{"id": broken' });
  const config = loadGatewayConfig(env);
  assert.equal(config.status, 'degraded');
  assert.equal(config.ready, true);
});

test('with no usable node the configuration is still invalid', () => {
  const env = tier1OnlyEnv(['bad'], { AIG_TIER3_CREDENTIALS_01: JSON.stringify({ bad: 'other-secret' }) });
  const config = loadGatewayConfig(env);
  assert.equal(config.status, 'invalid');
  assert.equal(config.ready, false);
});

// ---- Diagnostics never quote credential text --------------------------------

test('a malformed credential shard is reported without quoting any of its text', async () => {
  const secret = 'sk-live-SECRETVALUE123456';
  const env = tier1OnlyEnv(['good'], { AIG_TIER1_CREDENTIALS_02: `{"other": ${secret}}` });
  const config = loadGatewayConfig(env);
  assert.ok(config.diagnostics.some((d) => d.includes('AIG_TIER1_CREDENTIALS_02')));
  assert.ok(!config.diagnostics.join('\n').includes('sk-live'), 'no credential fragment in diagnostics');
  const health = await worker.fetch(
    new Request('https://gateway.example.com/health', { headers: { authorization: `Bearer ${ACCESS_KEY}` } }),
    env,
    {},
  );
  assert.ok(!(await health.text()).includes('sk-live'), 'no credential fragment on /health');
});

test('a malformed secrets document fails the deploy without quoting it', () => {
  assert.throws(
    () => loadRuntimeConfig('{"AIG_TIER1_NODES_01": "[]"}', '{"AIG_ACCESS_KEY_PRO": sk-live-SECRETVALUE123456}'),
    (error) => /not valid JSON/.test(error.message) && !error.message.includes('sk-live'),
  );
});

// ---- The affinity lookup never stalls a request -----------------------------

// Counts reads and writes of session-affinity keys only; the same namespace also
// holds the shared Tier 1 cooldowns.
function countingKv({ hang = false, fail = false } = {}) {
  const kv = { gets: 0, puts: 0 };
  const isAffinity = (key) => String(key).startsWith('affinity:');
  kv.get = async (key) => {
    if (!isAffinity(key)) return null;
    kv.gets++;
    if (fail) throw new Error('KV get() limit exceeded for the day.');
    return hang ? new Promise(() => {}) : null;
  };
  kv.put = async (key) => {
    if (isAffinity(key)) kv.puts++;
  };
  return kv;
}

const chatWithSession = (env, sessionId) =>
  worker.fetch(
    new Request('https://gateway.example.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${ACCESS_KEY}`, 'content-type': 'application/json', 'x-session-id': sessionId },
      body: JSON.stringify({ model: 'Code-Pro', messages: [{ role: 'user', content: 'hi' }] }),
    }),
    env,
    { waitUntil() {} },
  );

test('with a single Tier 1 key a session neither reads nor writes affinity', async () => {
  const kv = countingKv();
  const env = tier1OnlyEnv(['solo'], { TIER1_AFFINITY: kv });
  const res = await withMockFetch(scriptedUpstream([]).handler, () => chatWithSession(env, 'session-single-key'));
  assert.equal(res.status, 200);
  assert.equal(kv.gets, 0);
  assert.equal(kv.puts, 0);
});

test('a stalled affinity read does not hold the request and writes nothing', async () => {
  const kv = countingKv({ hang: true });
  const env = tier1OnlyEnv(['k1', 'k2'], { TIER1_AFFINITY: kv });
  const started = Date.now();
  const res = await withMockFetch(scriptedUpstream([]).handler, () =>
    Promise.race([chatWithSession(env, 'session-stalled-kv'), new Promise((resolve) => setTimeout(() => resolve({ status: 'stalled' }), 1_000))]),
  );
  assert.equal(res.status, 200);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(kv.gets, 1);
  assert.equal(kv.puts, 0, 'an unknown binding is not overwritten');
});

test('a failed affinity read neither biases nor rewrites the binding', async () => {
  const kv = countingKv({ fail: true });
  const env = tier1OnlyEnv(['k1', 'k2'], { TIER1_AFFINITY: kv });
  for (let i = 0; i < 3; i++) {
    const res = await withMockFetch(scriptedUpstream([]).handler, () => chatWithSession(env, 'session-read-limit'));
    assert.equal(res.status, 200);
  }
  assert.equal(kv.gets, 3, 'a failed read is not cached as "no binding"');
  assert.equal(kv.puts, 0, 'Workers Free allows 1,000 KV writes a day; a failed read must not cost one');
});

test('a Claude Code conversation is a session through its own session header', async () => {
  const kv = countingKv();
  const env = tier1OnlyEnv(['k1', 'k2'], { TIER1_AFFINITY: kv });
  const claudeCode = new Request('https://gateway.example.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ACCESS_KEY}`,
      'content-type': 'application/json',
      'x-claude-code-session-id': 'baf7ad9f-3c14-4c5c-8b95-5bfa79d44f7c',
    },
    body: JSON.stringify({ model: 'Code-Pro', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(resolveTier1SessionId(claudeCode), 'baf7ad9f-3c14-4c5c-8b95-5bfa79d44f7c');
  const res = await withMockFetch(scriptedUpstream([]).handler, () => worker.fetch(claudeCode, env, { waitUntil() {} }));
  assert.equal(res.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 10)); // the binding is written after the response
  assert.equal(kv.gets, 1, 'the conversation looks up its Tier 1 binding');
  assert.equal(kv.puts, 1, 'and binds the key that served it');
});

test('an explicit x-session-id wins over the Claude Code session header', () => {
  const both = new Request('https://x/', { headers: { 'x-session-id': 'explicit-session', 'x-claude-code-session-id': 'claude-code-session' } });
  assert.equal(resolveTier1SessionId(both), 'explicit-session');
});

// ---- Load spreads across Tier 1 keys -----------------------------------------

test('a fast Tier 1 key that is already busy yields to an idle slower key', () => {
  const fast = tier1Node('fast');
  const slow = tier1Node('slow');
  recordTier1Ttft('fast', 'm1', 500);
  recordTier1Ttft('slow', 'm1', 2_000);
  const held = [];
  const counts = { fast: 0, slow: 0 };
  for (let i = 0; i < 20; i++) {
    const pick = pickTier1Candidate([fast, slow], REQ, new Set(), { now: 1_000 + i });
    counts[pick.node.id]++;
    held.push(pick);
  }
  for (const pick of held) releaseTier1Slot(pick.node.id, pick.releaseToken);
  assert.ok(counts.slow >= 5, `slow key share ${JSON.stringify(counts)}`);
  assert.ok(counts.fast > counts.slow, `fast key still preferred ${JSON.stringify(counts)}`);
});

test('an idle fast key still wins over an idle slow key', () => {
  recordTier1Ttft('fast', 'm1', 500);
  recordTier1Ttft('slow', 'm1', 2_000);
  const pick = pickTier1Candidate([tier1Node('fast'), tier1Node('slow')], REQ, new Set(), { now: 1_000 });
  assert.equal(pick.node.id, 'fast');
  releaseTier1Slot('fast', pick.releaseToken);
});

// ---- One analytics event per upstream call ------------------------------------

function recordingDataset() {
  const points = [];
  return { points, writeDataPoint: (point) => points.push(point) };
}

test('every upstream call writes one analytics event that names the key, outcome and role', async () => {
  const events = recordingDataset();
  const env = tier1OnlyEnv(['solo'], { GATEWAY_EVENTS: events });
  const upstream = scriptedUpstream([() => errorResponse(500, 'overloaded')]);
  const res = await withMockFetch(upstream.handler, () => chat(env));
  assert.equal(res.status, 200);
  assert.equal(events.points.length, 2);
  const [failed, retried] = events.points;
  assert.deepEqual(failed.indexes, ['solo']);
  assert.deepEqual(failed.blobs.slice(0, 6), ['solo', 'mock', 'tier-1', 'Code-Pro', 'server', 'primary']);
  assert.equal(failed.doubles[0], 500);
  assert.deepEqual(retried.blobs.slice(0, 6), ['solo', 'mock', 'tier-1', 'Code-Pro', 'ok', 'retry']);
  assert.equal(retried.doubles[0], 200);
});

test('a broken analytics binding never fails a request', async () => {
  const env = tier1OnlyEnv(['solo'], {
    GATEWAY_EVENTS: {
      writeDataPoint() {
        throw new Error('dataset unavailable');
      },
    },
  });
  const res = await withMockFetch(scriptedUpstream([]).handler, () => chat(env));
  assert.equal(res.status, 200);
});

test('the deploy binds the analytics dataset only when one is configured', () => {
  assert.equal(buildWranglerConfig({}, '', 'kv').analytics_engine_datasets, undefined);
  assert.deepEqual(buildWranglerConfig({}, '', 'kv', 'gateway_events').analytics_engine_datasets, [
    { binding: 'GATEWAY_EVENTS', dataset: 'gateway_events' },
  ]);
});

test('an invalid analytics dataset name fails the deploy preflight', () => {
  const env = {
    ...tier1OnlyEnv(['solo']),
    AIG_AFFINITY_KV_ID: 'kv-id',
    CLOUDFLARE_API_TOKEN: 'token',
    CLOUDFLARE_ACCOUNT_ID: 'account',
    AIG_ANALYTICS_DATASET: 'bad name!',
  };
  const result = preflight(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('AIG_ANALYTICS_DATASET')), JSON.stringify(result.errors));
});

// ---- Long cooldowns are shared across isolates --------------------------------

function memoryKv() {
  const store = new Map();
  const kv = { store, puts: 0, gets: 0 };
  kv.get = async (key) => {
    kv.gets++;
    return store.has(key) ? store.get(key) : null;
  };
  kv.put = async (key, value) => {
    kv.puts++;
    store.set(key, value);
  };
  return kv;
}

// A fresh isolate: no in-memory Tier 1 state, only what KV remembers.
function freshIsolate() {
  __resetTier1StateForTests();
  __resetAdaptive429StateForTests();
  __resetSharedTier1CooldownsForTests();
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a key rejected with 401 is skipped by a new isolate without another upstream call', async () => {
  const kv = memoryKv();
  const env = tier1OnlyEnv(['solo'], { TIER1_AFFINITY: kv });
  const first = scriptedUpstream([() => errorResponse(401, 'invalid api key')]);
  await withMockFetch(first.handler, () => chat(env));
  await settle();
  assert.equal(kv.puts, 1);
  freshIsolate();
  const second = scriptedUpstream([]);
  const res = await withMockFetch(second.handler, () => chat(env));
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 3_000);
  assert.deepEqual(second.hosts, []);
});

test('a key whose daily quota ran out is skipped by a new isolate while another key serves', async () => {
  const kv = memoryKv();
  const env = tier1OnlyEnv(['k1', 'k2'], { TIER1_AFFINITY: kv });
  const first = scriptedUpstream([() => errorResponse(429, 'daily quota exceeded'), () => errorResponse(429, 'daily quota exceeded')]);
  await withMockFetch(first.handler, () => chat(env));
  await settle();
  freshIsolate();
  const quotaKeys = new Set(first.hosts);
  const second = scriptedUpstream([]);
  const res = await withMockFetch(second.handler, () => chat(env));
  assert.equal(quotaKeys.size, 2);
  assert.equal(res.status, 429, 'both keys are known to be out of quota');
  assert.deepEqual(second.hosts, []);
});

test('a quota cooldown exactly at the sharing threshold is shared while the clock moves', async () => {
  const kv = memoryKv();
  const env = tier1OnlyEnv(['solo'], { TIER1_AFFINITY: kv });
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => ++clock; // every reading of the clock is a millisecond later
  try {
    await withMockFetch(scriptedUpstream([() => errorResponse(429, 'daily quota exceeded')]).handler, () => chat(env));
  } finally {
    Date.now = realNow;
  }
  await settle();
  assert.equal(kv.puts, 1);
  assert.match(kv.store.get('tier1-cooldowns:v1'), /"quota":true/);
});

test('a short rate-limit window is not shared', async () => {
  const kv = memoryKv();
  const env = tier1OnlyEnv(['solo'], { TIER1_AFFINITY: kv });
  const first = scriptedUpstream([() => errorResponse(429, 'rate limit', { 'retry-after': '20' })]);
  await withMockFetch(first.handler, () => chat(env));
  await settle();
  assert.equal(kv.puts, 0);
});

test('a shared cooldown that has expired is ignored', async () => {
  const kv = memoryKv();
  kv.store.set('tier1-cooldowns:v1', JSON.stringify([{ node: 'solo', until: Date.now() - 1_000, reason: 'auth' }]));
  const env = tier1OnlyEnv(['solo'], { TIER1_AFFINITY: kv });
  const res = await withMockFetch(scriptedUpstream([]).handler, () => chat(env));
  assert.equal(res.status, 200);
});

test('a stalled shared-cooldown read does not hold the request', async () => {
  const kv = memoryKv();
  kv.get = () => new Promise(() => {});
  const env = tier1OnlyEnv(['solo'], { TIER1_AFFINITY: kv });
  const res = await withMockFetch(scriptedUpstream([]).handler, () =>
    Promise.race([chat(env), new Promise((resolve) => setTimeout(() => resolve({ status: 'stalled' }), 1_000))]),
  );
  assert.equal(res.status, 200);
});

test('a burst of failures on one key writes the shared cooldowns once', async () => {
  const kv = memoryKv();
  const env = tier1OnlyEnv(['solo'], { TIER1_AFFINITY: kv });
  const pending = [];
  const ctx = { waitUntil: (task) => pending.push(task) };
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    applyTier1Outcome('solo', 'Code-Pro', classifyTier1Failure(classifyUpstreamStatus(401, new Headers(), {})), now + i * 1_000);
    shareLongTier1Cooldowns(env, ctx, 'solo', now + i * 1_000);
    await Promise.all(pending);
  }
  assert.equal(kv.puts, 1, 'nothing new was learned after the first rejection');
});

test('an isolate rereads the shared cooldowns at most once every 5 minutes', async () => {
  const kv = memoryKv();
  const env = tier1OnlyEnv(['solo'], { TIER1_AFFINITY: kv });
  const start = Date.now();
  await hydrateSharedTier1Cooldowns(env, start);
  await hydrateSharedTier1Cooldowns(env, start + 4 * 60_000);
  assert.equal(kv.gets, 1);
  await hydrateSharedTier1Cooldowns(env, start + 5 * 60_000);
  assert.equal(kv.gets, 2);
});

// ---- Claude Code auto mode through protocol fallback --------------------------

const messages = (env, extra = {}) =>
  worker.fetch(
    new Request('https://gateway.example.com/v1/messages?beta=true', {
      method: 'POST',
      headers: { 'x-api-key': ACCESS_KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'Code-Pro', max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'hello' }], ...extra }),
    }),
    env,
    { waitUntil() {} },
  );

test('a field no upstream can carry is a 400 that names it, so the client can resend without it', async () => {
  const env = tier1OnlyEnv(['solo']);
  // Claude Code's auto permission mode asks Anthropic to classify tool calls server side.
  const safeguards = [{ type: 'dangerous_tool_use', classifier_context: { v: 1, permission_mode: 'auto' } }];
  const upstream = scriptedUpstream([]);
  const refused = await withMockFetch(upstream.handler, () => messages(env, { safeguards }));
  assert.equal(refused.status, 400);
  const body = await refused.json();
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'invalid_request_error');
  assert.match(body.error.message, /"safeguards"/);
  assert.equal(body.error.details.failure_kind, 'unsupported_request_field');
  assert.deepEqual(body.error.details.unsupported_fields, ['safeguards']);
  assert.deepEqual(upstream.hosts, [], 'nothing is sent upstream');

  const resent = await withMockFetch(upstream.handler, () => messages(env));
  assert.equal(resent.status, 200);
  assert.deepEqual(upstream.hosts, ['solo']);
});

// ---- Large request bodies cannot exhaust an isolate's memory ------------------

function largeChat(sizeBytes) {
  const filler = 'x'.repeat(sizeBytes);
  const body = JSON.stringify({ model: 'Code-Pro', messages: [{ role: 'user', content: filler }] });
  return new Request('https://gateway.example.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${ACCESS_KEY}`, 'content-type': 'application/json', 'content-length': String(body.length) },
    body,
  });
}

test('large bodies beyond the in-flight memory budget are refused with a retryable 503', async () => {
  const env = tier1OnlyEnv(['solo']);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const handler = async () => {
    await gate;
    return okChat();
  };
  await withMockFetch(handler, async () => {
    const first = worker.fetch(largeChat(17 * 1024 * 1024), env, { waitUntil() {} });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const refused = await Promise.race([
      worker.fetch(largeChat(17 * 1024 * 1024), env, { waitUntil() {} }),
      new Promise((resolve) => setTimeout(() => resolve({ status: 'admitted', headers: new Headers() }), 200)),
    ]);
    if (refused.status !== 503) release();
    assert.equal(refused.status, 503);
    assert.equal(refused.headers.get('retry-after'), '1');
    assert.equal(refused.headers.get('x-should-retry'), null);
    // A small body with a declared Content-Length is charged its real size, not the worst case.
    const small = await Promise.race([worker.fetch(largeChat(64), env, { waitUntil() {} }), new Promise((resolve) => setTimeout(() => resolve({ status: 'queued' }), 20))]);
    assert.equal(small.status, 'queued', 'a small request is admitted and waits on the upstream like the first');
    release();
    assert.equal((await first).status, 200);
    const later = await worker.fetch(largeChat(17 * 1024 * 1024), env, { waitUntil() {} });
    assert.equal(later.status, 200, 'the budget is returned when a request ends');
  });
});

test('a single maximum-size body is admitted when nothing else is in flight', async () => {
  const env = tier1OnlyEnv(['solo']);
  const res = await withMockFetch(scriptedUpstream([]).handler, () => worker.fetch(largeChat(19 * 1024 * 1024), env, { waitUntil() {} }));
  assert.equal(res.status, 200);
});
