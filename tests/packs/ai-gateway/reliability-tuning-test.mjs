// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Reliability tuning contract: size-aware timeouts and hedging (large prompts and
// buffered replies are not killed as if they were short chat turns), 429
// classification precedence (a per-minute unit or a short wait beats a generic
// "quota" word; an N-hour window is a long-lived allowance), the long-allowance
// ladder, and the Messages -> Chat fallback with optional server tools.

import worker from '#target/src/index.ts';
import {
  HEDGE_BUFFERED_MIN_MS,
  SIZE_ALLOWANCE_MAX_MS,
  adaptiveHedgeDelayMs,
  getLimits,
  requestSizeAllowanceMs,
} from '#target/src/config/timeouts.ts';
import {
  ADAPTIVE_429_QUOTA_STEPS_MS,
  __resetAdaptive429StateForTests,
  adaptive429StepsFromEnv,
} from '#target/src/reliability/adaptive-429.ts';
import { QUOTA_RETRY_AFTER_MAX_MS } from '#target/src/config/timeouts.ts';
import { classifyUpstreamStatus, rateLimitWindowOf, retryHintFromBody } from '#target/src/reliability/classify.ts';
import { __resetAllStateForTests, getNodeState } from '#target/src/reliability/node-state.ts';
import {
  __resetTier1StateForTests,
  applyTier1Outcome,
  claimTier1Slot,
  classifyTier1Failure,
  getTier1Account,
  getTier1Model,
  recordTier1Success,
  wakeTier1ProviderSiblings,
} from '#target/src/reliability/tier1-state.ts';
import { __resetTier1AffinityForTests } from '#target/src/scheduler/tier1-affinity.ts';
import assert from 'node:assert/strict';

const KEY = 'reliability-tuning-key';
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

// ---- size-aware timing ---------------------------------------------------------------
await test('request size grants a bounded allowance and short prompts get none', () => {
  assert.equal(requestSizeAllowanceMs(0), 0);
  assert.equal(requestSizeAllowanceMs(undefined), 0);
  assert.equal(requestSizeAllowanceMs(50_000), 0);
  assert.equal(requestSizeAllowanceMs(400_000), 14_000);
  assert.equal(requestSizeAllowanceMs(50_000_000), SIZE_ALLOWANCE_MAX_MS);
});

await test('the built-in hedge delay adapts to size, observed TTFT and buffered replies, and never shrinks', () => {
  assert.equal(adaptiveHedgeDelayMs(3_000, {}), 3_000);
  assert.equal(adaptiveHedgeDelayMs(3_000, { bodyChars: 400_000 }), 14_000);
  assert.equal(adaptiveHedgeDelayMs(3_000, { ttftEwmaMs: 4_000 }), 8_000);
  assert.equal(adaptiveHedgeDelayMs(3_000, { ttftEwmaMs: 60_000 }), 20_000, 'adaptation is capped');
  assert.equal(adaptiveHedgeDelayMs(3_000, { isBuffered: true }), HEDGE_BUFFERED_MIN_MS);
  assert.equal(adaptiveHedgeDelayMs(30_000, { bodyChars: 400_000 }), 30_000, 'a larger configured delay is kept');
  assert.equal(getLimits({ AIG_HEDGE_DELAY_MS: '2500' }).isHedgeDelayExplicit, true);
  assert.equal(getLimits({}).isHedgeDelayExplicit, false);
});

// ---- 429 classification -----------------------------------------------------------------
await test('an explicit minute unit or a short wait beats a generic quota word', () => {
  const gemini =
    'You exceeded your current quota, please check your plan and billing details. quota_id: GenerateRequestsPerMinutePerProjectPerModel-FreeTier';
  assert.equal(rateLimitWindowOf(gemini), 'window', 'a per-minute quota is a short window');
  assert.equal(rateLimitWindowOf('You exceeded your current quota, please check your plan and billing details.'), 'quota');
  assert.equal(rateLimitWindowOf('You exceeded your current quota', 28_000), 'window', 'a short stated wait decides ambiguous wording');
  assert.equal(rateLimitWindowOf('You exceeded your current quota', 1_800_000), 'quota');
  assert.equal(rateLimitWindowOf('limits: per minute and per day exceeded'), 'window', 'both named, no wait: lean to the self-correcting window side');
  assert.equal(rateLimitWindowOf('limits: per minute and per day exceeded', 20_000), 'window');
  assert.equal(rateLimitWindowOf('limits: per minute and per day exceeded', 900_000), 'quota', 'both named: a wait beyond the minute window proves the long one');
  assert.equal(rateLimitWindowOf('\u60a8\u7684\u8d26\u6237\u5df2\u8fbe\u5230\u901f\u7387\u9650\u5236\uff0c\u8bf7\u60a8\u63a7\u5236\u8bf7\u6c42\u9891\u7387'), 'window');
});

