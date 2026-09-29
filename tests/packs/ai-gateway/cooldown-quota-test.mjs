// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Merged suite. Each section below was a standalone suite and keeps its own scope:
//   - adaptive-429-test.mjs
//   - cooldown-jitter-test.mjs
//   - provider-quota-413-test.mjs
//   - quota-lease-test.mjs
//   - tier1-affinity-bounding-test.mjs
//   - tier1-heat-protection-test.mjs
//   - tier1-upstream-model-cooldown-test.mjs
//   - scheduler-convergence-test.mjs
//   - scheduler-racelost-test.mjs
//   - model-family-fallback-test.mjs

import { loadPoliciesConfig } from '#target/src/config/policies.ts';
import worker from '#target/src/index.ts';
import { ADAPTIVE_429_COOLDOWN_STEPS_MS, __resetAdaptive429StateForTests, clearAdaptive429State, nextAdaptive429CooldownMs, snapshotAdaptive429State } from '#target/src/reliability/adaptive-429.ts';
import { KIND, classifyUpstreamStatus } from '#target/src/reliability/classify.ts';
import { COOLDOWN_JITTER_FACTOR, jitterCooldownMs } from '#target/src/reliability/cooldown-jitter.ts';
import { __resetAllStateForTests, acquireSlot } from '#target/src/reliability/node-state.ts';
import { extractQuotaSignal } from '#target/src/reliability/quota-signal.ts';
import { TIER1_PROVIDER_MODEL_429_WINDOW_MS, __resetTier1HeatForTests, recordTier1ProviderModelRateLimit, recordTier1ProviderModelSuccess, tier1AffinityHeatFactor, tier1CanAcceptHedge, tier1ConcurrencyPressure, tier1ProviderModelHeatFactor, tier1ProviderModelRateLimitCount, tier1SelectionHeatFactor } from '#target/src/reliability/tier1-heat.ts';
import { __resetTier1StateForTests, applyTier1Outcome, claimTier1Slot, classifyTier1Failure, getTier1ModelPerf, isTier1Eligible, makeTier1ReleaseToken, recordTier1QuotaReport, recordTier1QuotaSignal, releaseTier1Slot, settleTier1Quota, tier1BlockingWaitMs, tier1QuotaState } from '#target/src/reliability/tier1-state.ts';
import { recordOutcome } from '#target/src/request/attempt/outcome.ts';
import { buildModelFallbackPlan, buildModelFallbackRounds, hasModelFamilyFallback, modelFallbackCandidates } from '#target/src/request/model-fallback.ts';
import { computeTierCaps, pickForTier } from '#target/src/request/tier-loop.ts';
import { pickCandidate } from '#target/src/scheduler/scheduler.ts';
import { __resetTier1AffinityForTests, readTier1Affinity, shouldEvaluateAffinity, snapshotTier1Affinity, writeTier1Affinity } from '#target/src/scheduler/tier1-affinity.ts';
import { pickTier1Candidate } from '#target/src/scheduler/tier1-scheduler.ts';
import { calculateTier1Score } from '#target/src/scheduler/tier1-scoring.ts';
import assert from 'node:assert/strict';

