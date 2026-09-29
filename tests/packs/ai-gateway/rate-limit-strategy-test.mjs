// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Tier 1 429 cooldown strategy: whom a 429 is blamed on (model first, account on
// evidence), how long the ladder waits (provider hints, quota-shaped text, tunable
// steps), what a 413 means (this request, not this key), and how siblings and
// missing models recover.

import { loadGatewayConfig } from '#target/src/config/nodes.ts';
import worker from '#target/src/index.ts';
import {
  ADAPTIVE_429_COOLDOWN_STEPS_MS,
  ADAPTIVE_429_QUOTA_START_STAGE,
  __resetAdaptive429StateForTests,
  adaptive429StepsFromEnv,
  nextAdaptive429CooldownMs,
  snapshotAdaptive429State,
} from '#target/src/reliability/adaptive-429.ts';
import { KIND, classifyUpstreamStatus, rateLimitWindowOf, retryHintFromBody } from '#target/src/reliability/classify.ts';
import { __resetAllStateForTests } from '#target/src/reliability/node-state.ts';
import {
  TIER1_MODEL_MISSING_LADDER_MS,
  TIER1_OVERSIZE_MEMORY_MS,
  __resetTier1StateForTests,
  applyTier1Outcome,
  claimTier1Slot,
  classifyTier1Failure,
  decideTier1RateLimitScope,
  getTier1Account,
  getTier1ModelPerf,
  isTier1Eligible,
  recordTier1Oversize,
  recordTier1Success,
  recordTier1Ttft,
  recordTier1UpstreamModelServed,
  wakeTier1ProviderSiblings,
} from '#target/src/reliability/tier1-state.ts';
import { __resetTier1AffinityForTests } from '#target/src/scheduler/tier1-affinity.ts';
import assert from 'node:assert/strict';

const KEY = 'rate-limit-strategy-key';
const env = {};
let passed = 0;

async function test(name, fn) {
  try {
    __resetAllStateForTests();
    __resetTier1StateForTests();
    __resetTier1AffinityForTests();
    __resetAdaptive429StateForTests();
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`FAIL: ${name}`);
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}