await test('an N-hour window is a long-lived allowance', () => {
  assert.equal(rateLimitWindowOf('5-hour limit reached'), 'quota');
  assert.equal(rateLimitWindowOf('You have reached the usage limit for this 5 hour window'), 'quota');
  assert.equal(rateLimitWindowOf('hourly request cap exceeded'), 'quota');
  assert.equal(rateLimitWindowOf('已达到 5 小时的使用上限'), 'quota');
  assert.equal(rateLimitWindowOf('Rate limit reached on tokens per minute (TPM)'), 'window');
  assert.equal(rateLimitWindowOf('10 hits in a row'), undefined, 'a unit letter inside a word is not an hour');
});

await test('a long-lived allowance keeps the hours its provider states; a short window keeps the 10 minute ceiling', () => {
  const now = Date.parse('2026-10-20T00:00:00Z');
  const quota = classifyUpstreamStatus(429, new Headers({ 'retry-after': '18000' }), env, now, 'You have reached the usage limit for this 5 hour window');
  assert.equal(quota.rateLimitWindow, 'quota');
  assert.equal(quota.retryAfterMs, 18_000_000);
  const bare = classifyUpstreamStatus(429, new Headers({ 'retry-after': '7200' }), env, now, '');
  assert.equal(bare.rateLimitWindow, 'quota', 'a wait of ten minutes or more is itself proof of a long allowance');
  assert.equal(bare.retryAfterMs, 7_200_000);
  const capped = classifyUpstreamStatus(429, new Headers({ 'retry-after': String(7 * 86_400) }), env, now, 'daily limit reached');
  assert.equal(capped.retryAfterMs, QUOTA_RETRY_AFTER_MAX_MS, 'one header cannot park a key for days');
  const window = classifyUpstreamStatus(429, new Headers({ 'retry-after': '120' }), env, now, 'rate limit reached');
  assert.equal(window.rateLimitWindow, 'window');
  assert.equal(window.retryAfterMs, 120_000);
  assert.equal(retryHintFromBody('resets at 2026-10-20T04:00:00Z', now, QUOTA_RETRY_AFTER_MAX_MS), 4 * 3_600_000, 'an absolute reset instant with a zone is read');
  assert.equal(retryHintFromBody('resets at 2026-10-20 04:00:00', now, QUOTA_RETRY_AFTER_MAX_MS), 0, 'a bare local time has no safe reading');
  assert.equal(retryHintFromBody('resets at 2020-01-01T00:00:00Z', now, QUOTA_RETRY_AFTER_MAX_MS), 0, 'a past instant is no hint');
});

await test('the long-allowance ladder is tunable and malformed input keeps the built-in one', () => {
  assert.deepEqual([...ADAPTIVE_429_QUOTA_STEPS_MS], [300_000, 600_000, 1_200_000, 1_800_000], 'the built-in ladder tops out at 30 minutes');
  assert.deepEqual([...adaptive429StepsFromEnv('600000,3600000', ADAPTIVE_429_QUOTA_STEPS_MS)], [600_000, 3_600_000]);
  assert.equal(adaptive429StepsFromEnv('nope', ADAPTIVE_429_QUOTA_STEPS_MS), ADAPTIVE_429_QUOTA_STEPS_MS);
});

// ---- ladder through the real pipeline ------------------------------------------------------
function chatRequest(model = 'general-air') {
  return new Request('https://gateway.example.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }] }),
  });
}

function gatewayEnv(nodes, secrets, extra = {}) {
  return {
    AIG_ACCESS_KEY_AIR: KEY,
    AIG_ACCESS_MODELS_AIR: '*',
    AIG_PROTOCOL_FALLBACKS: 'disable',
    AIG_TIER1_NODES_01: JSON.stringify(nodes),
    AIG_TIER1_CREDENTIALS_01: JSON.stringify(secrets),
    ...extra,
  };
}