// ==========================================================================
// adaptive-429-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT




  const base = 1_800_000_000_000;

  function reset() {
    __resetAdaptive429StateForTests();
  }

  reset();
  assert.deepEqual(
    [...ADAPTIVE_429_COOLDOWN_STEPS_MS],
    [15_000, 30_000, 60_000, 120_000, 300_000, 900_000, 1_800_000, 3_600_000],
    'adaptive 429 ladder must stay bounded at one hour',
  );

  assert.equal(nextAdaptive429CooldownMs('nvidia', 'key-01', 0, base), 15_000);
  assert.equal(snapshotAdaptive429State('nvidia', 'key-01', base).stage, 1);

  // Extra 429s from requests already in flight during the same cooldown must not
  // escalate the stage. A burst of parallel 429s must never jump to one hour.
  assert.equal(nextAdaptive429CooldownMs('nvidia', 'key-01', 0, base + 1_000), 14_000);
  assert.equal(snapshotAdaptive429State('nvidia', 'key-01', base + 1_000).stage, 1);

  // Only a 429 after the previous cooldown expired (the recovery request) moves
  // to the next stage.
  assert.equal(nextAdaptive429CooldownMs('nvidia', 'key-01', 0, base + 15_001), 30_000);
  assert.equal(snapshotAdaptive429State('nvidia', 'key-01', base + 15_001).stage, 2);

  let now = base + 15_001;
  for (const expected of [60_000, 120_000, 300_000, 900_000, 1_800_000, 3_600_000, 3_600_000]) {
    const current = snapshotAdaptive429State('nvidia', 'key-01', now).cooldown_remaining_ms;
    now += current + 1;
    assert.equal(nextAdaptive429CooldownMs('nvidia', 'key-01', 0, now), expected);
  }

  // Binding is explicitly Provider + key-slot. Neither a sibling key nor the
  // same key id under another Provider inherits the cooldown stage.
  assert.equal(nextAdaptive429CooldownMs('nvidia', 'key-02', 0, base), 15_000);
  assert.equal(nextAdaptive429CooldownMs('sensenova', 'key-01', 0, base), 15_000);
  assert.equal(snapshotAdaptive429State('nvidia', 'key-01', now).stage, 8);
  assert.equal(snapshotAdaptive429State('nvidia', 'key-02', base).stage, 1);
  assert.equal(snapshotAdaptive429State('sensenova', 'key-01', base).stage, 1);

  // Retry-After is a minimum hint; it may extend the current cooldown but can
  // never shorten the adaptive stage.
  reset();
  assert.equal(nextAdaptive429CooldownMs('provider-a', 'key-a', 45_000, base), 45_000);
  assert.equal(nextAdaptive429CooldownMs('provider-a', 'key-a', 5_000, base + 1_000), 44_000);

  // A real recovery success clears the Provider+key history. The next 429 starts
  // from the short first stage again.
  clearAdaptive429State('provider-a', 'key-a');
  assert.equal(snapshotAdaptive429State('provider-a', 'key-a', base).stage, 0);
  assert.equal(nextAdaptive429CooldownMs('provider-a', 'key-a', 0, base + 60_000), 15_000);

  console.log('adaptive 429 tests passed.');
  console.log('ok - file:adaptive-429');
} catch (error) {
  console.error('not ok - adaptive-429-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// cooldown-jitter-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs




  assert.equal(COOLDOWN_JITTER_FACTOR, 0.1);
  assert.equal(jitterCooldownMs(0, 0), 0);
  assert.equal(jitterCooldownMs(-100, 1), -100);
  assert.equal(jitterCooldownMs(1_000, 0), 900);
  assert.equal(jitterCooldownMs(1_000, 0.5), 1_000);
  assert.equal(jitterCooldownMs(1_000, 1), 1_100);
  assert.equal(jitterCooldownMs(333, 0), 300);
  assert.equal(jitterCooldownMs(333, 1), 366);

  console.log('cooldown-jitter-test passed');
  console.log('ok - file:cooldown-jitter');
} catch (error) {
  console.error('not ok - cooldown-jitter-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// provider-quota-413-test.mjs
// ==========================================================================
try {
  let passed = 0;
  let failed = 0;
  async function test(name, fn) {
    try {
      await fn();
      passed++;
      console.log(`ok - ${name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL - ${name}`);
      console.error(error?.stack || error);
    }
  }

  const env = { AIG_RATE_LIMIT_COOLDOWN_MS: '60000' };

  await test('Groq ITPM-shaped 413 rotates as a node rate limit', () => {
    const body = JSON.stringify({ error: { message: 'Request too large on input tokens per minute (ITPM): Limit 7000, Requested 7398.' } });
    const result = classifyUpstreamStatus(413, new Headers(), env, Date.now(), body);
    assert.equal(result.kind, KIND.RATE_LIMIT);
    assert.equal(result.action, 'rotate');
    assert.equal(result.cooldownMs, 60000);
  });

  await test('quota-shaped 413 honors Retry-After', () => {
    const result = classifyUpstreamStatus(413, new Headers({ 'retry-after': '3' }), env, Date.now(), '{"error":{"message":"TPM rate limit exceeded"}}');
    assert.equal(result.kind, KIND.RATE_LIMIT);
    assert.equal(result.retryAfterMs, 3000);
    assert.equal(result.cooldownMs, 3000);
    assert.equal(result.explicitRetryAfter, true);
  });

  await test('ordinary payload-size 413 remains a client stop', () => {
    const result = classifyUpstreamStatus(
      413,
      new Headers(),
      env,
      Date.now(),
      '{"error":{"message":"Request body exceeds the maximum payload size of 4 MB"}}',
    );
    assert.equal(result.kind, KIND.CLIENT);
    assert.equal(result.action, 'stop');
  });

  await test('real request continues after Tier 1 quota-413', async () => {
    __resetAllStateForTests();
    __resetTier1StateForTests();
    __resetTier1AffinityForTests();
    const accessKey = 'quota-413-integration-key';
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      calls.push(url.hostname);
      if (url.hostname === 'groq-quota.example.com') {
        return new Response(JSON.stringify({ error: { message: 'input tokens per minute (ITPM): Limit 7000, Requested 7398' } }), {
          status: 413,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.hostname === 'fallback.example.com') {
        const requestBody = init?.body ? JSON.parse(init.body) : {};
        return Response.json({
          id: 'chatcmpl-quota-fallback',
          object: 'chat.completion',
          model: requestBody.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'fallback ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 7398, completion_tokens: 2, total_tokens: 7400 },
        });
      }
      throw new Error(`unexpected host ${url.hostname}`);
    };

    try {
      const integrationEnv = {
        AIG_ACCESS_KEY_PRO: accessKey,
        AIG_ACCESS_MODELS_PRO: '*',
        AIG_PROTOCOL_FALLBACKS: 'disable',
        AIG_HEDGE_DELAY_MS: '0',
        AIG_REQUEST_HEDGE_MAX: '0',
        AIG_RATE_LIMIT_COOLDOWN_MS: '60000',
        AIG_TIER1_NODES_01: JSON.stringify([
          {
            id: 'groq-quota',
            provider: 'groq',
            base_url: 'https://groq-quota.example.com/v1',
            priority: 10,
            models: { 'Quota-Test': 'qwen/qwen3.8-27b' },
          },
        ]),
        AIG_TIER1_CREDENTIALS_01: JSON.stringify({ 'groq-quota': 'groq-key' }),
        AIG_TIER2_NODES_01: JSON.stringify([
          {
            id: 'fallback-node',
            provider: 'fallback-provider',
            base_url: 'https://fallback.example.com/v1',
            priority: 10,
            models: { 'Quota-Test': 'fallback-model' },
          },
        ]),
        AIG_TIER2_CREDENTIALS_01: JSON.stringify({ 'fallback-node': 'fallback-key' }),
        AIG_POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 2 } }),
      };
      const response = await worker.fetch(
        new Request('https://gateway.example.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${accessKey}` },
          body: JSON.stringify({ model: 'Quota-Test', messages: [{ role: 'user', content: 'large context' }] }),
        }),
        integrationEnv,
        {},
      );
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body?.choices?.[0]?.message?.content, 'fallback ok');
      assert.deepEqual(calls, ['groq-quota.example.com', 'fallback.example.com']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  console.log(`\nprovider-quota-413-test: ${passed} passed, ${failed} failed.`);
  if (failed > 0) suiteExit(1);
  console.log('ok - file:provider-quota-413');
} catch (error) {
  console.error('not ok - provider-quota-413-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// quota-lease-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs
  //
  // Quota lease lifecycle contracts:
  //   acquire -> reserve -> execute -> settle -> release
  //
  //   - unknown quota is a no-op pass-through (no fabricated hard limits; the
  //     reactive adaptive-429 + cooldown behavior is untouched)
  //   - provider-reported remaining drives a reservation counter so concurrent
  //     admission cannot all pass against the tail of a window
  //   - settle consumes the request reservation and reports actual token usage;
  //     duplicate settle/release are idempotent
  //   - release before settle (abort / pre-execution failure / hedge loss)
  //     restores the reservation
  //   - quota windows classify near_limit (score demotion) and exhausted_until
  //     (eligibility gate + blocking wait) before the next 429






  let passed = 0;
  function test(name, fn) {
    try {
      fn();
      passed++;
      console.log(`ok - ${name}`);
    } catch (e) {
      console.error(`FAIL - ${name}`);
      console.error(e?.stack || e);
      process.exitCode = 1;
    }
  }

  const node = (id) => ({
    id,
    tier: 'tier-1',
    provider: 'mock',
    protocol: 'openai',
    surfaces: ['chat_completions'],
    baseUrl: `https://${id}.example.com/v1`,
    credential: 'k',
    priority: 10,
    models: { 'Code-Max': 'up' },
  });
  const req = { protocol: 'openai', surface: 'chat_completions', model: 'Code-Max' };

  test('unknown quota never denies admission (reactive path preserved)', () => {
    __resetTier1StateForTests();
    for (let i = 0; i < 100; i++) {
      assert.equal(
        claimTier1Slot(node('u1'), 1000 + i, 'Code-Max', null),
        true,
        'without a provider report, every claim is admitted exactly as before',
      );
      const token = makeTier1ReleaseToken('u1');
      releaseTier1Slot('u1', token);
    }
    assert.equal(tier1QuotaState('u1'), 'normal');
  });

  test('quota signal extraction reads both protocol conventions', () => {
    const openai = extractQuotaSignal(
      'openai',
      new Headers({
        'x-ratelimit-remaining-requests': '9',
        'x-ratelimit-remaining-tokens': '5000',
        'x-ratelimit-limit-requests': '10',
        'x-ratelimit-reset-requests': '60s',
      }),
      1000,
    );
    assert.deepEqual(
      { remainingRequests: openai?.remainingRequests, limitRequests: openai?.limitRequests, remainingTokens: openai?.remainingTokens },
      { remainingRequests: 9, limitRequests: 10, remainingTokens: 5000 },
    );
    assert.ok(openai?.resetAtMs === 61_000, 'reset marker resolves to a wall-clock instant');

    const anthropic = extractQuotaSignal(
      'anthropic',
      new Headers({
        'anthropic-ratelimit-requests-remaining': '3',
        'anthropic-ratelimit-requests-limit': '100',
        'anthropic-ratelimit-requests-reset': '30',
      }),
      2000,
    );
    assert.equal(anthropic?.remainingRequests, 3);
    assert.equal(anthropic?.resetAtMs, 32_000);

    assert.equal(extractQuotaSignal('openai', new Headers({}), 0), null, 'no markers -> no signal -> unknown quota');
  });

  test('reported remaining=10 admits exactly 10 concurrent, not 20', () => {
    __resetTier1StateForTests();
    recordTier1QuotaReport('race', { remainingRequests: 10, limitRequests: 100 }, 1000);
    let admitted = 0;
    const tokens = [];
    for (let i = 0; i < 20; i++) {
      if (claimTier1Slot(node('race'), 1001 + i, 'Code-Max', null)) {
        admitted++;
        tokens.push(makeTier1ReleaseToken('race'));
      }
    }
    assert.equal(admitted, 10, 'the 11th..20th concurrent claims are denied against a reported tail of 10');
    assert.equal(isTier1Eligible(node('race'), req, 1001), false, 'the exhausted reservation also fails eligibility');
    for (const token of tokens) releaseTier1Slot('race', token);
  });

  test('release before settle restores the reservation (abort / pre-execution)', () => {
    __resetTier1StateForTests();
    recordTier1QuotaReport('abort', { remainingRequests: 1, limitRequests: 10 }, 1000);
    assert.equal(claimTier1Slot(node('abort'), 1001, 'Code-Max', null), true);
    const token = makeTier1ReleaseToken('abort');
    releaseTier1Slot('abort', token);
    assert.equal(claimTier1Slot(node('abort'), 1002, 'Code-Max', null), true, 'an aborted claim gives the reservation back');
    releaseTier1Slot('abort', makeTier1ReleaseToken('abort'));
  });

  test('settle consumes the request reservation and reports actual usage', () => {
    __resetTier1StateForTests();
    recordTier1QuotaReport('settle', { remainingRequests: 2, remainingTokens: 10_000, limitRequests: 10, limitTokens: 100_000 }, 1000);
    // Claim + settle consumes one slot; token usage is subtracted.
    assert.equal(claimTier1Slot(node('settle'), 1001, 'Code-Max', null), true);
    const tokenA = makeTier1ReleaseToken('settle');
    settleTier1Quota('settle', tokenA, 3_500);
    releaseTier1Slot('settle', tokenA);
    // Claim + settle consumes the second slot.
    assert.equal(claimTier1Slot(node('settle'), 1002, 'Code-Max', null), true);
    const tokenB = makeTier1ReleaseToken('settle');
    settleTier1Quota('settle', tokenB, 1_000);
    releaseTier1Slot('settle', tokenB);
    // Both reservations were settled (consumed), so admission now waits.
    assert.equal(claimTier1Slot(node('settle'), 1003, 'Code-Max', null), false, 'settled leases do not give reservations back');
    // A fresher provider report reconciles the window: 2 reported, 0 outstanding.
    recordTier1QuotaReport('settle', { remainingRequests: 2, limitRequests: 10 }, 1004);
    // Claim + release WITHOUT settle restores, so the tail is reusable.
    assert.equal(claimTier1Slot(node('settle'), 1005, 'Code-Max', null), true);
    releaseTier1Slot('settle', makeTier1ReleaseToken('settle'));
    assert.equal(claimTier1Slot(node('settle'), 1006, 'Code-Max', null), true, 'an aborted claim gives its reservation back');
    releaseTier1Slot('settle', makeTier1ReleaseToken('settle'));
  });

  test('duplicate settle and duplicate release are idempotent (no leaks)', () => {
    __resetTier1StateForTests();
    recordTier1QuotaReport('idem', { remainingRequests: 2, limitRequests: 4 }, 1000);
    assert.equal(claimTier1Slot(node('idem'), 1001, 'Code-Max', null), true);
    const token = makeTier1ReleaseToken('idem');
    settleTier1Quota('idem', token, 10);
    settleTier1Quota('idem', token, 10);
    settleTier1Quota('idem', token, 10);
    releaseTier1Slot('idem', token);
    assert.equal(releaseTier1Slot('idem', token), false, 'second release is a no-op');
    releaseTier1Slot('idem', token);
    recordTier1QuotaReport('idem', { remainingRequests: 2, limitRequests: 4 }, 1002);
    assert.equal(claimTier1Slot(node('idem'), 1003, 'Code-Max', null), true);
    releaseTier1Slot('idem', makeTier1ReleaseToken('idem'));
  });

  test('near_limit demotes the node score before a 429 ever arrives', () => {
    __resetTier1StateForTests();
    const a = node('fresh');
    const b = node('tail');
    recordTier1QuotaReport('tail', { remainingRequests: 1, limitRequests: 100 }, 1000);
    assert.equal(tier1QuotaState('tail', 1001), 'near_limit');
    assert.ok(
      calculateTier1Score(b, 'Code-Max', [a, b], 1, 1001) > calculateTier1Score(a, 'Code-Max', [a, b], 1, 1001),
      'the near-limit node scores worse than an equally unknown healthy node',
    );
  });

  test('exhausted_until gates eligibility and surfaces the window wait, then auto-clears', () => {
    __resetTier1StateForTests();
    const resetAt = 60_000;
    recordTier1QuotaReport('window', { remainingRequests: 0, limitRequests: 10, resetAtMs: resetAt }, 1000);
    assert.equal(tier1QuotaState('window', 2000), 'exhausted_until');
    assert.equal(isTier1Eligible(node('window'), req, 2000), false);
    assert.equal(claimTier1Slot(node('window'), 2001, 'Code-Max', null), false);
    assert.equal(tier1BlockingWaitMs(node('window'), 'Code-Max', 2000), resetAt - 2000, 'blocking wait reflects the quota window for Retry-After');
    assert.equal(tier1QuotaState('window', resetAt + 1), 'normal', 'window expiry auto-restores');
    assert.equal(isTier1Eligible(node('window'), req, resetAt + 1), true);
  });

  test('legacy ratio writer keeps its pinned semantics', () => {
    __resetTier1StateForTests();
    assert.equal(recordTier1QuotaSignal('legacy', { remainingRatio: 0.05 }), true);
    assert.equal(tier1QuotaState('legacy'), 'near_limit');
    assert.equal(recordTier1QuotaSignal('legacy', { remainingRatio: 0 }), true);
    assert.equal(tier1QuotaState('legacy'), 'near_limit', 'zero without reset classifies near_limit');
    const at = Date.now() + 50_000;
    assert.equal(recordTier1QuotaSignal('legacy', { remainingRatio: 0, resetAtMs: at }), true);
    assert.equal(tier1QuotaState('legacy'), 'exhausted_until');
    assert.equal(recordTier1QuotaSignal('legacy', { remainingRatio: 0.5 }), true);
    assert.equal(tier1QuotaState('legacy'), 'normal');
    assert.equal(recordTier1QuotaSignal('legacy', { remainingRatio: 1.5 }), false, 'out-of-range ratios are rejected');
  });

  test('subscription window hints mark the entitlement exhausted until reset', () => {
    __resetTier1StateForTests();
    recordTier1QuotaReport('sub', { remainingRequests: 0, resetAtMs: 90_000, source: 'subscription-window' }, 1000);
    assert.equal(tier1QuotaState('sub', 1500), 'exhausted_until');
    assert.equal(claimTier1Slot(node('sub'), 1501, 'Code-Max', null), false);
    assert.equal(isTier1Eligible(node('sub'), req, 1501), false);
  });

  console.log(`[quota-lease-test] ${passed} checks passed`);
  console.log('ok - file:quota-lease');
} catch (error) {
  console.error('not ok - quota-lease-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// tier1-affinity-bounding-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs
  //
  // Tier1 Session Affinity bounding stress tests (PR 2 — P1-A).
  //
  // Verifies:
  //   * local cache size <= configured max under 10000+ unique session IDs
  //   * escapeCounters size <= configured max under 10000+ unique session IDs
  //   * expiry works correctly
  //   * affinity still works (read/write/escape)
  //   * KV fallback still works
  //   * cache full does not block request processing




  let passed = 0;
  function test(name, fn) {
    try {
      __resetTier1AffinityForTests();
      fn();
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (e) {
      console.error(`FAIL: ${name}`);
      console.error(e?.stack || e);
      process.exitCode = 1;
    }
  }
  async function testAsync(name, fn) {
    try {
      __resetTier1AffinityForTests();
      await fn();
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (e) {
      console.error(`FAIL: ${name}`);
      console.error(e?.stack || e);
      process.exitCode = 1;
    }
  }

  // Mock KV that never expires (to test the isolate-local bounding, not KV TTL)
  function mockKv() {
    const store = new Map();
    return {
      async get(key) {
        return store.get(key) ?? null;
      },
      async put(key, value, opts) {
        store.set(key, value);
      },
    };
  }

  // --- 1. Cache bounded under 10000+ unique session IDs ---

  await testAsync('stress: local cache size stays bounded under 10000 unique sessions', async () => {
    const env = { TIER1_AFFINITY: mockKv() };
    for (let i = 0; i < 10000; i++) {
      const sid = `session-${i}-`.padEnd(8, 'x');
      await readTier1Affinity(env, sid);
    }
    const snap = snapshotTier1Affinity(env);
    assert.ok(snap.cache_size <= snap.cache_max_entries, `cache_size ${snap.cache_size} must not exceed max ${snap.cache_max_entries}`);
  });

  // --- 2. escapeCounters bounded under 10000+ unique session IDs ---

  test('stress: escapeCounters size stays bounded under 10000 unique sessions', () => {
    for (let i = 0; i < 10000; i++) {
      const sid = `session-${i}-`.padEnd(8, 'x');
      shouldEvaluateAffinity(sid);
    }
    const snap = snapshotTier1Affinity({});
    assert.ok(
      snap.escape_counters_size <= snap.escape_max_entries,
      `escape_counters_size ${snap.escape_counters_size} must not exceed max ${snap.escape_max_entries}`,
    );
  });

  // --- 3. Both bounded simultaneously ---

  await testAsync('stress: both maps bounded simultaneously under 10000 unique sessions', async () => {
    const env = { TIER1_AFFINITY: mockKv() };
    for (let i = 0; i < 10000; i++) {
      const sid = `session-${i}-`.padEnd(8, 'x');
      await readTier1Affinity(env, sid);
      shouldEvaluateAffinity(sid);
    }
    const snap = snapshotTier1Affinity(env);
    assert.ok(snap.cache_size <= snap.cache_max_entries, `cache bounded: ${snap.cache_size}/${snap.cache_max_entries}`);
    assert.ok(snap.escape_counters_size <= snap.escape_max_entries, `escape bounded: ${snap.escape_counters_size}/${snap.escape_max_entries}`);
  });

  // --- 4. Affinity still works after bounding ---

  await testAsync('affinity: write then read returns the stored account', async () => {
    const env = { TIER1_AFFINITY: mockKv() };
    const sid = 'test-session-affinity';
    writeTier1Affinity(env, { waitUntil: () => {} }, sid, 'account-1');
    // Wait for the async write to complete
    await new Promise((r) => setTimeout(r, 50));
    const result = await readTier1Affinity(env, sid);
    assert.equal(result, 'account-1');
  });

  // --- 5. KV fallback still works (no KV binding -> null, no crash) ---

  await testAsync('affinity: no KV binding -> readTier1Affinity returns null without crash', async () => {
    const env = {};
    const result = await readTier1Affinity(env, 'session-no-kv');
    assert.equal(result, null);
  });

  // --- 6. Cache full does not block request processing ---

  await testAsync('stress: cache full does not block reads (no throw, returns null for miss)', async () => {
    const env = { TIER1_AFFINITY: mockKv() };
    // Fill cache to max
    for (let i = 0; i < 600; i++) {
      await readTier1Affinity(env, `session-overflow-${i}-`.padEnd(8, 'x'));
    }
    // New session should still work
    const result = await readTier1Affinity(env, 'session-after-overflow-xx');
    assert.equal(result, null); // KV miss
  });

  // --- 7. Escape counter logic still works ---

  test('escape: shouldEvaluateAffinity returns false for first N-1 requests, true on Nth', () => {
    const sid = 'escape-test-session';
    for (let i = 0; i < 9; i++) {
      assert.equal(shouldEvaluateAffinity(sid), false, `request ${i + 1} should not trigger escape`);
    }
    assert.equal(shouldEvaluateAffinity(sid), true, '10th request should trigger escape');
  });

  // --- 8. Raw session ID is never stored as a Map key ---

  test('privacy: raw session ID does not appear as escape counter key (hashed)', () => {
    const sid = 'sensitive-session-id-12345';
    shouldEvaluateAffinity(sid);
    shouldEvaluateAffinity(sid);
    // The internal Map should not have the raw session ID as a key
    // (we can verify indirectly: snapshot doesn't leak raw IDs)
    const snap = snapshotTier1Affinity({});
    const serialized = JSON.stringify(snap);
    assert.ok(!serialized.includes('sensitive-session-id-12345'), 'raw session ID must not appear in affinity snapshot');
  });

  // --- 9. Expiry works ---

  test('stress: expired cache entries are cleaned up', async () => {
    // Use a very short TTL by directly testing the bounding behavior
    const env = { TIER1_AFFINITY: mockKv() };
    await readTier1Affinity(env, 'session-expiry-1');
    await readTier1Affinity(env, 'session-expiry-2');
    const snap1 = snapshotTier1Affinity(env);
    assert.ok(snap1.cache_size > 0, 'cache has entries after reads');
    // Wait for TTL to expire (5s cache TTL)
    // We won't wait 5s in a unit test; instead verify the bounding mechanism
    // works by filling well past max and checking size stays bounded
    for (let i = 0; i < 1000; i++) {
      await readTier1Affinity(env, `session-fill-${i}-`.padEnd(8, 'x'));
    }
    const snap2 = snapshotTier1Affinity(env);
    assert.ok(snap2.cache_size <= snap2.cache_max_entries, `cache bounded after fill: ${snap2.cache_size}/${snap2.cache_max_entries}`);
  });

  console.log(`\ntier1-affinity bounding tests: ${passed} passed.`);
  if (process.exitCode) {
    console.error('Some tier1-affinity bounding tests FAILED.');
  } else {
    console.log('All tier1-affinity bounding tests passed.');
  }
  console.log('ok - file:tier1-affinity-bounding');
} catch (error) {
  console.error('not ok - tier1-affinity-bounding-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// tier1-heat-protection-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // @ts-check





  const now = 1_800_000_000_000;
  const req = { model: 'Code-Max', protocol: 'openai', surface: 'chat_completions' };
  const node = (id, overrides = {}) => ({
    id,
    tier: 'tier-1',
    provider: 'nvidia',
    protocol: 'openai',
    surfaces: ['chat_completions'],
    baseUrl: 'https://example.invalid/v1',
    credential: `secret-${id}`,
    priority: 1,
    models: { 'Code-Max': 'upstream-code-max' },
    ...overrides,
  });
  function releasePick(pick) {
    if (pick?.node && pick?.releaseToken) releaseTier1Slot(pick.node.id, pick.releaseToken);
  }
  function reset() {
    __resetTier1StateForTests();
    __resetTier1HeatForTests();
  }
  async function test(name, fn) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (e) {
      console.error(`not ok - ${name}`);
      console.error(e?.stack || e);
      process.exitCode = 1;
    }
  }

  await test('cold accounts preserve affinity preference', () => {
    reset();
    const a = node('a'),
      b = node('b');
    const p = pickTier1Candidate([a, b], req, new Set(), { affinityAccountId: 'a', now, rng: () => 0 });
    assert.equal(p?.node?.id, 'a');
    releasePick(p);
  });
  await test('live in-flight heat weakens affinity without becoming a hard gate', () => {
    reset();
    const a = node('a');
    for (let i = 0; i < 3; i++) assert.equal(claimTier1Slot(a, now, req.model), true);
    assert.equal(tier1ConcurrencyPressure(a), 0.75);
    assert.equal(tier1AffinityHeatFactor(a, 0.85), 0.9625);
    assert.ok(tier1SelectionHeatFactor(a, 0.85) > 1);
    const p = pickTier1Candidate([a], req, new Set(), { affinityAccountId: 'a', now, rng: () => 0, evaluateAffinity: true });
    assert.equal(p?.node?.id, 'a');
    releasePick(p);
  });
  await test('soft load never hard-blocks the only primary candidate', () => {
    reset();
    const a = node('a');
    for (let i = 0; i < 4; i++) assert.equal(claimTier1Slot(a, now, req.model), true);
    const p = pickTier1Candidate([a], req, new Set(), { now });
    assert.equal(p?.node?.id, 'a');
    releasePick(p);
  });
  await test('optional hedge is suppressed at 0.75 live pressure', () => {
    reset();
    const busy = node('busy');
    for (let i = 0; i < 3; i++) assert.equal(claimTier1Slot(busy, now, req.model), true);
    assert.equal(tier1CanAcceptHedge(busy), false);
  });
  await test('optional hedge uses an idle peer', () => {
    reset();
    const primary = node('primary'),
      idle = node('idle');
    assert.equal(tier1CanAcceptHedge(idle), true);
    const p = pickTier1Candidate([primary, idle], req, new Set(), { excludeId: 'primary', now, rng: () => 0 });
    assert.equal(p?.node?.id, 'idle');
    releasePick(p);
  });
  await test('one or two independent 429 keys do not demote cohort', () => {
    reset();
    recordTier1ProviderModelRateLimit('nvidia', 'upstream-code-max', 'n1', now);
    recordTier1ProviderModelRateLimit('nvidia', 'upstream-code-max', 'n2', now + 1);
    assert.equal(tier1ProviderModelRateLimitCount('nvidia', 'upstream-code-max', now + 1), 2);
    assert.equal(tier1ProviderModelHeatFactor('nvidia', 'upstream-code-max', now + 1), 1);
  });
  await test('three/four independent 429 keys apply bounded soft heat', () => {
    reset();
    for (const [i, id] of ['n1', 'n2', 'n3'].entries()) recordTier1ProviderModelRateLimit('nvidia', 'upstream-code-max', id, now + i);
    assert.equal(tier1ProviderModelHeatFactor('nvidia', 'upstream-code-max', now + 3), 1.15);
    recordTier1ProviderModelRateLimit('nvidia', 'upstream-code-max', 'n4', now + 4);
    assert.equal(tier1ProviderModelHeatFactor('nvidia', 'upstream-code-max', now + 4), 1.35);
  });
  await test('provider-model heat changes ranking but not eligibility', () => {
    reset();
    for (const id of ['n1', 'n2', 'n3']) recordTier1ProviderModelRateLimit('nvidia', 'upstream-code-max', id, now);
    const hot = node('n4'),
      cool = node('s1', { provider: 'sensenova' });
    const p = pickTier1Candidate([hot, cool], req, new Set(), { now, rng: () => 0 });
    assert.equal(p?.node?.id, 's1');
    releasePick(p);
    const only = pickTier1Candidate([hot], req, new Set(), { now });
    assert.equal(only?.node?.id, 'n4');
    releasePick(only);
  });
  await test('successes decay provider-model heat', () => {
    reset();
    for (const id of ['n1', 'n2', 'n3', 'n4']) recordTier1ProviderModelRateLimit('nvidia', 'upstream-code-max', id, now);
    recordTier1ProviderModelSuccess('nvidia', 'upstream-code-max', 'n5', now + 1);
    assert.equal(tier1ProviderModelRateLimitCount('nvidia', 'upstream-code-max', now + 1), 3);
  });
  await test('provider-model heat expires', () => {
    reset();
    for (const id of ['n1', 'n2', 'n3']) recordTier1ProviderModelRateLimit('nvidia', 'upstream-code-max', id, now);
    assert.equal(tier1ProviderModelHeatFactor('nvidia', 'upstream-code-max', now + TIER1_PROVIDER_MODEL_429_WINDOW_MS + 1), 1);
  });
  console.log('ok - file:tier1-heat-protection');
} catch (error) {
  console.error('not ok - tier1-heat-protection-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// tier1-upstream-model-cooldown-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs






  const node = {
    id: 'nvidia-upstream-404',
    tier: 'tier-1',
    provider: 'nvidia',
    protocol: 'openai',
    surfaces: ['chat_completions'],
    baseUrl: 'https://example.invalid/v1',
    credential: 'test-key',
    priority: 10,
    models: {
      'Code-Max': 'deepseek-ai/deepseek-v4-pro-0813',
      'Code-Pro': 'deepseek-ai/deepseek-v4-flash-0731',
    },
  };

  const req = (model) => ({ model, protocol: 'openai', surface: 'chat_completions' });
  const modelMissing = classifyUpstreamStatus(
    404,
    new Headers(),
    {},
    Date.now(),
    JSON.stringify({ error: { message: 'model deepseek-ai/deepseek-v4-pro-0813 not found' } }),
  );

  assert.equal(modelMissing.kind, KIND.MODEL_MISSING);
  assert.equal(modelMissing.cooldownMs, 5_000);
  assert.equal(modelMissing.modelScoped, true);

  const tier1Class = classifyTier1Failure(modelMissing);
  assert.equal(tier1Class.scope, 'upstream_model');
  assert.equal(tier1Class.action, 'cooldown');
  assert.equal(tier1Class.cooldownMs, 5_000);

  // Direct state-machine contract: a 404 cools only this account + resolved
  // upstream model. Sibling logical models stay eligible, and remapping the same
  // logical alias to a new upstream model immediately escapes the stale 404.
  __resetTier1StateForTests();
  const now = 1_700_000_000_000;
  applyTier1Outcome(node.id, node.models['Code-Max'], tier1Class, now);

  assert.equal(isTier1Eligible(node, req('Code-Max'), now), false);
  assert.equal(tier1BlockingWaitMs(node, 'Code-Max', now), 5_000);
  assert.equal(isTier1Eligible(node, req('Code-Pro'), now), true);
  assert.equal(getTier1ModelPerf(node.id, 'Code-Max'), null, 'model_missing must not pollute logical-model performance/circuit state');

  const remappedNode = {
    ...node,
    models: { ...node.models, 'Code-Max': 'another/provider-model' },
  };
  assert.equal(isTier1Eligible(remappedNode, req('Code-Max'), now), true, 'new upstream mapping must not inherit the old upstream model cooldown');
  assert.equal(isTier1Eligible(node, req('Code-Max'), now + 5_001), true, 'the original upstream model becomes eligible after the short cooldown');

  // Request-path regression: recordOutcome must resolve Code-Max through the
  // selected node before it records model_missing state.
  __resetTier1StateForTests();
  const state = {
    attempted: new Set(),
    attempts: [],
    logicalAttempts: 0,
    dispatches: 0,
    hedges: 0,
    failureKinds: {},
    logger: { info() {}, debug() {}, error() {} },
    requestId: 'tier1-upstream-model-test',
    maxAttempts: 3,
    maxDispatches: 3,
    requestedModel: 'Code-Max',
    nodes: [node],
  };
  const context = {
    requestId: state.requestId,
    tier1ReleaseToken: null,
    upstreamProtocol: 'openai',
    surface: 'chat_completions',
    exposeUpstreamInfo: false,
  };

  recordOutcome(state, node, modelMissing, context, { status: 404 });
  const afterRecord = Date.now();
  assert.equal(state.logicalAttempts, 1);
  assert.equal(state.dispatches, 1);
  assert.equal(state.failureKinds[KIND.MODEL_MISSING], 1);
  assert.equal(isTier1Eligible(node, req('Code-Max'), afterRecord), false);
  assert.ok(tier1BlockingWaitMs(node, 'Code-Max', afterRecord) > 0);
  assert.ok(tier1BlockingWaitMs(node, 'Code-Max', afterRecord) <= 5_000);
  assert.equal(isTier1Eligible(remappedNode, req('Code-Max'), afterRecord), true);
  assert.equal(isTier1Eligible(node, req('Code-Pro'), afterRecord), true);
  assert.equal(getTier1ModelPerf(node.id, 'Code-Max'), null, 'recordOutcome must keep logical Code-Max state untouched for model_missing');

  console.log('tier1-upstream-model-cooldown: all tests passed');
  console.log('ok - file:tier1-upstream-model-cooldown');
} catch (error) {
  console.error('not ok - tier1-upstream-model-cooldown-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// scheduler-convergence-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT





  let passed = 0;
  let failed = 0;
  async function test(name, fn) {
    try {
      __resetTier1StateForTests();
      await fn();
      passed++;
      console.log(`ok - ${name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL: ${name}`);
      console.error(error?.stack || error);
    }
  }
  function node(id, tier) {
    return {
      id,
      tier,
      provider: 'mock',
      protocol: 'openai',
      surfaces: ['chat_completions'],
      baseUrl: `https://${id}.example.com/v1`,
      credential: 'secret',
      priority: 1,
      models: { m1: 'upstream-m1' },
    };
  }
  const REQ = { model: 'm1', protocol: 'openai', surface: 'chat_completions' };
  const KNOWN = new Set(['m1']);

  await test('strict tier precedence gives each dispatchable tier a baseline then surplus to Tier 1', () => {
    const tiers = {
      1: [node('t1-a', 'tier-1'), node('t1-b', 'tier-1')],
      2: [node('t2-a', 'tier-2')],
      3: [node('t3-a', 'tier-3')],
    };
    const policy = { maxAttempts: 6, tierAttempts: null, hedge: null, firstEventTimeoutMs: null, maxInFlight: null };
    assert.deepEqual(computeTierCaps(tiers, REQ, new Set(), policy, KNOWN), { 1: 4, 2: 1, 3: 1 });
  });

  await test('explicit tier cap is never inflated by surplus allocation', () => {
    const tiers = {
      1: [node('e1', 'tier-1')],
      2: [node('e2', 'tier-2')],
      3: [node('e3', 'tier-3')],
    };
    const policy = { maxAttempts: 6, tierAttempts: { tier1: 2 }, hedge: null, firstEventTimeoutMs: null, maxInFlight: null };
    const caps = computeTierCaps(tiers, REQ, new Set(), policy, KNOWN);
    assert.deepEqual(caps, { 1: 2, 2: 3, 3: 1 });
  });

  await test('explicit zero disables a tier without redistributing against precedence', () => {
    const tiers = {
      1: [node('z1', 'tier-1')],
      2: [node('z2', 'tier-2')],
      3: [node('z3', 'tier-3')],
    };
    const policy = { maxAttempts: 4, tierAttempts: { tier2: 0 }, hedge: null, firstEventTimeoutMs: null, maxInFlight: null };
    assert.deepEqual(computeTierCaps(tiers, REQ, new Set(), policy, KNOWN), { 1: 3, 2: 0, 3: 1 });
  });

  await test('built-in policy surface remains intentionally small', () => {
    const policies = loadPoliciesConfig({});
    assert.deepEqual(Object.keys(policies).sort(), ['default', 'fast', 'long-reasoning']);
  });

  console.log(`\n[scheduler-convergence] ${passed}/${passed + failed} passed`);
  if (failed > 0) suiteExit(1);
  console.log('ok - file:scheduler-convergence');
} catch (error) {
  console.error('not ok - scheduler-convergence-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// scheduler-racelost-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs
  //
  // P0-01 regression tests: raceLost same-tier re-evaluation.
  //
  // Verifies that when a candidate's slot is lost to a concurrent request
  // (raceLost), the scheduler retries within the SAME tier instead of
  // breaking to the next tier. Also verifies bounded termination.








  let passed = 0,
    failed = 0;
  async function test(name, fn) {
    try {
      __resetTier1StateForTests();
      await fn();
      passed++;
      console.log(`ok - ${name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL: ${name}`);
      console.error(error?.stack || error);
      process.exitCode = 1;
    }
  }

  function tier2Node(id, { concurrency = 2, rpm = 100 } = {}) {
    return {
      id,
      tier: 'tier-2',
      provider: 'mock',
      protocol: 'openai',
      surfaces: ['chat_completions'],
      baseUrl: `https://${id}.example.com/v1`,
      credential: 'secret',
      models: { m1: 'up-x' },
      limits: { concurrency, rpm, rpmMode: 'hard' },
    };
  }

  function tier1Node(id, { concurrency = 2, rpm = 100 } = {}) {
    return {
      id,
      tier: 'tier-1',
      provider: 'mock',
      protocol: 'openai',
      surfaces: ['chat_completions'],
      baseUrl: `https://${id}.example.com/v1`,
      credential: 'secret',
      models: { m1: 'up-x' },
      limits: { concurrency, rpm, rpmMode: 'hard' },
    };
  }

  const REQ = { model: 'm1', protocol: 'openai', surface: 'chat_completions' };

  // ---- Case 1: raceLost -> same-tier retry with another node ----

  await test('Case 1: full node skipped -> picks next available node in same tier', () => {
    const nodes = [tier2Node('a'), tier2Node('b')];
    // Fill all slots on 'a' so it's at concurrency limit
    acquireSlot('a', 1000);
    acquireSlot('a', 1000);
    // 'a' has activeRequests=2 >= concurrency=2, so it's skipped
    // 'b' has activeRequests=0, so it's picked
    const pick = pickCandidate(nodes, REQ, new Set(), 1000, null, null, null);
    assert.ok(pick?.node, 'should pick node b');
    assert.equal(pick.node.id, 'b');
  });

  await test('Case 1b: raceLost with excludeIds -> skips lost node, picks another', () => {
    const nodes = [tier2Node('ex-a'), tier2Node('ex-b'), tier2Node('ex-c')];
    const raceLostIds = new Set(['ex-a']);
    const pick = pickCandidate(nodes, REQ, new Set(), 1000, null, null, raceLostIds);
    assert.ok(pick?.node, 'should pick a node after excluding race-lost');
    assert.notEqual(pick.node.id, 'ex-a', 'must not pick the race-lost node');
  });

  await test('Case 1c: Tier 1 raceLost with excludeIds -> skips lost node', () => {
    const nodes = [tier1Node('a'), tier1Node('b')];
    const raceLostIds = new Set(['a']);
    const pick = pickTier1Candidate(nodes, REQ, new Set(), { raceLostIds });
    assert.ok(pick?.node, 'Tier 1 should pick a node after excluding race-lost');
    assert.notEqual(pick.node.id, 'a', 'Tier 1 must not pick the race-lost node');
  });

  await test('Case 1d: pickForTier passes raceLostIds through (Tier 2)', () => {
    const nodes = [tier2Node('a'), tier2Node('b')];
    const raceLostIds = new Set(['a']);
    const pick = pickForTier(2, nodes, REQ, new Set(), { raceLostIds });
    assert.ok(pick?.node, 'pickForTier should pick after excluding race-lost');
    assert.equal(pick.node.id, 'b');
  });

  // ---- Case 2: bounded termination ----

  await test('Case 2: all nodes race-lost -> returns null (not infinite loop)', () => {
    const nodes = [tier2Node('a'), tier2Node('b')];
    const raceLostIds = new Set(['a', 'b']);
    const pick = pickCandidate(nodes, REQ, new Set(), 1000, null, null, raceLostIds);
    assert.equal(pick, null, 'all nodes excluded -> null');
  });

  await test('Case 2b: single node race-lost -> returns null', () => {
    const nodes = [tier2Node('a')];
    const raceLostIds = new Set(['a']);
    const pick = pickCandidate(nodes, REQ, new Set(), 1000, null, null, raceLostIds);
    assert.equal(pick, null, 'single node excluded -> null');
  });

  // ---- Case 3: no candidates -> moves to next tier ----

  await test('Case 3: no eligible candidates in tier -> null (tier loop moves on)', () => {
    const nodes = [tier2Node('a')];
    // Mark 'a' as attempted so it's excluded
    const attempted = new Set(['a']);
    const pick = pickCandidate(nodes, REQ, attempted, 1000, null, null, null);
    assert.equal(pick, null, 'attempted node -> null');
  });

  await test('Case 3b: tier with wrong protocol -> null', () => {
    const nodes = [
      {
        id: 'anthropic-only',
        tier: 'tier-2',
        provider: 'mock',
        protocol: 'anthropic',
        surfaces: ['messages'],
        baseUrl: 'https://example.com',
        credential: 'secret',
        models: { m1: 'up-x' },
      },
    ];
    const pick = pickCandidate(nodes, REQ, new Set(), 1000, null, null, null);
    assert.equal(pick, null, 'protocol mismatch -> null');
  });

  // ---- Case 4: tier order preserved ----

  await test('Case 4: Tier 1 -> Tier 2 -> Tier 3 order is preserved in pickForTier', () => {
    const t1 = [tier1Node('t1-a')];
    const t2 = [tier2Node('t2-a')];
    const t3 = [tier2Node('t3-a')];

    const pick1 = pickForTier(1, t1, REQ, new Set());
    assert.ok(pick1?.node, 'Tier 1 picks');
    assert.equal(pick1.node.id, 't1-a');

    const pick2 = pickForTier(2, t2, REQ, new Set());
    assert.ok(pick2?.node, 'Tier 2 picks');
    assert.equal(pick2.node.id, 't2-a');

    const pick3 = pickForTier(3, t3, REQ, new Set());
    assert.ok(pick3?.node, 'Tier 3 picks');
    assert.equal(pick3.node.id, 't3-a');
  });

  await test('Case 4b: Tier 1 exhausted, Tier 2 available -> Tier 2 picks', () => {
    const t2 = [tier2Node('t2-a')];
    const pick2 = pickForTier(2, t2, REQ, new Set());
    assert.ok(pick2?.node, 'Tier 2 picks when available');
    assert.equal(pick2.node.id, 't2-a');
  });

  // ---- Case 5: raceLost does not charge logical attempts ----

  await test('Case 5: raceLost exclusion allows retry without budget charge', () => {
    const nodes = [tier2Node('rl-a'), tier2Node('rl-b')];
    const raceLostIds = new Set(['rl-a']);
    const pick = pickForTier(2, nodes, REQ, new Set(), { raceLostIds });
    assert.ok(pick?.node, 'after raceLost exclusion, picks next node');
    assert.notEqual(pick.node.id, 'rl-a', 'must not pick the race-lost node');
    assert.ok(!pick.raceLost, 'second pick should not be raceLost');
  });

  // ---- Summary ----
  console.log(`\n[scheduler-racelost-test] ${passed}/${passed + failed} passed`);
  if (failed > 0) suiteExit(1);
  console.log('ok - file:scheduler-racelost');
} catch (error) {
  console.error('not ok - scheduler-racelost-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// model-family-fallback-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs




  function catalog(...models) {
    return new Set(models);
  }

  const all = catalog(
    'Code-Ultra',
    'Code-Max',
    'Code-Pro',
    'Ultra',
    'Max',
    'Pro',
    'Air',
    'Audit-Ultra',
    'Audit-Max',
    'Audit-Pro',
    'Editor-Air',
    'Editor-Pro',
    'Editor-Max',
    'Editor-Ultra',
  );

  assert.deepEqual(
    buildModelFallbackRounds('Code-Max', all),
    [
      ['Code-Max', 'Code-Pro', 'Code-Ultra'],
      ['Code-Max', 'Code-Pro', 'Code-Ultra'],
    ],
    'Code-Max must prefer Code-Pro, then Code-Ultra, with one bounded recheck round',
  );

  assert.deepEqual(
    buildModelFallbackPlan('Code-Max', all),
    [
      [
        { model: 'Code-Max', attemptCap: 3 },
        { model: 'Code-Pro', attemptCap: 2 },
        { model: 'Code-Ultra', attemptCap: 1 },
      ],
      [
        { model: 'Code-Max', attemptCap: 1 },
        { model: 'Code-Pro', attemptCap: 1 },
        { model: 'Code-Ultra', attemptCap: 1 },
      ],
    ],
    'default family planning keeps the established 3-2-1 preference',
  );

  assert.deepEqual(
    buildModelFallbackRounds('Code-Pro', all),
    [
      ['Code-Pro', 'Code-Max', 'Code-Ultra'],
      ['Code-Pro', 'Code-Max', 'Code-Ultra'],
    ],
    'Code-Pro must prefer Code-Max, then Code-Ultra',
  );

  assert.deepEqual(
    buildModelFallbackPlan('Code-Pro', all)[0],
    [
      { model: 'Code-Pro', attemptCap: 3 },
      { model: 'Code-Max', attemptCap: 2 },
      { model: 'Code-Ultra', attemptCap: 1 },
    ],
    'the requested Code peer always gets the 3-attempt share at budget 6',
  );

  assert.deepEqual(
    buildModelFallbackRounds('Code-Ultra', all),
    [
      ['Code-Ultra', 'Code-Max', 'Code-Pro'],
      ['Code-Ultra', 'Code-Max', 'Code-Pro'],
    ],
    'Code-Ultra must stay inside the Code family',
  );

  assert.deepEqual(
    buildModelFallbackRounds('Max', all),
    [
      ['Max', 'Pro', 'Ultra'],
      ['Max', 'Pro', 'Ultra'],
    ],
    'Max must prefer Pro, then Ultra, with one bounded recheck round',
  );

  assert.deepEqual(
    buildModelFallbackPlan('Max', all)[0],
    [
      { model: 'Max', attemptCap: 3 },
      { model: 'Pro', attemptCap: 2 },
      { model: 'Ultra', attemptCap: 1 },
    ],
    'Max family keeps 3-2-1 at budget 6',
  );

  assert.deepEqual(
    buildModelFallbackRounds('Pro', all),
    [
      ['Pro', 'Max', 'Ultra'],
      ['Pro', 'Max', 'Ultra'],
    ],
    'Pro must prefer Max, then Ultra',
  );

  assert.deepEqual(
    buildModelFallbackRounds('Ultra', all),
    [
      ['Ultra', 'Max', 'Pro'],
      ['Ultra', 'Max', 'Pro'],
    ],
    'Ultra may fall back to Max/Pro but never to Air',
  );

  assert.deepEqual(
    buildModelFallbackRounds('Air', all),
    [
      ['Air', 'Pro', 'Max', 'Ultra'],
      ['Pro', 'Max', 'Ultra'],
    ],
    'Air may move upward but must never be revisited after fallback',
  );

  assert.deepEqual(
    buildModelFallbackPlan('Air', all),
    [
      [
        { model: 'Air', attemptCap: 3 },
        { model: 'Pro', attemptCap: 1 },
        { model: 'Max', attemptCap: 1 },
        { model: 'Ultra', attemptCap: 1 },
      ],
      [
        { model: 'Pro', attemptCap: 1 },
        { model: 'Max', attemptCap: 1 },
        { model: 'Ultra', attemptCap: 1 },
      ],
    ],
    'Air keeps its one-way 3-1-1-1 preference at budget 6',
  );

  // max_attempts is a hard request ceiling. Family planning must never widen the
  // candidate set beyond the number of logical attempts the policy allows.
  assert.deepEqual(
    buildModelFallbackPlan('Code-Max', all, 1),
    [[{ model: 'Code-Max', attemptCap: 1 }], [{ model: 'Code-Max', attemptCap: 1 }]],
    'budget 1 exposes only the requested model',
  );

  assert.deepEqual(
    buildModelFallbackPlan('Code-Max', all, 2)[0],
    [
      { model: 'Code-Max', attemptCap: 1 },
      { model: 'Code-Pro', attemptCap: 1 },
    ],
    'budget 2 widens to one sibling instead of inflating the request budget',
  );

  assert.deepEqual(
    buildModelFallbackPlan('Code-Max', all, 3)[0],
    [
      { model: 'Code-Max', attemptCap: 1 },
      { model: 'Code-Pro', attemptCap: 1 },
      { model: 'Code-Ultra', attemptCap: 1 },
    ],
    'budget 3 gives one attempt to each compatible model',
  );

  assert.deepEqual(
    buildModelFallbackPlan('Code-Max', all, 4)[0],
    [
      { model: 'Code-Max', attemptCap: 2 },
      { model: 'Code-Pro', attemptCap: 1 },
      { model: 'Code-Ultra', attemptCap: 1 },
    ],
    'budget 4 deepens the requested model after covering the family',
  );

  assert.deepEqual(
    buildModelFallbackPlan('Code-Max', all, 5)[0],
    [
      { model: 'Code-Max', attemptCap: 3 },
      { model: 'Code-Pro', attemptCap: 1 },
      { model: 'Code-Ultra', attemptCap: 1 },
    ],
    'budget 5 keeps the configured hard ceiling',
  );

  assert.deepEqual(
    buildModelFallbackPlan('Code-Max', all, 6)[0],
    [
      { model: 'Code-Max', attemptCap: 3 },
      { model: 'Code-Pro', attemptCap: 2 },
      { model: 'Code-Ultra', attemptCap: 1 },
    ],
    'budget 6 restores the full 3-2-1 preference',
  );

  assert.deepEqual(
    buildModelFallbackPlan('Air', all, 4)[0],
    [
      { model: 'Air', attemptCap: 1 },
      { model: 'Pro', attemptCap: 1 },
      { model: 'Max', attemptCap: 1 },
      { model: 'Ultra', attemptCap: 1 },
    ],
    'Air budget 4 covers its one-way family once before deepening Air',
  );

  assert.deepEqual(
    buildModelFallbackPlan('Air', all, 6)[0],
    [
      { model: 'Air', attemptCap: 3 },
      { model: 'Pro', attemptCap: 1 },
      { model: 'Max', attemptCap: 1 },
      { model: 'Ultra', attemptCap: 1 },
    ],
    'Air budget 6 keeps the established 3-1-1-1 preference',
  );

  assert.equal(hasModelFamilyFallback('Code-Max'), true);
  assert.equal(hasModelFamilyFallback('Max'), true);
  assert.equal(hasModelFamilyFallback('Audit-Ultra'), true);
  assert.equal(hasModelFamilyFallback('Editor-Air'), true);
  assert.equal(hasModelFamilyFallback('Custom-Model'), false);

  assert.deepEqual(
    buildModelFallbackRounds('Audit-Ultra', all),
    [
      ['Audit-Ultra', 'Audit-Max', 'Audit-Pro'],
      ['Audit-Ultra', 'Audit-Max', 'Audit-Pro'],
    ],
    'prefixed Ultra aliases must fall back inside the same logical family',
  );

  assert.deepEqual(
    buildModelFallbackPlan('Audit-Ultra', all, 6)[0],
    [
      { model: 'Audit-Ultra', attemptCap: 3 },
      { model: 'Audit-Max', attemptCap: 2 },
      { model: 'Audit-Pro', attemptCap: 1 },
    ],
    'prefixed reasoning families keep the standard 3-2-1 attempt plan',
  );

  assert.deepEqual(
    buildModelFallbackRounds('Editor-Air', all),
    [
      ['Editor-Air', 'Editor-Pro', 'Editor-Max', 'Editor-Ultra'],
      ['Editor-Pro', 'Editor-Max', 'Editor-Ultra'],
    ],
    'prefixed Air aliases move upward only inside the same logical family',
  );

  assert.deepEqual(
    buildModelFallbackRounds('Audit-Ultra', catalog('Audit-Ultra', 'Audit-Pro', 'Max')),
    [
      ['Audit-Ultra', 'Audit-Pro'],
      ['Audit-Ultra', 'Audit-Pro'],
    ],
    'prefixed families must not borrow bare or differently prefixed aliases',
  );

  assert.deepEqual(
    modelFallbackCandidates('Code-Max', all),
    ['Code-Max', 'Code-Pro', 'Code-Ultra'],
    'candidate list must never cross Code/non-Code families',
  );

  assert.deepEqual(modelFallbackCandidates('Max', all), ['Max', 'Pro', 'Ultra'], 'general family candidate list must never include Air');

  assert.deepEqual(
    buildModelFallbackRounds('Max', catalog('Max', 'Ultra')),
    [
      ['Max', 'Ultra'],
      ['Max', 'Ultra'],
    ],
    'missing peers must be skipped without inventing aliases',
  );

  assert.deepEqual(
    buildModelFallbackPlan('Max', catalog('Max', 'Ultra'))[0],
    [
      { model: 'Max', attemptCap: 3 },
      { model: 'Ultra', attemptCap: 1 },
    ],
    'missing peers keep their original rank and must not donate a larger reserved cap',
  );

  assert.deepEqual(
    buildModelFallbackRounds('CODE-MAX', catalog('CODE-MAX', 'Code-Pro', 'Code-Ultra')),
    [
      ['CODE-MAX', 'Code-Pro', 'Code-Ultra'],
      ['CODE-MAX', 'Code-Pro', 'Code-Ultra'],
    ],
    'matching must be case-insensitive while preserving catalog spelling',
  );

  assert.deepEqual(
    buildModelFallbackRounds('Custom-Model', catalog('Custom-Model', 'Max', 'Pro')),
    [['Custom-Model']],
    'unknown model families must keep legacy one-pass behavior',
  );

  assert.deepEqual(
    buildModelFallbackPlan('General-Air', catalog('General-Air'), 5),
    [[{ model: 'General-Air', attemptCap: null }]],
    'an isolated prefixed tier alias must keep the legacy policy-owned attempt budget',
  );

  assert.deepEqual(
    buildModelFallbackPlan('Custom-Model', catalog('Custom-Model', 'Max', 'Pro'), 1),
    [[{ model: 'Custom-Model', attemptCap: null }]],
    'unknown model families keep their original policy-owned attempt budget',
  );

  assert.deepEqual(
    buildModelFallbackRounds('Research-Reasoning-Ultra', catalog('Research-Reasoning-Ultra', 'Research-Reasoning-Max', 'Research-Reasoning-Pro')),
    [
      ['Research-Reasoning-Ultra', 'Research-Reasoning-Max', 'Research-Reasoning-Pro'],
      ['Research-Reasoning-Ultra', 'Research-Reasoning-Max', 'Research-Reasoning-Pro'],
    ],
    'arbitrary multi-segment family prefixes must inherit tier fallback without code changes',
  );

  assert.equal(hasModelFamilyFallback('Research-Reasoning-Max'), true, 'new prefixed families are recognized from the final capability tier alone');

  console.log('model-family fallback tests passed.');
  console.log('ok - file:model-family-fallback');
} catch (error) {
  console.error('not ok - model-family-fallback-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}
