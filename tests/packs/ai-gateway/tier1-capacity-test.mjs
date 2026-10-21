// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Tier 1 capacity retention: a Tier 1 key or model is taken out of the pool only
// on evidence that it cannot serve, and a Tier 1-only deployment keeps serving
// through request-local and transient failures.

import { assert, beforeEach, test } from '#kit/harness.mjs';
import { withMockFetch } from '#kit/fetch.mjs';
import { __resetAccessKeysCacheForTests } from '#target/src/config/access-keys.ts';
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
  releaseTier1Slot,
} from '#target/src/reliability/tier1-state.ts';
import { __resetTier1AffinityForTests } from '#target/src/scheduler/tier1-affinity.ts';
import { loadRuntimeConfig, validateGatewayRuntime } from '#target/scripts/github-deployment-config.mjs';
import { pickTier1Candidate } from '#target/src/scheduler/tier1-scheduler.ts';

const ACCESS_KEY = 'tier1-capacity-key';
const AUTH_COOLDOWN_MS = 3_600_000;
const REQ = { protocol: 'openai', surface: 'chat_completions', model: 'm1', bodyChars: 10 };

beforeEach(() => {
  __resetAccessKeysCacheForTests();
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