const okCompletion = {
  id: 'c1',
  object: 'chat.completion',
  model: 'm',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

await test('a 5-hour allowance cools the whole key for 5 minutes, then 10 minutes, while a healthy key serves', async () => {
  const calls = [];
  globalThis.fetch = async (input) => {
    const host = new URL(typeof input === 'string' ? input : input.url).hostname;
    calls.push(host);
    if (host === 'quota.example.com') {
      return new Response(JSON.stringify({ error: { message: 'You have reached the usage limit for this 5 hour window' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(okCompletion), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const nodes = [
    { id: 'quota', provider: 'plan-provider', base_url: 'https://quota.example.com/v1', models: { 'general-air': 'up' } },
    { id: 'healthy', provider: 'plan-provider', base_url: 'https://healthy.example.com/v1', models: { 'general-air': 'up' } },
  ];
  const e = gatewayEnv(nodes, { quota: 'k1', healthy: 'k2' }, { TIER1_SCHEDULER_SEED: 'tuning-ladder' });
  // Drive requests until the quota key has taken its 429 (the pick is random).
  for (let i = 0; i < 20 && getTier1Account('quota').accountCooldownUntil === 0; i++) {
    const res = await worker.fetch(chatRequest(), e, {});
    assert.equal(res.status, 200, 'a healthy sibling key always serves the request');
  }
  const first = getTier1Account('quota');
  assert.equal(first.accountCooldownReason, 'rate_limit');
  const remaining = first.accountCooldownUntil - Date.now();
  assert.ok(remaining > 295_000 && remaining <= 300_000, `first stage is 5 minutes, got ${remaining}`);
  assert.equal(first.accountCooldownIsQuota, true);

  // Let the cooldown lapse (clock moved past it), then fail the recovery probe.
  const realNow = Date.now;
  Date.now = () => realNow() + 301_000;
  try {
    for (let i = 0; i < 20 && getTier1Account('quota').accountCooldownUntil < Date.now(); i++) {
      const res = await worker.fetch(chatRequest(), e, {});
      assert.equal(res.status, 200);
    }
    const second = getTier1Account('quota').accountCooldownUntil - Date.now();
    assert.ok(second > 595_000 && second <= 600_000, `second stage is 10 minutes, got ${second}`);
  } finally {
    Date.now = realNow;
  }
});

await test('a per-minute 429 never graduates to the long-allowance ladder, however often its probe fails', async () => {
  let probes = 0;
  globalThis.fetch = async () => {
    probes++;
    return new Response(JSON.stringify({ error: { message: 'Rate limit reached on tokens per minute (TPM): Limit 6000' } }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });
  };
  const nodes = [{ id: 'limited', provider: 'window-provider', base_url: 'https://limited.example.com/v1', models: { 'general-air': 'up' } }];
  const e = gatewayEnv(nodes, { limited: 'k1' });
  const realNow = Date.now;
  let offsetMs = 0;
  Date.now = () => realNow() + offsetMs;
  try {
    for (let i = 0; i < 8; i++) {
      // Move past every possible cooldown, so each request is the key's recovery probe.
      offsetMs += 6 * 3_600_000;
      const before = probes;
      await worker.fetch(chatRequest(), e, {});
      assert.equal(probes, before + 1, `request ${i + 1} probed the limited key once`);
      const account = getTier1Account('limited');
      const model = getTier1Model('limited', 'general-air');
      assert.notEqual(account.accountCooldownIsQuota, true, `probe ${i + 1}: a per-minute limit is never recorded as a long-lived allowance`);
      assert.notEqual(model.cooldownIsQuota, true, `probe ${i + 1}: neither on the model`);
      const longest = Math.max(account.accountCooldownUntil, model.cooldownUntil) - Date.now();
      assert.ok(longest <= 300_000, `probe ${i + 1}: the per-minute ladder stays capped at 5 minutes, got ${longest}`);
    }
  } finally {
    Date.now = realNow;
  }
});

await test('a Tier 1 long allowance is benched for at most 30 minutes, whatever wait the provider states', async () => {
  globalThis.fetch = async (input) => {
    const host = new URL(typeof input === 'string' ? input : input.url).hostname;
    if (host === 'quota.example.com') {
      return new Response(JSON.stringify({ error: { message: 'You have reached the usage limit for this 5 hour window' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '18000' },
      });
    }
    return new Response(JSON.stringify(okCompletion), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const nodes = [
    { id: 'quota', provider: 'plan-provider', base_url: 'https://quota.example.com/v1', models: { 'general-air': 'up' } },
    { id: 'healthy', provider: 'plan-provider', base_url: 'https://healthy.example.com/v1', models: { 'general-air': 'up' } },
  ];
  const e = gatewayEnv(nodes, { quota: 'k1', healthy: 'k2' }, { TIER1_SCHEDULER_SEED: 'tuning-quota-cap' });
  for (let i = 0; i < 20 && getTier1Account('quota').accountCooldownUntil === 0; i++) {
    const res = await worker.fetch(chatRequest(), e, {});
    assert.equal(res.status, 200, 'a healthy sibling key always serves the request');
  }
  const account = getTier1Account('quota');
  assert.equal(account.accountCooldownReason, 'rate_limit');
  assert.equal(account.accountCooldownIsQuota, true, 'an explicit 5 hour window is still recognised as a long allowance');
  const remaining = account.accountCooldownUntil - Date.now();
  assert.ok(remaining > 1_790_000 && remaining <= 1_800_000, `the stated 5 hours is capped at 30 minutes, got ${remaining}`);
});

await test('a sibling is not woken early out of a long-allowance cooldown, only out of a short-window one', () => {
  const now = 50_000_000;
  for (const id of ['recovered', 'quota-sibling', 'window-sibling']) {
    assert.equal(claimTier1Slot({ id, provider: 'shared-provider', tier: 'tier-1' }, now), true);
  }
  const quota = classifyTier1Failure({ kind: 'rate_limit', rateLimitScope: 'account', rateLimitClass: 'quota' }, { retryAfterMs: 3_600_000 });
  const window = classifyTier1Failure({ kind: 'rate_limit', rateLimitScope: 'account', rateLimitClass: 'window' }, { retryAfterMs: 300_000 });
  applyTier1Outcome('quota-sibling', 'm', quota, now);
  applyTier1Outcome('window-sibling', 'm', window, now);
  recordTier1Success('recovered', 'm', now + 1);
  const woken = wakeTier1ProviderSiblings('shared-provider', 'recovered', 'm', now + 2);
  assert.deepEqual(woken, ['window-sibling']);
  assert.ok(getTier1Account('quota-sibling').accountCooldownUntil > now + 3_000_000);
});

await test('Tier 3 keeps the ordinary ten minute Retry-After ceiling for a long allowance', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'You have reached the usage limit for this 5 hour window' } }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '18000' },
    });
  const e = {
    AIG_ACCESS_KEY_AIR: KEY,
    AIG_ACCESS_MODELS_AIR: '*',
    AIG_PROTOCOL_FALLBACKS: 'disable',
    AIG_TIER3_NODES_01: JSON.stringify([{ id: 'paid', provider: 'paid-provider', base_url: 'https://paid.example.com/v1', models: { 'general-air': 'up' } }]),
    AIG_TIER3_CREDENTIALS_01: JSON.stringify({ paid: 'k' }),
  };
  const res = await worker.fetch(chatRequest(), e, {});
  assert.equal(res.status, 429);
  const remaining = getNodeState('paid').cooldownUntil - Date.now();
  assert.ok(remaining > 590_000 && remaining <= 600_000, `Tier 3 cooldown stays at the 10 minute ceiling, got ${remaining}`);
});

// ---- timers: buffered replies and large prompts ------------------------------------------------
function captureTimers() {
  const original = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (typeof ms === 'number') delays.push(ms);
    return original(fn, ms, ...rest);
  };
  return {
    delays,
    restore: () => {
      globalThis.setTimeout = original;
    },
  };
}

await test('a buffered reply waits for the generation, a streamed one keeps the header timeout; big prompts hedge later', async () => {
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(init.body);
    if (body.stream === true) {
      const chunk = { id: 'c', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] };
      const stop = { id: 'c', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(stop)}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(JSON.stringify(okCompletion), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const nodes = [{ id: 'solo', provider: 'solo-provider', base_url: 'https://solo.example.com/v1', models: { 'general-chat': 'up' } }];
  const e = gatewayEnv(nodes, { solo: 'k' }, { AIG_UPSTREAM_HEADER_TIMEOUT_MS: '5000' });
  const request = (stream, filler = '') =>
    new Request('https://gateway.example.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: 'general-chat', stream, messages: [{ role: 'user', content: `hello${filler}` }] }),
    });

  const buffered = captureTimers();
  try {
    const res = await worker.fetch(request(false), e, {});
    assert.equal(res.status, 200);
    await res.text();
  } finally {
    buffered.restore();
  }
  assert.ok(!buffered.delays.includes(5_000), 'a buffered reply is not bound by the 5s header timeout');
  assert.ok(buffered.delays.some((ms) => ms >= 50_000), 'it may wait for the whole attempt window');
  assert.ok(buffered.delays.includes(HEDGE_BUFFERED_MIN_MS), 'and is hedged no earlier than the buffered floor');

  const streamed = captureTimers();
  try {
    const res = await worker.fetch(request(true), e, {});
    assert.equal(res.status, 200);
    await res.text();
  } finally {
    streamed.restore();
  }
  assert.ok(streamed.delays.includes(5_000), 'a streamed reply keeps the header timeout');
  assert.ok(streamed.delays.includes(3_000), 'a short streamed prompt keeps the built-in hedge delay');

  const big = captureTimers();
  try {
    const res = await worker.fetch(request(true, 'x'.repeat(400_000)), e, {});
    assert.equal(res.status, 200);
    await res.text();
  } finally {
    big.restore();
  }
  assert.ok(big.delays.some((ms) => ms > 18_900 && ms < 19_300), 'the header timeout grows with the prompt');
  assert.ok(big.delays.some((ms) => ms > 13_900 && ms < 14_300), 'so does the hedge delay');
  assert.ok(!big.delays.includes(3_000), 'the big prompt is not hedged at the short-chat delay');
});

// ---- Messages -> Chat fallback with optional server tools ----------------------------------------
const FN_TOOL = { name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } };

async function messagesViaChatFallback(extraBody) {
  const upstream = [];
  globalThis.fetch = async (_input, init) => {
    upstream.push(JSON.parse(init.body));
    const chunk = { id: 'c', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] };
    const stop = { id: 'c', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(stop)}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  const nodes = [{ id: 'chat-only', provider: 'generic', base_url: 'https://chat-only.example.com/v1', models: { 'code-max': 'up' } }];
  const e = {
    AIG_ACCESS_KEY_AIR: KEY,
    AIG_ACCESS_MODELS_AIR: '*',
    AIG_TIER1_NODES_01: JSON.stringify(nodes),
    AIG_TIER1_CREDENTIALS_01: JSON.stringify({ 'chat-only': 'k' }),
  };
  const res = await worker.fetch(
    new Request('https://gateway.example.com/v1/messages?beta=true', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'code-max', max_tokens: 1024, stream: true, messages: [{ role: 'user', content: 'hi' }], ...extraBody }),
    }),
    e,
    {},
  );
  return { res, upstream, text: await res.text() };
}

