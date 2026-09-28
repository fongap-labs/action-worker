// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Merged suite. Each section below was a standalone suite and keeps its own scope:
//   - request-reliability-test.mjs
//   - attempt-budget-contract-test.mjs
//   - composed-capacity-contract-test.mjs
//   - request-execution-ownership-test.mjs
//   - upstream-processing-classification-test.mjs
//   - runtime-state-contract-test.mjs
//   - policy-default-reliability-test.mjs
//   - policy-max-in-flight-test.mjs

import { targetRoot as root } from '#kit/target.mjs';
import { loadModelsConfig } from '#target/src/config/models.ts';
import { getPoliciesConfigDiagnostics, getPolicy, loadPoliciesConfig } from '#target/src/config/policies.ts';
import { MIN_ATTEMPT_FIRST_EVENT_MS, MIN_ATTEMPT_HEADERS_MS, MIN_FAILOVER_RESERVE_MS, attemptBudgetSliceMs, attemptBudgetWindowMs, attemptFirstEventTimeoutMs, attemptHeadersTimeoutMs, getLimits, parseRetryAfterMs } from '#target/src/config/timeouts.ts';
import worker from '#target/src/index.ts';
import { gatewayStats } from '#target/src/observability/gateway-stats.ts';
import { __resetAdaptive429StateForTests } from '#target/src/reliability/adaptive-429.ts';
import { KIND, classifyClientAbort, classifyFirstEventFailure, classifyHedgeRaceLoss, classifyHedgeUnknown, classifyNetworkError, classifyNonJsonBody, classifyPostHeadersFailure, classifyPreDispatchInvalidBaseUrl, classifyStreamInterrupted, classifyUpstreamStatus } from '#target/src/reliability/classify.ts';
import { CIRCUIT_FAILURE_THRESHOLD, CIRCUIT_OPEN_MS, __resetAllStateForTests, acquireSlot, applyHealthPenalty, getCooldownRemainingMs, getNodeState, peekAvailability, recordFailure, recordNeutralEnd, recordSuccess, recordTtft } from '#target/src/reliability/node-state.ts';
import { nodeRuntimeStateStore, runtimeStateStoreFor, tier1RuntimeStateStore } from '#target/src/reliability/runtime-state-store.ts';
import { __resetTier1StateForTests, claimTier1Slot, makeTier1ReleaseToken, recordTier1QuotaReport, recordTier1Success, recordTier1Ttft, releaseTier1Slot, settleTier1Quota } from '#target/src/reliability/tier1-state.ts';
import { computeTierCaps } from '#target/src/request/tier-loop.ts';
import { countDispatchableNodes } from '#target/src/scheduler/scheduler.ts';
import { __resetTier1AffinityForTests } from '#target/src/scheduler/tier1-affinity.ts';
import { pickTier1Candidate } from '#target/src/scheduler/tier1-scheduler.ts';
import { collectOpenAIStreamObject } from '#target/src/stream/assemble.ts';
import { UPSTREAM_PROCESSING_ERROR, upstreamProcessingError, upstreamProcessingErrorCode } from '#target/src/types/upstream-processing.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ==========================================================================
// request-reliability-test.mjs
// ==========================================================================
try {
  // Request-reliability tests for node runtime state: live load accounting, cooldowns, circuit
  // breaker transitions, half-open single probe.







  const ENV = {};
  let now = 1_000_000;
  const tick = (ms) => { now += ms; };

  let passed = 0;
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (e) {
      console.error(`FAIL: ${name}`);
      console.error(e && e.stack || e);
      process.exitCode = 1;
    }
  }

  await test('slot accounting never leaks', async () => {
    const s = getNodeState('n1');
    assert.ok(acquireSlot('n1', now));
    assert.equal(s.activeRequests, 1);
    assert.ok(acquireSlot('n1', now));
    assert.equal(s.activeRequests, 2);
    recordNeutralEnd('n1');
    recordSuccess('n1', 10, now);
    assert.equal(s.activeRequests, 0);
  });

  await test('consecutive failures open circuit; interleaved success keeps it closed', async () => {
    // 503 success 503 success 503 -> CLOSED
    for (let i = 0; i < 2; i++) {
      acquireSlot('c1', now); tick(1);
      recordFailure('c1', { counted: true, cooldownMs: 100 }, now);
      acquireSlot('c1', now); tick(1);
      recordSuccess('c1', 5, now);
    }
    acquireSlot('c1', now); tick(1);
    recordFailure('c1', { counted: true, cooldownMs: 100 }, now);
    assert.equal(getNodeState('c1').circuitState, 'closed');

    // N consecutive failures -> OPEN
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      acquireSlot('c1', now); tick(1);
      recordFailure('c1', { counted: true, cooldownMs: 100 }, now);
    }
    assert.equal(getNodeState('c1').circuitState, 'open');
  });

  await test('half-open allows exactly one probe; probe failure reopens', async () => {
    const id = 'c2';
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      acquireSlot(id, now); tick(1);
      recordFailure(id, { counted: true, cooldownMs: 50 }, now);
    }
    assert.equal(peekAvailability(id, now), 'no');
    tick(CIRCUIT_OPEN_MS + 1);
    assert.equal(peekAvailability(id, now + 1), 'probe');
    assert.ok(acquireSlot(id, now + 1)); // becomes the probe
    assert.equal(getNodeState(id).probeInFlight, true);
    assert.equal(peekAvailability(id, now + 2), 'no'); // second concurrent request blocked
    tick(1);
    recordFailure(id, { counted: true, cooldownMs: 50 }, now + 3);
    assert.equal(getNodeState(id).circuitState, 'open'); // probe failed -> reopen
    tick(CIRCUIT_OPEN_MS + 5);
    assert.ok(acquireSlot(id, now));
    recordSuccess(id, 8, now);
    assert.equal(getNodeState(id).circuitState, 'closed');
    assert.equal(getNodeState(id).consecutiveFailures, 0);
  });

  await test('429 rotates with Retry-After but never opens the circuit', async () => {
    const id = 'r1';
    const headers = new Headers({ 'retry-after': '30' });
    const c = classifyUpstreamStatus(429, headers, ENV, now);
    assert.equal(c.action, 'rotate');
    assert.equal(c.cooldownMs, 30_000);
    assert.equal(c.counted, false);
    for (let i = 0; i < 10; i++) {
      acquireSlot(id, now); tick(1);
      recordFailure(id, { counted: c.counted, cooldownMs: c.cooldownMs }, now);
    }
    assert.equal(getNodeState(id).circuitState, 'closed');
    assert.ok(getCooldownRemainingMs(id, now) > 0);
  });

  await test('Retry-After supports seconds and HTTP-date, clamped', async () => {
    const h = (v) => new Headers({ 'retry-after': v });
    assert.equal(parseRetryAfterMs(h('700'), now), 600_000); // clamped to max
    assert.equal(parseRetryAfterMs(h('0'), now), 1_000); // clamped to min
    const future = new Date(now + 15_000).toUTCString();
    assert.ok(Math.abs(parseRetryAfterMs(h(future), now) - 15_000) < 2_000);
    assert.equal(parseRetryAfterMs(h('garbage'), now), 0);
  });

  await test('401/403 rotate with auth cooldown and do not count toward circuit', async () => {
    for (const status of [401, 403]) {
      const c = classifyUpstreamStatus(status, new Headers(), ENV, now);
      assert.equal(c.action, 'rotate');
      assert.equal(c.counted, false);
      assert.ok(c.cooldownMs >= 60_000);
    }
  });

  await test('400 rotates locally while hard client errors stop without penalty', async () => {
    const rejected = classifyUpstreamStatus(400, new Headers(), ENV, now);
    assert.equal(rejected.action, 'rotate');
    assert.equal(rejected.cooldownMs, 0);
    assert.equal(rejected.counted, false);
    for (const status of [413, 415, 422]) {
      const c = classifyUpstreamStatus(status, new Headers(), ENV, now);
      assert.equal(c.action, 'stop');
      assert.equal(c.cooldownMs, 0);
      assert.equal(c.counted, false);
    }
    const id = 'ce1';
    acquireSlot(id, now); tick(1);
    const before = getNodeState(id).healthScore;
    applyHealthPenalty(id, 'client');
    assert.equal(getNodeState(id).healthScore, before); // client kind has no penalty
    recordNeutralEnd(id);
  });

  await test('5xx failures are counted for the circuit without standalone cooldown', async () => {
    const c = classifyUpstreamStatus(503, new Headers(), ENV, now);
    assert.equal(c.action, 'rotate');
    assert.equal(c.counted, true);
    assert.equal(c.cooldownMs, 0); // circuit owns the open-period cooldown
  });

  await test('success resets consecutive failures and closes half-open', async () => {
    const id = 's1';
    acquireSlot(id, now); tick(1);
    recordSuccess(id, 20, now);
    assert.equal(getNodeState(id).consecutiveFailures, 0);
    assert.equal(getNodeState(id).avgLatencyMs, 20);
    acquireSlot(id, now); tick(1);
    recordSuccess(id, 40, now);
    assert.ok(Math.abs(getNodeState(id).avgLatencyMs - 26) < 1); // EWMA alpha .3
  });

  // ---- Half-open probe leak / resolution ------------------------------------
  // A probe that ends in a non-counted outcome (429 / 401 / 404 / neutral /
  // client abort) must release BOTH activeRequests AND probeInFlight, and the node
  // must become schedulable again. Regression for the stuck half-open bug.

  function openCircuitForProbe(id) {
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      acquireSlot(id, now); tick(1);
      recordFailure(id, { counted: true, cooldownMs: 50 }, now);
    }
    tick(CIRCUIT_OPEN_MS + 1);
    assert.equal(peekAvailability(id, now), 'probe');
    assert.ok(acquireSlot(id, now));
    const s = getNodeState(id);
    assert.equal(s.probeInFlight, true);
    assert.equal(s.activeRequests, 1);
  }

  await test('half-open probe -> 429 proves liveness and releases the probe, keeping the cooldown', async () => {
    const id = 'p429';
    openCircuitForProbe(id);
    const s = getNodeState(id);
    recordFailure(id, { counted: false, cooldownMs: 30_000, reason: 'rate_limit' }, now + 1);
    assert.equal(s.probeInFlight, false, 'probeInFlight must be released');
    assert.equal(s.activeRequests, 0, 'activeRequests must be released');
    assert.equal(s.circuitState, 'closed', 'a 429 during a probe must not keep half-open');
    assert.equal(s.consecutiveFailures, 0);
    assert.ok(getCooldownRemainingMs(id, now + 1) > 0, 'rate-limit cooldown must be kept');
    tick(35_000);
    assert.equal(peekAvailability(id, now), 'yes', 'node must be schedulable again after cooldown');
  });

  await test('half-open probe -> 401 recovers, keeps auth cooldown, no probe leak', async () => {
    const id = 'p401';
    openCircuitForProbe(id);
    recordFailure(id, { counted: false, cooldownMs: 3_600_000, reason: 'auth' }, now + 1);
    const s = getNodeState(id);
    assert.equal(s.probeInFlight, false);
    assert.equal(s.activeRequests, 0);
    assert.equal(s.circuitState, 'closed');
    assert.ok(getCooldownRemainingMs(id, now + 1) > 0);
  });

  await test('half-open probe -> 404 recovers, keeps model_missing cooldown, no probe leak', async () => {
    const id = 'p404';
    openCircuitForProbe(id);
    recordFailure(id, { counted: false, cooldownMs: 5_000, reason: 'model_missing' }, now + 1);
    const s = getNodeState(id);
    assert.equal(s.probeInFlight, false, '404 probe must not stay in flight');
    assert.equal(s.activeRequests, 0);
    assert.equal(s.circuitState, 'closed');
    assert.ok(getCooldownRemainingMs(id, now + 1) > 0, 'model_missing cooldown must be kept');
  });

  await test('half-open probe -> neutral end / client abort is not penalized and never stuck half-open', async () => {
    const id = 'pneut';
    openCircuitForProbe(id);
    const before = getNodeState(id).totalFailures; // 3 (from opening the circuit)
    recordNeutralEnd(id);
    const s = getNodeState(id);
    assert.equal(s.probeInFlight, false, 'neutral must release the probe');
    assert.equal(s.activeRequests, 0);
    assert.equal(s.circuitState, 'closed', 'neutral must recover from half-open');
    assert.equal(s.consecutiveFailures, 0);
    assert.equal(s.totalFailures, before, 'neutral must not add a failure');
    assert.equal(peekAvailability(id, now), 'yes', 'node must be immediately schedulable (no cooldown)');
  });

  await test('half-open probe -> counted failure releases the probe and reopens the circuit', async () => {
    const id = 'p5xx';
    openCircuitForProbe(id);
    recordFailure(id, { counted: true, cooldownMs: 0 }, now + 1);
    const s = getNodeState(id);
    assert.equal(s.probeInFlight, false, 'counted probe failure must release probeInFlight');
    assert.equal(s.activeRequests, 0);
    assert.equal(s.circuitState, 'open', 'counted probe failure must reopen the circuit');
    tick(CIRCUIT_OPEN_MS + 1);
    assert.equal(peekAvailability(id, now + 1), 'probe', 'node must be probe-ready again after the open period');
  });

  // ---- Per-attempt header-wait budget split -----------------------------------

  await test('one absolute attempt slice is shared by headers and first event', async () => {
    assert.equal(attemptBudgetSliceMs(240_000, 1), 240_000);
    assert.equal(attemptBudgetSliceMs(240_000, 2), 120_000);
    assert.equal(attemptBudgetSliceMs(240_000, 5), 48_000);
    assert.equal(attemptBudgetSliceMs(0, 5), 1, 'a timer never receives a zero delay');
    assert.equal(attemptBudgetSliceMs(60_000, 0), 60_000, 'degenerate attempt counts are clamped');
    // Headers and first-event are serial phases. After headers consume 18s of a
    // 48s attempt slice, the first-event guard can use only the 30s remainder.
    const attemptDeadline = 48_000;
    const afterHeaders = attemptDeadline - 18_000;
    assert.equal(attemptFirstEventTimeoutMs(120_000, afterHeaders, 1), 30_000);
  });

  await test('a single remaining attempt keeps the whole remaining budget (old behavior)', async () => {
    assert.equal(attemptHeadersTimeoutMs(120_000, 200_000, 1), 120_000);
    assert.equal(attemptHeadersTimeoutMs(120_000, 60_000, 1), 60_000, 'capped by remaining budget');
    assert.equal(attemptHeadersTimeoutMs(120_000, 500_000, 1), 120_000, 'capped by headers timeout');
  });

  await test('the budget is split evenly across remaining attempts', async () => {
    // Production-shaped case: 240s budget, 60s headers, 5 attempts -> 48s each;
    // a timing-out first node can no longer starve the rest.
    assert.equal(attemptHeadersTimeoutMs(60_000, 240_000, 5), 48_000);
    assert.equal(attemptHeadersTimeoutMs(120_000, 180_000, 2), 90_000, 'the old 120s+60s starvation pair becomes 90s+90s');
    // After an attempt is charged the share grows for the rest.
    assert.equal(attemptHeadersTimeoutMs(60_000, 192_000, 4), 48_000);
  });

  await test('the per-attempt floor protects viable slow upstreams, the budget caps extremes', async () => {
    // share (10s) below the floor -> floor wins, but never beyond the budget.
    assert.equal(attemptHeadersTimeoutMs(120_000, 50_000, 5), MIN_ATTEMPT_HEADERS_MS);
    // Remaining budget below the floor -> budget wins (no overshoot).
    assert.equal(attemptHeadersTimeoutMs(120_000, 8_000, 5), 8_000);
    assert.equal(attemptHeadersTimeoutMs(60_000, 0, 3), 1, 'degenerate remaining never schedules a 0ms timer');
    // A tight headers timeout dominates everything.
    assert.equal(attemptHeadersTimeoutMs(8_000, 240_000, 5), 8_000);
  });

  await test('degenerate attempt counts are clamped', async () => {
    assert.equal(attemptHeadersTimeoutMs(60_000, 240_000, 0), 60_000);
    assert.equal(attemptHeadersTimeoutMs(60_000, 240_000, -3), 60_000);
  });

  await test('first-event timeout is fairly shared across live attempts', async () => {
    assert.equal(attemptFirstEventTimeoutMs(120_000, 240_000, 1), 120_000);
    assert.equal(attemptFirstEventTimeoutMs(120_000, 240_000, 2), 120_000);
    assert.equal(attemptFirstEventTimeoutMs(120_000, 240_000, 5), 48_000);
    assert.equal(attemptFirstEventTimeoutMs(120_000, 10_000, 5), MIN_ATTEMPT_FIRST_EVENT_MS);
    assert.equal(attemptFirstEventTimeoutMs(120_000, 3_000, 5), 3_000, 'remaining budget caps the floor');
  });

  await test('timeout failures are classified as headers_timeout / first_event_timeout', async () => {
    // fetch never got HTTP status -> headers_timeout, counted for the circuit.
    const headers = classifyNetworkError(true);
    assert.equal(headers.kind, 'headers_timeout');
    assert.equal(headers.action, 'rotate');
    assert.equal(headers.counted, true);
    // plain network error keeps its own kind, also counted.
    const network = classifyNetworkError(false);
    assert.equal(network.kind, 'network');
    assert.equal(network.counted, true);
    // HTTP 200 received, but no valid SSE event -> first_event_timeout, counted.
    const firstEvent = classifyFirstEventFailure();
    assert.equal(firstEvent.kind, 'first_event_timeout');
    assert.equal(firstEvent.action, 'rotate');
    assert.equal(firstEvent.counted, true);
    // client abort stays a neutral, uncounted end of its own kind.
    const abort = classifyClientAbort();
    assert.equal(abort.kind, 'client_abort');
    assert.equal(abort.action, 'neutral');
    assert.equal(abort.counted, false);
  });

  await test('hedge defaults: 3000ms delay, 1 hedge per request, overridable', async () => {
    const defaults = getLimits(ENV);
    // Speed-first tightening: AIG_HEDGE_DELAY_MS default dropped 6000 -> 3000.
    // Hedge is also disabled by default through the built-in 'default' policy
    // (hedge.enabled=false); the raw env-var default is still 3000.
    assert.equal(defaults.hedgeDelayMs, 3_000, 'AIG_HEDGE_DELAY_MS default is 3000');
    assert.equal(defaults.maxHedgesPerRequest, 1, 'AIG_REQUEST_HEDGE_MAX default is 1');
    const overridden = getLimits({ AIG_HEDGE_DELAY_MS: '8000', AIG_REQUEST_HEDGE_MAX: '2' });
    assert.equal(overridden.hedgeDelayMs, 8_000);
    assert.equal(overridden.maxHedgesPerRequest, 2);
    // 0 disables hedging entirely but stays inside the clamped range.
    assert.equal(getLimits({ AIG_REQUEST_HEDGE_MAX: '0' }).maxHedgesPerRequest, 0);
    // Out-of-range values are clamped, not trusted.
    assert.equal(getLimits({ AIG_REQUEST_HEDGE_MAX: '99' }).maxHedgesPerRequest, 3);
    assert.equal(getLimits({ AIG_HEDGE_DELAY_MS: '-5' }).hedgeDelayMs, 0);
  });

  await test('dispatchable count keeps busy nodes as soft capacity', async () => {
    const makeNode = (id) => ({
      id, models: { m: 'upstream' }, priority: 10,
      protocol: 'openai', surfaces: ['chat_completions'],
    });
    const req = { model: 'm', protocol: 'openai', surface: 'chat_completions' };
    const nodes = [makeNode('live-count-a'), makeNode('live-count-b')];
    assert.equal(countDispatchableNodes(nodes, req, new Set(), now), 2);
    assert.equal(countDispatchableNodes(nodes, req, new Set(['live-count-a']), now), 1);
    acquireSlot('live-count-b', now);
    assert.equal(countDispatchableNodes(nodes, req, new Set(), now), 2,
      'configured concurrency is ranking-only; a busy node remains dispatchable');
    recordNeutralEnd('live-count-b');
  });

  // Reliability Core. The pre-dispatch, stream-interrupted,
  // hedge-race-loss, hedge-unknown, and non-json-body classifiers are
  // single-source-of-truth helpers. Their `counted`/`action`/cooldown must
  // match the budget-charging / rotation / circuit-breaker expectations of
  // the sites that call them (dispatch.ts, observability.ts, hedge.ts,
  // success.ts).
  await test('classifyPreDispatchInvalidBaseUrl: rotate, NOT counted, no cooldown (misconfig is operator-side)', async () => {
    const c = classifyPreDispatchInvalidBaseUrl();
    assert.equal(c.kind, KIND.INVALID_BASE_URL);
    assert.equal(c.action, 'rotate');
    assert.equal(c.cooldownMs, 0);
    assert.equal(c.counted, false, 'misconfigured nodes must NOT feed the circuit');
  });

  await test('classifyStreamInterrupted: rotate, counted, 60s cooldown (matches rate-limit cooldown)', async () => {
    const c = classifyStreamInterrupted();
    assert.equal(c.kind, KIND.STREAM_INTERRUPTED);
    assert.equal(c.action, 'rotate');
    assert.equal(c.counted, true, 'stream interruptions MUST feed the circuit breaker');
    assert.equal(c.cooldownMs, 60_000, '60s matches rate-limit cooldown so repeat offenders fall out without permanent discard');
  });

  await test('classifyHedgeRaceLoss: neutral, NOT counted (winner decides, loser is bookkeeping)', async () => {
    const c = classifyHedgeRaceLoss();
    assert.equal(c.kind, KIND.CANCELLED_AFTER_PEER_COMMIT);
    assert.equal(c.action, 'neutral');
    assert.equal(c.cooldownMs, 0);
    assert.equal(c.counted, false, 'hedge losers must NOT count against the winner');
  });

  await test('classifyHedgeUnknown: rotate, NOT counted (real reason will be re-classified by attemptNode)', async () => {
    const c = classifyHedgeUnknown();
    assert.equal(c.kind, KIND.UNKNOWN);
    assert.equal(c.action, 'rotate');
    assert.equal(c.cooldownMs, 0);
    assert.equal(c.counted, false);
  });

  await test('classifyNonJsonBody: rotate, counted, short cooldown', async () => {
    const c = classifyNonJsonBody();
    assert.equal(c.kind, KIND.NON_JSON_BODY);
    assert.equal(c.action, 'rotate');
    assert.equal(c.cooldownMs, 5_000);
    assert.equal(c.counted, true);
  });

  await test('every failure-kind consumer-facing value appears in KIND', async () => {
    // Pin the contract: the kind vocabulary is closed. The list below is the
    // exhaustive set of values that may appear on LoopState.failureKinds /
    // AttemptOutcome.kind / terminalStatus dispatch. New kinds require
    // editing KIND in src/reliability/classify.ts AND this test.
    const expected = [
      KIND.RATE_LIMIT, KIND.RATE_LIMIT_GLOBAL, KIND.AUTH, KIND.CLIENT,
      KIND.MODEL_MISSING, KIND.ENDPOINT_NOT_FOUND, KIND.SERVER, KIND.NETWORK,
      KIND.HEADERS_TIMEOUT, KIND.FIRST_EVENT_TIMEOUT, KIND.CLIENT_ABORT,
      KIND.INVALID_BASE_URL, KIND.STREAM_INTERRUPTED, KIND.NON_JSON_BODY,
      KIND.CANCELLED_AFTER_PEER_COMMIT, KIND.UNKNOWN,
    ];
    // Sanity: no duplicates.
    assert.equal(new Set(expected).size, expected.length, 'KIND values must be unique');
    // Each must round-trip through the union.
    for (const k of expected) assert.equal(typeof k, 'string');
  });

  if (!process.exitCode) console.log(`request reliability tests passed (${passed}).`);
  console.log('ok - file:request-reliability');
} catch (error) {
  console.error('not ok - request-reliability-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// attempt-budget-contract-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs
  //
  // Contract for reserve-aware request budgeting. The gateway should give the
  // preferred candidate a realistic first-output window while preserving a
  // bounded escape path for later failover candidates.







  const __dirname = dirname(fileURLToPath(import.meta.url));


  // Keep the equal-share primitive stable for callers/tests that explicitly need
  // it; the live dispatch path uses the reserve-aware allocator below.
  assert.equal(attemptBudgetSliceMs(60_000, 5), 12_000);
  assert.equal(attemptBudgetSliceMs(240_000, 5), 48_000);

  // Default production-shaped request: 60s budget / 5 possible attempts.
  // Old live behavior allowed only 12s. The new allocator reserves 5s for each
  // later candidate and gives the preferred candidate the remaining 40s.
  assert.equal(MIN_FAILOVER_RESERVE_MS, 5_000);
  assert.equal(attemptBudgetWindowMs(60_000, 5), 40_000);

  // long-reasoning shape: 60s request budget / 3 attempts -> 50s for the
  // preferred candidate, retaining 5s escape windows for two alternates.
  assert.equal(attemptBudgetWindowMs(60_000, 3), 50_000);

  // Once only one candidate remains it may use the whole remaining request
  // budget; unused time from earlier fast failures naturally carries forward.
  assert.equal(attemptBudgetWindowMs(37_000, 1), 37_000);

  // Tight budgets degrade to an equal split instead of starving the tail.
  assert.equal(attemptBudgetWindowMs(10_000, 5), 2_000);
  assert.equal(attemptBudgetWindowMs(15_000, 3), 5_000);
  assert.equal(attemptBudgetWindowMs(0, 5), 1);

  // Under the default 40s primary window, a healthy upstream returning headers
  // in 5s still receives the full configured 30s first-event wait. This is the
  // behavior the old 12s absolute slice prevented.
  assert.equal(attemptFirstEventTimeoutMs(30_000, 35_000, 1), 30_000);

  // If every candidate consumes its entire worst-case window, the reserve is
  // still usable in sequence rather than being consumed by the first attempt.
  let remaining = 60_000;
  for (let attempts = 5; attempts > 1; attempts--) {
    const window = attemptBudgetWindowMs(remaining, attempts);
    remaining -= window;
  }
  assert.equal(remaining, 5_000, 'the last candidate must retain its escape window');

  // Composition contract: real dispatch must use reserve-aware allocation; the
  // equal-share helper must not accidentally return to the live path during a
  // refactor. Hedge twins must continue inheriting the primary absolute deadline.
  const dispatchSource = readFileSync(join(root, 'src/request/attempt/dispatch.ts'), 'utf8');
  assert.match(dispatchSource, /attemptBudgetWindowMs\(remainingBudgetMs,\s*remainingDispatchableAttempts\)/,
    'dispatch must allocate reserve-aware attempt windows');
  assert.doesNotMatch(dispatchSource, /attemptBudgetSliceMs\(remainingBudgetMs,\s*remainingDispatchableAttempts\)/,
    'dispatch must not regress to equal-share request slicing');

  const hedgeSource = readFileSync(join(root, 'src/request/attempt/hedge.ts'), 'utf8');
  assert.match(hedgeSource, /attemptDeadlineMs:\s*primaryArgs\.attemptDeadlineMs/,
    'hedge twin must share the primary logical-attempt deadline');

  console.log('attempt budget contract tests passed.');
  console.log('ok - file:attempt-budget-contract');
} catch (error) {
  console.error('not ok - attempt-budget-contract-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// composed-capacity-contract-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs
  //
  // Cross-layer regression contract for explicit Tier 1 admission ceilings.
  // Unit tests for policy parsing and picker admission are not sufficient: every
  // orchestration path that selects/counts Tier 1 capacity must propagate the
  // same maxInFlight value. This suite locks the two composition points most
  // likely to regress: hedge twins and cross-protocol fallback tier-cap planning.









  const __dirname = dirname(fileURLToPath(import.meta.url));


  function source(path) {
    return readFileSync(join(root, path), 'utf8');
  }

  function node(id, protocol, surface) {
    return {
      id,
      tier: 'tier-1',
      provider: 'mock',
      protocol,
      surfaces: [surface],
      baseUrl: `https://${id}.example.com/v1`,
      credential: 'test-key',
      priority: 100,
      models: { 'general-air': 'upstream-model' },
    };
  }

  // --- Composition contract: hedge twin must inherit the primary policy cap. ---
  const hedgeSource = source('src/request/attempt/hedge.ts');
  const hedgeCallStart = hedgeSource.indexOf('pickTier1Candidate(tierNodes');
  assert.ok(hedgeCallStart >= 0, 'Tier 1 hedge picker call must exist');
  const hedgeCall = hedgeSource.slice(hedgeCallStart, hedgeCallStart + 1_200);
  assert.match(
    hedgeCall,
    /maxInFlight:\s*args\.policy\?\.maxInFlight\s*\?\?\s*null/,
    'Tier 1 hedge twin must propagate policy.maxInFlight to pickTier1Candidate',
  );

  // Prove why the propagated value matters: a saturated account is rejected when
  // the explicit cap is present, but would be admitted again if the caller drops it.
  __resetTier1StateForTests();
  const hedgeNode = node('hedge-cap', 'openai', 'chat_completions');
  const hedgeReq = { model: 'general-air', protocol: 'openai', surface: 'chat_completions' };
  assert.equal(claimTier1Slot(hedgeNode, Date.now(), hedgeReq.model, 1), true);
  const occupiedToken = makeTier1ReleaseToken(hedgeNode.id);
  assert.equal(
    pickTier1Candidate([hedgeNode], hedgeReq, new Set(), { maxInFlight: 1 }),
    null,
    'a saturated Tier 1 account must not be selectable when the explicit cap is propagated',
  );
  const uncappedPick = pickTier1Candidate([hedgeNode], hedgeReq, new Set(), { maxInFlight: null });
  assert.equal(uncappedPick?.node?.id, hedgeNode.id,
    'dropping maxInFlight would admit the saturated account and recreate the hedge bypass');
  assert.equal(releaseTier1Slot(hedgeNode.id, uncappedPick?.releaseToken), true);
  assert.equal(releaseTier1Slot(hedgeNode.id, occupiedToken), true);

  // --- Composition contract: protocol fallback capacity planning must use cap. ---
  const fallbackSource = source('src/request/fallback.ts');
  const fallbackCallStart = fallbackSource.indexOf('const fbTierCaps = computeTierCaps(');
  assert.ok(fallbackCallStart >= 0, 'protocol fallback tier-cap computation must exist');
  const fallbackCall = fallbackSource.slice(fallbackCallStart, fallbackCallStart + 700);
  assert.match(
    fallbackCall,
    /policy\.maxInFlight\s*\?\?\s*null/,
    'protocol fallback must propagate policy.maxInFlight into computeTierCaps',
  );

  __resetTier1StateForTests();
  const fallbackNode = node('fallback-cap', 'anthropic', 'messages');
  const fallbackReq = { model: 'general-air', protocol: 'anthropic', surface: 'messages' };
  assert.equal(claimTier1Slot(fallbackNode, Date.now(), fallbackReq.model, 1), true);
  const fallbackToken = makeTier1ReleaseToken(fallbackNode.id);
  const tiers = { 1: [fallbackNode], 2: [], 3: [] };
  const policy = { maxAttempts: 5, budgetSplit: 'even', tierAttempts: {} };
  const knownModels = new Set(['general-air']);
  const capped = computeTierCaps(tiers, fallbackReq, new Set(), policy, knownModels, 1);
  const uncapped = computeTierCaps(tiers, fallbackReq, new Set(), policy, knownModels, null);
  assert.equal(capped[1], 0,
    'fallback planning must assign zero Tier 1 attempts when every account is at the explicit cap');
  assert.ok(uncapped[1] > 0,
    'without the cap, the same fallback pool appears dispatchable, proving the composition bug is observable');
  assert.equal(releaseTier1Slot(fallbackNode.id, fallbackToken), true);

  console.log('composed capacity contract tests passed.');
  console.log('ok - file:composed-capacity-contract');
} catch (error) {
  console.error('not ok - composed-capacity-contract-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// request-execution-ownership-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs
  //
  // Cross-layer request-execution ownership contracts.









  const ACCESS_KEY = 'request-execution-ownership-test-key';
  let calls = [];

  function reset() {
    calls = [];
    __resetAllStateForTests();
    __resetTier1StateForTests();
    __resetTier1AffinityForTests();
    __resetAdaptive429StateForTests();
  }

  // These fixtures exercise /v1/responses, so the account declares provider
  // "openai" and receives its Responses capability from the provider registry.
  function configNode(id, tier, models, priority = 10) {
    return {
      id,
      provider: 'openai',
      base_url: `https://${id}.example.com/v1`,
      priority,
      models,
      __tier: tier,
    };
  }

  function envFor(nodes, extra = {}) {
    const env = {
      AIG_ACCESS_KEY_ULTRA: ACCESS_KEY,
      AIG_ACCESS_MODELS_ULTRA: '*',
      AIG_PROTOCOL_FALLBACKS: 'disable',
      TIER1_SCHEDULER_SEED: 'request-execution-ownership',
      ...extra,
    };
    for (const tier of [1, 2, 3]) {
      const tierNodes = nodes.filter((node) => node.__tier === tier);
      if (!tierNodes.length) continue;
      env[`AIG_TIER${tier}_NODES_01`] = JSON.stringify(tierNodes.map(({ __tier, ...node }) => node));
      env[`AIG_TIER${tier}_CREDENTIALS_01`] = JSON.stringify(
        Object.fromEntries(tierNodes.map((node) => [node.id, `secret-${node.id}`])),
      );
    }
    return env;
  }

  function responsesRequest(model, stream = false) {
    return new Request('https://gateway.example.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
      body: JSON.stringify({ model, input: 'continue the task', stream }),
    });
  }

  function completedResponsesObject(model, text = 'ok') {
    return {
      id: `resp_${model.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
      object: 'response', status: 'completed', model,
      output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }],
      usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
    };
  }

  function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  function hangingSseHeaders() {
    return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    });
  }

  function hangingErrorBody(status = 503) {
    return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), {
      status, headers: { 'content-type': 'application/json' },
    });
  }

  function installFetch(routes) {
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const body = init?.body ? JSON.parse(init.body) : {};
      calls.push({ host: url.hostname, model: body.model });
      const handler = routes[url.hostname];
      if (!handler) throw new Error(`no mock upstream for ${url.hostname}`);
      return handler({ url, init, body });
    };
  }

  async function withDeadline(promise, ms, label) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  reset();
  const codeMax = configNode('family-max', 1, { 'Code-Max': 'real-max' });
  const codePro = configNode('family-pro', 1, { 'Code-Pro': 'real-pro' });
  installFetch({
    'family-max.example.com': () => hangingSseHeaders(),
    'family-pro.example.com': () => jsonResponse(completedResponsesObject('real-pro', 'sibling recovered')),
  });
  const familyEnv = envFor([codeMax, codePro], {
    AIG_FAILOVER_BUDGET_MS: '1000',
    AIG_MODELS_CONFIG: JSON.stringify({ 'Code-Max': { policy: 'default' }, 'Code-Pro': { policy: 'default' } }),
    AIG_POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 2, hedge: { enabled: false } } }),
  });
  const familyStarted = Date.now();
  const familyResponse = await withDeadline(worker.fetch(responsesRequest('Code-Max', true), familyEnv, {}), 1800, 'family failover request');
  assert.equal(familyResponse.status, 200, 'a sibling model must still receive wall-clock budget after the preferred model stalls');
  const familyText = await withDeadline(familyResponse.text(), 1000, 'family synthesized stream drain');
  assert.match(familyText, /sibling recovered/);
  assert.ok(Date.now() - familyStarted < 1800);
  assert.deepEqual(calls.map((c) => c.host), ['family-max.example.com', 'family-pro.example.com']);

  reset();
  const badTier2 = configNode('tier2-stall', 2, { Solo: 'solo-upstream' }, 1);
  const goodTier2 = configNode('tier2-good', 2, { Solo: 'solo-upstream' }, 2);
  installFetch({
    'tier2-stall.example.com': () => hangingErrorBody(503),
    'tier2-good.example.com': () => jsonResponse(completedResponsesObject('solo-upstream', 'fallback node succeeded')),
  });
  const errorBodyEnv = envFor([badTier2, goodTier2], {
    AIG_FAILOVER_BUDGET_MS: '1000',
    AIG_MODELS_CONFIG: JSON.stringify({ Solo: { policy: 'default' } }),
    AIG_POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 2, hedge: { enabled: false } } }),
  });
  const errorStarted = Date.now();
  const errorResponse = await withDeadline(worker.fetch(responsesRequest('Solo', false), errorBodyEnv, {}), 1800, 'non-ok diagnostic body failover');
  assert.equal(errorResponse.status, 200, 'a stalled 503 diagnostic body must time out inside the attempt and rotate');
  assert.match(await errorResponse.text(), /fallback node succeeded/);
  assert.ok(Date.now() - errorStarted < 1800);
  assert.deepEqual(calls.map((c) => c.host), ['tier2-stall.example.com', 'tier2-good.example.com']);

  reset();
  const synthNode = configNode('synth-json', 1, { SoloStream: 'solo-stream-upstream' });
  installFetch({ 'synth-json.example.com': () => jsonResponse(completedResponsesObject('solo-stream-upstream', 'synthetic stream')) });
  const synthEnv = envFor([synthNode], {
    AIG_MODELS_CONFIG: JSON.stringify({ SoloStream: { policy: 'default' } }),
    AIG_POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 1, hedge: { enabled: false } } }),
  });
  const activeBefore = gatewayStats.activeRequests;
  const successBefore = gatewayStats.successes;
  const cancelBefore = gatewayStats.cancellations;
  const synthResponse = await worker.fetch(responsesRequest('SoloStream', true), synthEnv, {});
  assert.equal(synthResponse.status, 200);
  assert.equal(gatewayStats.activeRequests, activeBefore + 1);
  const synthText = await synthResponse.text();
  assert.match(synthText, /synthetic stream/);
  assert.equal(gatewayStats.activeRequests, activeBefore);
  assert.equal(gatewayStats.successes, successBefore + 1);
  assert.equal(gatewayStats.cancellations, cancelBefore);

  const cancelActiveBefore = gatewayStats.activeRequests;
  const cancelSuccessBefore = gatewayStats.successes;
  const cancelCountBefore = gatewayStats.cancellations;
  const cancelResponse = await worker.fetch(responsesRequest('SoloStream', true), envFor([synthNode], {
    AIG_MODELS_CONFIG: JSON.stringify({ SoloStream: { policy: 'default' } }),
    AIG_POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 1, hedge: { enabled: false } } }),
  }), {});
  assert.equal(gatewayStats.activeRequests, cancelActiveBefore + 1);
  const cancelReader = cancelResponse.body.getReader();
  await cancelReader.cancel('test cancellation');
  assert.equal(gatewayStats.activeRequests, cancelActiveBefore);
  assert.equal(gatewayStats.cancellations, cancelCountBefore + 1);
  assert.equal(gatewayStats.successes, cancelSuccessBefore);

  console.log('request execution ownership tests passed.');
  console.log('ok - file:request-execution-ownership');
} catch (error) {
  console.error('not ok - request-execution-ownership-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// upstream-processing-classification-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs
  //
  // Post-header processing failures must describe WHAT failed in the producer
  // layer and let reliability/classify.ts decide HOW the node is treated.






  const cases = [
    [UPSTREAM_PROCESSING_ERROR.DEADLINE, KIND.FIRST_EVENT_TIMEOUT],
    [UPSTREAM_PROCESSING_ERROR.MALFORMED, KIND.NON_JSON_BODY],
    [UPSTREAM_PROCESSING_ERROR.TOO_LARGE, KIND.NON_JSON_BODY],
    [UPSTREAM_PROCESSING_ERROR.TRUNCATED, KIND.STREAM_INTERRUPTED],
    [UPSTREAM_PROCESSING_ERROR.EMPTY, KIND.EMPTY_200],
    [UPSTREAM_PROCESSING_ERROR.TERMINAL, KIND.SERVER],
  ];

  for (const [code, expectedKind] of cases) {
    const error = upstreamProcessingError(code, `test:${code}`);
    assert.equal(upstreamProcessingErrorCode(error), code);
    assert.equal(
      classifyPostHeadersFailure(error).kind,
      expectedKind,
      `${code} must map to ${expectedKind}`,
    );
  }

  assert.equal(
    classifyPostHeadersFailure(new SyntaxError('bad json')).kind,
    KIND.NON_JSON_BODY,
    'plain JSON.parse failures are structural upstream-body failures',
  );

  // Integration guard: the OpenAI stream assembler must emit a typed malformed
  // error instead of a generic Error whose message callers would need to parse.
  const malformed = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {not-json}\n\n'));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

  await assert.rejects(
    () => collectOpenAIStreamObject(malformed, null, Date.now() + 1000),
    (error) => upstreamProcessingErrorCode(error) === UPSTREAM_PROCESSING_ERROR.MALFORMED,
    'malformed SSE JSON must preserve a typed processing reason',
  );

  console.log('upstream processing classification tests passed.');
  console.log('ok - file:upstream-processing-classification');
} catch (error) {
  console.error('not ok - upstream-processing-classification-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// runtime-state-contract-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs
  //
  // Unified runtime-state interface contracts:
  //   - both backends (Tier 1 adaptive runtime, Tier 2/3 node state) satisfy
  //     the same RuntimeStateStore read contract
  //   - projections are honest: a field a backend does not track is null,
  //     never a fabricated value
  //   - unknown quota surfaces as 'unknown' (reactive path governs); reported
  //     quota surfaces as near_limit / exhausted
  //   - upper layers resolve state through runtimeStateStoreFor(node), never
  //     by importing backend internals per tier






  let passed = 0;
  function test(name, fn) {
    try { fn(); passed++; console.log(`ok - ${name}`); }
    catch (e) { console.error(`FAIL - ${name}`); console.error(e?.stack || e); process.exitCode = 1; }
  }

  test('both backends satisfy the same RuntimeStateStore contract', () => {
    for (const store of [tier1RuntimeStateStore, nodeRuntimeStateStore]) {
      assert.equal(typeof store.endpoint, 'function');
      assert.equal(typeof store.account, 'function');
      assert.equal(typeof store.model, 'function');
    }
    assert.equal(runtimeStateStoreFor({ tier: 'tier-1' }), tier1RuntimeStateStore);
    assert.equal(runtimeStateStoreFor({ tier: 'tier-2' }), nodeRuntimeStateStore);
    assert.equal(runtimeStateStoreFor({ tier: 'tier-3' }), nodeRuntimeStateStore);
  });

  test('tier-1 projection is honest: no fabricated health, endpoint circuit, or model latency', () => {
    __resetTier1StateForTests();
    const endpoint = tier1RuntimeStateStore.endpoint('a1');
    assert.equal(endpoint.availability, 'available');
    assert.equal(endpoint.circuit, null, 'tier 1 circuit state is model-scoped, not endpoint-scoped');
    assert.equal(endpoint.health, null, 'tier 1 has no numeric health score');
    assert.equal(endpoint.inFlight, 0);
    const account = tier1RuntimeStateStore.account('a1');
    assert.equal(account.quota.state, 'unknown', 'no provider report -> unknown quota');
    assert.equal(account.disabled, false);
    assert.equal(tier1RuntimeStateStore.model('a1', 'never-observed'), null,
      'unobserved model pairs surface null, not fabricated entries');
  });

  test('tier-1 projections reflect real state transitions end to end', () => {
    __resetTier1StateForTests();
    assert.equal(claimTier1Slot({ id: 'a2', tier: 'tier-1', provider: 'mock', protocol: 'openai', surfaces: ['chat_completions'], baseUrl: 'https://a2.example.com/v1', credential: 'k', priority: 10, models: { 'Code-Max': 'up' } }, 1000, 'Code-Max', null), true);
    const token = makeTier1ReleaseToken('a2');
    assert.equal(tier1RuntimeStateStore.account('a2').inFlight, 1);
    recordTier1Ttft('a2', 'Code-Max', 120, 1001);
    recordTier1Success('a2', 'Code-Max', 1002);
    settleTier1Quota('a2', token, 500);
    releaseTier1Slot('a2', token);
    const model = tier1RuntimeStateStore.model('a2', 'Code-Max');
    assert.equal(model.supported, true);
    assert.equal(model.failureState, 'normal');
    assert.equal(model.sampleCount, 1);
    assert.equal(model.ttftEwmaMs, 120);
    assert.equal(tier1RuntimeStateStore.account('a2').inFlight, 0);
    assert.equal(tier1RuntimeStateStore.account('a2').quota.state, 'unknown');
  });

  test('tier-1 quota projections surface near_limit, exhausted, and reset', () => {
    __resetTier1StateForTests();
    recordTier1QuotaReport('a3', { remainingRequests: 2, limitRequests: 100, resetAtMs: 90_000 }, 1000);
    assert.equal(tier1RuntimeStateStore.account('a3', 1001).quota.state, 'near_limit');
    assert.equal(tier1RuntimeStateStore.account('a3', 1001).quota.remainingRequests, 2);
    assert.equal(tier1RuntimeStateStore.account('a3', 1001).quota.source, null);
    recordTier1QuotaReport('a3', { remainingRequests: 0, resetAtMs: 90_000, source: 'subscription-window' }, 1002);
    const exhausted = tier1RuntimeStateStore.account('a3', 1003).quota;
    assert.equal(exhausted.state, 'exhausted');
    assert.equal(exhausted.source, 'subscription-window');
    // After the window rolls, the account returns to unknown quota.
    assert.equal(tier1RuntimeStateStore.account('a3', 90_001).quota.state, 'unknown');
  });

  test('tier-2/3 projections reflect node-state semantics without fabricating accounts', () => {
    __resetAllStateForTests();
    const endpoint = nodeRuntimeStateStore.endpoint('n1');
    assert.equal(endpoint.availability, 'available');
    assert.equal(endpoint.circuit, 'closed');
    assert.equal(endpoint.health, 50, 'tier 2/3 node state has a real numeric health score');
    assert.equal(nodeRuntimeStateStore.account('n1').disabled, false);
    assert.equal(nodeRuntimeStateStore.account('n1').quota.state, 'unknown', 'tier 2/3 has no per-account quota');
    assert.equal(nodeRuntimeStateStore.model('n1', 'unobserved'), null);

    acquireSlot('n1', 1000);
    assert.equal(nodeRuntimeStateStore.endpoint('n1').inFlight, 1);
    recordTtft('n1', 90, 'Solo', { source: 'passive' });
    recordSuccess('n1', 200, 'Solo', 1001);
    recordFailure('n1', { counted: true, cooldownMs: 500, reason: 'network' }, 1002);
    const after = nodeRuntimeStateStore.endpoint('n1', 1002);
    assert.equal(after.inFlight, 0);
    assert.equal(after.circuit, 'closed', 'one transient failure does not open the circuit');
    assert.equal(nodeRuntimeStateStore.model('n1', 'Solo').ttftEwmaMs, 90);
  });

  console.log(`[runtime-state-contract-test] ${passed} checks passed`);
  console.log('ok - file:runtime-state-contract');
} catch (error) {
  console.error('not ok - runtime-state-contract-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// policy-default-reliability-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT




  const builtins = loadPoliciesConfig({});
  assert.equal(builtins.fast.failoverBudgetMs, 60_000);
  assert.equal(builtins.fast.maxAttempts, 4);
  assert.equal(builtins['long-reasoning'].headersTimeoutMs, 60_000);
  assert.equal(builtins['long-reasoning'].firstEventTimeoutMs, 60_000);
  assert.equal(builtins['long-reasoning'].failoverBudgetMs, 180_000);
  assert.equal(builtins['long-reasoning'].maxAttempts, 6);

  const inferredModels = loadModelsConfig({
    AIG_MODELS_CONFIG: JSON.stringify({
      'Code-Air': {},
      'Code-Pro': {},
      'Code-Max': {},
      'Code-Ultra': {},
      Other: {},
    }),
  });

  assert.equal(getPolicy('Code-Air', inferredModels, builtins), builtins.fast);
  assert.equal(getPolicy('Code-Pro', inferredModels, builtins), builtins['long-reasoning']);
  assert.equal(getPolicy('Code-Max', inferredModels, builtins), builtins['long-reasoning']);
  assert.equal(getPolicy('Code-Ultra', inferredModels, builtins), builtins['long-reasoning']);
  assert.equal(getPolicy('Audit-Ultra', {}, builtins), builtins['long-reasoning']);
  assert.equal(getPolicy('Editor-Air', {}, builtins), builtins.fast);
  assert.equal(getPolicy('Other', inferredModels, builtins), builtins.default);

  const customPolicies = loadPoliciesConfig({
    AIG_POLICIES_CONFIG: JSON.stringify({
      review: { max_attempts: 4, headers_timeout_ms: 90000, failover_budget_ms: 240000, hedge: { enabled: false } },
    }),
  });
  const explicitModels = loadModelsConfig({
    AIG_MODELS_CONFIG: JSON.stringify({
      'Code-Pro': { policy: 'review' },
    }),
  });
  assert.equal(getPolicy('Code-Pro', explicitModels, customPolicies), customPolicies.review);
  assert.equal(getPolicy('Audit-Ultra', { 'Audit-Ultra': { catalog: {}, policy: { policy: 'fast' } } }, builtins), builtins.fast);
  assert.equal(customPolicies.review.headersTimeoutMs, 90_000);
  assert.equal(customPolicies.review.failoverBudgetMs, 240_000);

  const invalidEnv = {
    AIG_POLICIES_CONFIG: JSON.stringify({
      review: { max_attempts: 3, failover_budget_ms: 2000, headers_timeout_ms: 5000, first_event_timeout_ms: 5000 },
    }),
  };
  const invalidDiagnostics = getPoliciesConfigDiagnostics(invalidEnv);
  assert.ok(invalidDiagnostics.some((d) => d.includes('headers_timeout_ms') && d.includes('effective failover budget')));
  assert.ok(invalidDiagnostics.some((d) => d.includes('first_event_timeout_ms') && d.includes('effective failover budget')));

  console.log('policy default reliability tests passed.');
  console.log('ok - file:policy-default-reliability');
} catch (error) {
  console.error('not ok - policy-default-reliability-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// policy-max-in-flight-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Regression contract for policy-level Tier 1 admission ceilings.
  // The gateway must not invent a per-account concurrency ceiling by default;
  // operators may opt into one explicitly when they know the upstream contract.




  function policies(config) {
    const env = config === undefined ? {} : { AIG_POLICIES_CONFIG: JSON.stringify(config) };
    return loadPoliciesConfig(env);
  }

  assert.equal(policies().default.maxInFlight, null,
    'built-in default policy must not impose a guessed concurrency ceiling');
  assert.equal(policies().fast.maxInFlight, null,
    'built-in fast policy must not impose a guessed concurrency ceiling');
  assert.equal(policies()['long-reasoning'].maxInFlight, null,
    'built-in long-reasoning policy must not impose a guessed concurrency ceiling');

  assert.equal(policies({ custom: { max_attempts: 5 } }).custom.maxInFlight, null,
    'custom policy without max_in_flight must stay unlimited');
  assert.equal(policies({ default: { max_in_flight: 0 } }).default.maxInFlight, null,
    'max_in_flight=0 explicitly disables the ceiling');
  assert.equal(policies({ default: { max_in_flight: null } }).default.maxInFlight, null,
    'max_in_flight=null explicitly disables the ceiling');
  assert.equal(policies({ default: { max_in_flight: 4 } }).default.maxInFlight, 4,
    'positive max_in_flight remains an explicit operator admission ceiling');

  const badEnv = { AIG_POLICIES_CONFIG: JSON.stringify({ default: { max_in_flight: -1 } }) };
  const badDiags = getPoliciesConfigDiagnostics(badEnv);
  assert.ok(badDiags.some((d) => d.includes('max_in_flight must be a non-negative integer')),
    `invalid max_in_flight must be diagnosed, got ${JSON.stringify(badDiags)}`);
  assert.equal(loadPoliciesConfig(badEnv).default.maxInFlight, null,
    'invalid max_in_flight must never silently re-enable an arbitrary fallback ceiling');

  console.log('policy max_in_flight tests passed.');
  console.log('ok - file:policy-max-in-flight');
} catch (error) {
  console.error('not ok - policy-max-in-flight-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}
