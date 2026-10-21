// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Tier 1 capacity retention: a Tier 1 key or model is taken out of the pool only
// on evidence that it cannot serve, and a Tier 1-only deployment keeps serving
// through request-local and transient failures.

import { assert, beforeEach, test } from '#kit/harness.mjs';
import { withMockFetch } from '#kit/fetch.mjs';
import { __resetAccessKeysCacheForTests } from '#target/src/config/access-keys.ts';
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