await test('Claude Code optional server tools do not block the Chat fallback while function tools remain', async () => {
  const { res, upstream } = await messagesViaChatFallback({
    tools: [
      FN_TOOL,
      { type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-5' },
      { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(upstream.length, 1);
  assert.deepEqual(
    upstream[0].tools.map((tool) => tool.function.name),
    ['Read'],
    'server tools are never exposed as fake functions',
  );
});

await test('a request that depends on a server tool is still refused instead of served without it', async () => {
  const onlyNative = await messagesViaChatFallback({ tools: [{ type: 'web_search_20250305', name: 'web_search' }] });
  assert.equal(onlyNative.res.status, 502);
  assert.equal(onlyNative.upstream.length, 0);
  const forced = await messagesViaChatFallback({
    tools: [FN_TOOL, { type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-5' }],
    tool_choice: { type: 'tool', name: 'advisor' },
  });
  assert.equal(forced.res.status, 502);
  assert.equal(forced.upstream.length, 0);
  const mcp = await messagesViaChatFallback({ tools: [FN_TOOL], mcp_servers: [{ type: 'url', url: 'https://mcp.example.com', name: 'x' }] });
  assert.equal(mcp.res.status, 502, 'a server-side MCP connector is not silently dropped');
});

console.log(`reliability-tuning: ${passed} passed`);