// ---- mock upstream -----------------------------------------------------------
const calls = [];
let handlers = {};
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  calls.push({ host: url.hostname, model: body.model });
  const handler = handlers[url.hostname];
  if (!handler) throw new Error(`no mock upstream for ${url.hostname}`);
  return handler(body);
};
const ok = (model) =>
  new Response(
    JSON.stringify({ id: 'c', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: 'served' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
const fail = (status, message, headers = {}) => new Response(JSON.stringify({ error: { message } }), { status, headers: { 'content-type': 'application/json', ...headers } });

const node = (id, provider, models) => ({ id, provider, base_url: `https://${id}.example.com/v1`, models });
const envFor = (nodes, extra = {}) => ({
  AIG_ACCESS_KEY_AIR: KEY,
  AIG_ACCESS_MODELS_AIR: '*',
  AIG_PROTOCOL_FALLBACKS: 'disable',
  AIG_TIER1_NODES_01: JSON.stringify(nodes),
  AIG_TIER1_CREDENTIALS_01: JSON.stringify(Object.fromEntries(nodes.map((n) => [n.id, 'k']))),
  ...extra,
});
const chat = (model, pad = 5) =>
  new Request('https://gateway.example.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'x'.repeat(pad) }] }),
  });
const runtimeNodes = (nodes) => loadGatewayConfig(envFor(nodes)).nodes.filter((n) => n.tier === 'tier-1');
const req = (model, bodyChars) => ({ model, protocol: 'openai', surface: 'chat_completions', ...(bodyChars ? { bodyChars } : {}) });

// ---- ladder --------------------------------------------------------------------
await test('default ladder tops out at 30 minutes and is tunable through AIG_RATE_LIMIT_STEPS_MS', () => {
  assert.deepEqual([...ADAPTIVE_429_COOLDOWN_STEPS_MS], [15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_200_000, 1_800_000]);
  assert.deepEqual([...adaptive429StepsFromEnv('60000, 300000,900000')], [60_000, 300_000, 900_000]);
  for (const bad of [undefined, '', '   ', 'abc', '15000,abc', '500', '15000,99999999999', '1,2,3,4,5,6,7,8,9,10,11,12,13'.replaceAll(/(\d+)/g, '60000')]) {
    assert.deepEqual([...adaptive429StepsFromEnv(bad)], [...ADAPTIVE_429_COOLDOWN_STEPS_MS], `invalid input keeps the default: ${bad}`);
  }
  const base = 1_000_000;
  assert.equal(nextAdaptive429CooldownMs('p', 'k', 0, base, '', [60_000, 120_000]), 60_000);
  assert.equal(nextAdaptive429CooldownMs('p', 'k', 0, base + 60_001, '', [60_000, 120_000]), 120_000);
  assert.equal(nextAdaptive429CooldownMs('p', 'k', 0, base + 200_000, '', [60_000, 120_000]), 120_000, 'the last step repeats');
});

await test('a provider hint is trusted for the first two failures, then only raises the ladder floor', () => {
  const base = 2_000_000;
  assert.equal(nextAdaptive429CooldownMs('p', 'k', 4_000, base), 4_000, 'stage 1 uses the provider hint as-is, even below the first step');
  assert.equal(nextAdaptive429CooldownMs('p', 'k', 4_000, base + 4_001), 4_000, 'stage 2 still trusts the hint');
  assert.equal(nextAdaptive429CooldownMs('p', 'k', 4_000, base + 8_002), 60_000, 'stage 3 never goes below the ladder step');
  assert.equal(nextAdaptive429CooldownMs('q', 'k', 900_000, base), 900_000, 'a hint above the ladder is honoured');
});

await test('a model ladder and the account ladder are independent', () => {
  const base = 3_000_000;
  assert.equal(nextAdaptive429CooldownMs('p', 'k', 0, base, 'ModelA'), 15_000);
  assert.equal(nextAdaptive429CooldownMs('p', 'k', 0, base + 15_001, 'ModelA'), 30_000);
  assert.equal(nextAdaptive429CooldownMs('p', 'k', 0, base + 15_001, 'ModelB'), 15_000, 'another model starts at the first step');
  assert.equal(nextAdaptive429CooldownMs('p', 'k', 0, base + 15_001), 15_000, 'the account ladder is untouched');
  assert.equal(snapshotAdaptive429State('p', 'k', base + 15_001, 'ModelA').stage, 2);
  assert.equal(snapshotAdaptive429State('p', 'k', base + 15_001).stage, 1);
});

await test('quota-shaped text starts the ladder at 5 minutes; the other 429s keep the short steps', () => {
  const base = 4_000_000;
  assert.equal(ADAPTIVE_429_QUOTA_START_STAGE, 5);
  assert.equal(nextAdaptive429CooldownMs('q', 'k', 0, base, '', ADAPTIVE_429_COOLDOWN_STEPS_MS, ADAPTIVE_429_QUOTA_START_STAGE), 300_000);
  assert.equal(nextAdaptive429CooldownMs('q', 'k', 0, base + 300_001, '', ADAPTIVE_429_COOLDOWN_STEPS_MS, ADAPTIVE_429_QUOTA_START_STAGE), 600_000, 'the ladder continues upwards');
  assert.equal(nextAdaptive429CooldownMs('w', 'k', 0, base), 15_000);
  assert.equal(nextAdaptive429CooldownMs('short', 'k', 0, base, '', [60_000, 120_000], ADAPTIVE_429_QUOTA_START_STAGE), 120_000, 'a short custom ladder clamps the start stage');
});

// ---- classification --------------------------------------------------------------
await test('the wait a provider states in the error text becomes a hint', () => {
  assert.equal(retryHintFromBody('Rate limit reached ... Please try again in 7.66s.'), 7_660);
  assert.equal(retryHintFromBody('Please try again in 12m3.5s'), 600_000, 'clamped like Retry-After');
  assert.equal(retryHintFromBody('Please try again in 1m30s'), 90_000);
  assert.equal(retryHintFromBody('resets in 2 minutes'), 120_000);
  assert.equal(retryHintFromBody('try again after 500ms'), 1_000, 'never below the one second floor');
  assert.equal(retryHintFromBody('try again in 5 hours'), 600_000, 'never above the ten minute ceiling');
  assert.equal(retryHintFromBody('no hint here'), 0);
  assert.equal(retryHintFromBody(''), 0);
  const result = classifyUpstreamStatus(429, new Headers(), { AIG_RATE_LIMIT_COOLDOWN_MS: '30000' }, Date.now(), '{"error":{"message":"Please try again in 7s"}}');
  assert.equal(result.retryAfterMs, 7_000);
  assert.equal(result.explicitRetryAfter, true);
  const header = classifyUpstreamStatus(429, new Headers({ 'retry-after': '3' }), env, Date.now(), 'Please try again in 7s');
  assert.equal(header.retryAfterMs, 3_000, 'the Retry-After header wins over the text');
});

await test('429 text is sorted into long-lived allowance versus short window without naming providers', () => {
  assert.equal(rateLimitWindowOf('You exceeded your current quota, please check your plan and billing details.'), 'quota');
  assert.equal(rateLimitWindowOf('Rate limit exceeded: free-models-per-day. Add credits to unlock more.'), 'quota');
  assert.equal(rateLimitWindowOf('Rate limit reached on requests per day (RPD): Limit 1000'), 'quota');
  assert.equal(rateLimitWindowOf('本时段额度已用完'), 'quota');
  assert.equal(rateLimitWindowOf('Rate limit reached on tokens per minute (TPM): Limit 6000'), 'window');
  assert.equal(rateLimitWindowOf('Too many requests'), 'window');
  assert.equal(rateLimitWindowOf('Something else happened'), undefined);
  assert.equal(rateLimitWindowOf(''), undefined);
  assert.equal(classifyUpstreamStatus(429, new Headers(), env, Date.now(), 'quota exceeded').rateLimitWindow, 'quota');
  assert.equal(classifyUpstreamStatus(429, new Headers(), env, Date.now(), 'nothing').rateLimitWindow, undefined);
});

await test('a token-ceiling 413 is about this request, not the key', () => {
  const groq = 'Request too large for model g on tokens per minute (TPM): Limit 6000, Requested 9000, please reduce your message size';
  const result = classifyUpstreamStatus(413, new Headers(), env, Date.now(), groq);
  assert.equal(result.kind, KIND.CLIENT);
  assert.equal(result.action, 'rotate');
  assert.equal(result.cooldownMs, 0);
  assert.equal(result.requestTooLarge, true);
  const throttled = classifyUpstreamStatus(413, new Headers({ 'retry-after': '3' }), env, Date.now(), groq);
  assert.equal(throttled.kind, KIND.RATE_LIMIT, 'a Retry-After says the refusal is time based, so it stays a rate limit');
  const plain = classifyUpstreamStatus(413, new Headers(), env, Date.now(), '{"error":{"message":"Request body exceeds the maximum payload size of 4 MB"}}');
  assert.equal(plain.action, 'stop');
});

await test('"no endpoints found" names a missing model, not a wrong base URL', () => {
  const result = classifyUpstreamStatus(404, new Headers(), env, Date.now(), '{"error":{"message":"No endpoints found for openai/gpt-oss-20b:free."}}');
  assert.equal(result.kind, KIND.MODEL_MISSING);
  assert.equal(result.modelScoped, true);
  assert.equal(classifyUpstreamStatus(404, new Headers(), env, Date.now(), 'Not Found').kind, KIND.ENDPOINT_NOT_FOUND);
});

// ---- scope -----------------------------------------------------------------------
await test('a 429 is blamed on its model until a second model on the same key is limited', () => {
  const now = 10_000_000;
  assert.equal(decideTier1RateLimitScope('key-1', 'ModelA', now), 'model');
  assert.equal(decideTier1RateLimitScope('key-1', 'ModelA', now + 1_000), 'model', 'the same model again is still just that model');
  assert.equal(decideTier1RateLimitScope('key-1', 'ModelB', now + 2_000), 'account', 'a second distinct model is the evidence of an account-wide limit');
  assert.equal(decideTier1RateLimitScope('key-2', 'ModelA', now), 'model', 'another key is judged on its own');
  assert.equal(decideTier1RateLimitScope('key-3', 'ModelA', now), 'model');
  assert.equal(decideTier1RateLimitScope('key-3', 'ModelB', now + 61_000), 'model', 'the evidence lapses after a minute');
});

await test('once the account is on the rate-limit ladder every further 429 stays account-wide', () => {
  const now = 20_000_000;
  const outcome = classifyTier1Failure({ kind: 'rate_limit', rateLimitScope: 'account' }, { retryAfterMs: 15_000 });
  applyTier1Outcome('key-1', 'ModelA', outcome, now);
  assert.equal(getTier1Account('key-1').consecutiveRateLimits, 1);
  assert.equal(decideTier1RateLimitScope('key-1', 'ModelC', now + 20_000), 'account');
});

await test('one limited model does not take the healthy models of the same key out of the pool', async () => {
  calls.length = 0;
  handlers = {
    'multi.example.com': (body) => (body.model === 'limited-up' ? fail(429, 'model is temporarily rate-limited upstream') : ok(body.model)),
    'backup.example.com': (body) => ok(body.model),
  };
  const nodes = [node('multi', 'p', { Air: 'limited-up', Pro: 'fine-up' }), node('backup', 'q', { Air: 'b-up', Pro: 'b-up2' })];
  const envx = envFor(nodes);
  recordTier1Ttft('multi', 'Air', 50);
  recordTier1Ttft('backup', 'Air', 2_000);
  const first = await worker.fetch(chat('Air'), envx, {});
  assert.equal(first.status, 200, 'the limited model is served by the backup key');
  const account = getTier1Account('multi');
  assert.equal(account.accountCooldownUntil, 0, 'the key itself is not put on cooldown');
  assert.ok((getTier1ModelPerf('multi', 'Air')?.cooldownUntil ?? 0) > Date.now(), 'the limited model is cooling');
  assert.equal(getTier1ModelPerf('multi', 'Pro')?.cooldownUntil ?? 0, 0, 'the other model is untouched');
  const proNodes = runtimeNodes(nodes);
  assert.equal(isTier1Eligible(proNodes.find((n) => n.id === 'multi'), req('Pro')), true, 'the healthy model still routes to this key');
  assert.equal(isTier1Eligible(proNodes.find((n) => n.id === 'multi'), req('Air')), false, 'the limited model does not');
});

await test('two limited models on one key widen the cooldown to the whole key', async () => {
  handlers = {
    'wide.example.com': () => fail(429, 'slow down'),
    'backup.example.com': (body) => ok(body.model),
  };
  const nodes = [node('wide', 'p', { Air: 'a-up', Pro: 'p-up' }), node('backup', 'q', { Air: 'b-up', Pro: 'b-up2' })];
  const envx = envFor(nodes);
  for (const model of ['Air', 'Pro']) {
    recordTier1Ttft('wide', model, 50);
    recordTier1Ttft('backup', model, 2_000);
  }
  await worker.fetch(chat('Air'), envx, {});
  await worker.fetch(chat('Pro'), envx, {});
  assert.ok(getTier1Account('wide').accountCooldownUntil > Date.now(), 'the second distinct model tipped it to the whole key');
});

// ---- 413 -------------------------------------------------------------------------
await test('a key that refuses a large request keeps serving small ones and is skipped for large ones', async () => {
  calls.length = 0;
  handlers = {
    'groq.example.com': (body) => (JSON.stringify(body.messages).length > 500 ? fail(413, 'Request too large on tokens per minute (TPM): Limit 6000, Requested 9000') : ok(body.model)),
    'backup.example.com': (body) => ok(body.model),
  };
  const nodes = [node('groq', 'g', { Air: 'g-up' }), node('backup', 'q', { Air: 'b-up' })];
  const envx = envFor(nodes, { TIER1_SCHEDULER_SEED: 'oversize' });
  const large = await worker.fetch(chat('Air', 4000), envx, {});
  assert.equal(large.status, 200, 'the large request still succeeds on the backup');
  const account = getTier1Account('groq');
  if (calls.some((c) => c.host === 'groq.example.com')) {
    assert.equal(account.accountCooldownUntil, 0, 'no cooldown for a size refusal');
    assert.equal(account.consecutiveRateLimits, 0);
    assert.equal(getTier1ModelPerf('groq', 'Air')?.cooldownUntil ?? 0, 0);
  }
  const nodesRt = runtimeNodes(nodes);
  const groqNode = nodesRt.find((n) => n.id === 'groq');
  recordTier1Oversize('groq', 'Air', 4_020);
  assert.equal(isTier1Eligible(groqNode, req('Air', 4_500)), false, 'a request at least that large skips the key');
  assert.equal(isTier1Eligible(groqNode, req('Air', 4_020)), false);
  assert.equal(isTier1Eligible(groqNode, req('Air', 300)), true, 'a smaller request still uses it');
  assert.equal(isTier1Eligible(groqNode, req('Air')), true, 'an unknown size is never skipped');
});

await test('the "too large" memory keeps the smallest refused size and lapses after ten minutes', () => {
  const nodes = [node('lapse', 'g', { Air: 'g-up' })];
  const [rt] = runtimeNodes(nodes);
  const now = 50_000_000;
  recordTier1Oversize('lapse', 'Air', 9_000, now);
  recordTier1Oversize('lapse', 'Air', 6_000, now + 1_000);
  recordTier1Oversize('lapse', 'Air', 8_000, now + 2_000);
  assert.equal(isTier1Eligible(rt, req('Air', 6_500), now + 3_000), false, 'the smallest refusal is the ceiling');
  assert.equal(isTier1Eligible(rt, req('Air', 5_900), now + 3_000), true);
  assert.equal(isTier1Eligible(rt, req('Air', 6_500), now + 2_000 + TIER1_OVERSIZE_MEMORY_MS + 1), true, 'the memory lapses so a raised limit is noticed');
  recordTier1Oversize('lapse', 'Air', 0, now);
  recordTier1Oversize('lapse', 'Air', Number.NaN, now);
});

// ---- sibling recovery ---------------------------------------------------------
await test('a recovered key wakes cooling siblings of the same provider only', () => {
  const nodes = [node('sn-1', 'sensenova', { Air: 'a' }), node('sn-2', 'sensenova', { Air: 'a' }), node('sn-3', 'sensenova', { Air: 'a' }), node('other', 'nvidia', { Air: 'a' })];
  const rts = runtimeNodes(nodes);
  const now = 60_000_000;
  for (const rt of rts) claimTier1Slot(rt, now, 'Air');
  const limited = classifyTier1Failure({ kind: 'rate_limit', rateLimitScope: 'account' }, { retryAfterMs: 1_800_000 });
  applyTier1Outcome('sn-2', 'Air', limited, now);
  applyTier1Outcome('other', 'Air', limited, now);
  applyTier1Outcome('sn-3', 'Air', classifyTier1Failure({ kind: 'rate_limit', rateLimitScope: 'account' }, { retryAfterMs: 30_000 }), now);
  const woken = wakeTier1ProviderSiblings('sensenova', 'sn-1', 'Air', now + 1_000);
  assert.deepEqual(woken, ['sn-2'], 'same provider, still cooling for long enough; not the short cooldown, not another provider');
  assert.equal(getTier1Account('sn-2').accountCooldownUntil, now + 1_000);
  assert.ok(getTier1Account('other').accountCooldownUntil > now + 1_000_000);
  assert.ok(getTier1Account('sn-3').accountCooldownUntil > now + 20_000);
});

await test('sibling wake also covers a limited model', () => {
  const nodes = [node('m-1', 'prov', { Air: 'a' }), node('m-2', 'prov', { Air: 'a' })];
  const rts = runtimeNodes(nodes);
  const now = 70_000_000;
  for (const rt of rts) claimTier1Slot(rt, now, 'Air');
  applyTier1Outcome('m-2', 'Air', classifyTier1Failure({ kind: 'rate_limit', rateLimitScope: 'model' }, { retryAfterMs: 1_200_000 }), now);
  assert.ok(getTier1ModelPerf('m-2', 'Air').cooldownUntil > now + 1_000_000);
  assert.deepEqual(wakeTier1ProviderSiblings('prov', 'm-1', 'Air', now + 5_000), ['m-2']);
  assert.equal(getTier1ModelPerf('m-2', 'Air').cooldownUntil, now + 5_000);
  assert.equal(recordTier1Success('m-1', 'Air', now + 6_000), undefined);
});

// ---- model_missing ladder --------------------------------------------------------
await test('a model id the upstream keeps refusing is retried less and less often, and forgiven on success', () => {
  const missing = classifyTier1Failure({ kind: 'model_missing', cooldownMs: 5_000 });
  const account = getTier1Account('mm');
  let now = 80_000_000;
  const waits = [];
  for (let i = 0; i < 8; i++) {
    applyTier1Outcome('mm', 'up-model', missing, now);
    const until = account.upstreamModelCooldowns.get('up-model') ?? 0;
    waits.push(until - now);
    now = until + 1;
  }
  assert.deepEqual(waits, [...TIER1_MODEL_MISSING_LADDER_MS, TIER1_MODEL_MISSING_LADDER_MS.at(-1), TIER1_MODEL_MISSING_LADDER_MS.at(-1)]);
  recordTier1UpstreamModelServed('mm', 'up-model');
  applyTier1Outcome('mm', 'up-model', missing, now);
  assert.equal((account.upstreamModelCooldowns.get('up-model') ?? 0) - now, TIER1_MODEL_MISSING_LADDER_MS[0], 'a success resets the streak');
});

await test('in-flight siblings of the same missing-model burst do not escalate the ladder', () => {
  const missing = classifyTier1Failure({ kind: 'model_missing', cooldownMs: 5_000 });
  const account = getTier1Account('burst');
  const now = 90_000_000;
  applyTier1Outcome('burst', 'up-model', missing, now);
  applyTier1Outcome('burst', 'up-model', missing, now + 100);
  applyTier1Outcome('burst', 'up-model', missing, now + 200);
  assert.equal(account.upstreamModelMisses.get('up-model'), 1, 'one burst is one miss');
  assert.ok((account.upstreamModelCooldowns.get('up-model') ?? 0) - now < TIER1_MODEL_MISSING_LADDER_MS[1], 'and still on the first step');
});

console.log(`rate-limit-strategy tests: ${passed} passed`);
