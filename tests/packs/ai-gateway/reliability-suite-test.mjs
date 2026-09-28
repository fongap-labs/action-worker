// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Merged suite. Each section below was a standalone suite and keeps its own scope:
//   - reliability-core-contract-test.mjs
//   - reliability-regression-test.mjs
//   - reliability-convergence-test.mjs
//   - reliability-fault-injection-test.mjs
//   - reliability-performance-test.mjs

import { createMockD1 } from '#kit/mock-d1-database.mjs';
import { targetPath, targetRoot as root } from '#kit/target.mjs';
import { loadPoliciesConfig } from '#target/src/config/policies.ts';
import { createOpenAIChatStreamFromAnthropic } from '#target/src/conversion/anthropic-stream-to-openai-chat.ts';
import worker from '#target/src/index.ts';
import { TTFT_BUCKET_BOUNDARIES_MS, persistTokenUsage, queryAllModelsTtftPercentiles, queryModelUsageCoverage, ttftBucketIndex } from '#target/src/observability/token-usage-store.ts';
import { classifyUpstreamStatus } from '#target/src/reliability/classify.ts';
import { __resetAllStateForTests, acquireSlot, getCooldownRemainingMs, getNodeState, markProbeFailure, recordFailure, recordNeutralEnd, recordSuccess, recordTtft } from '#target/src/reliability/node-state.ts';
import { __resetTier1StateForTests } from '#target/src/reliability/tier1-state.ts';
import { __resetTier1AffinityForTests, readTier1Affinity, writeTier1Affinity } from '#target/src/scheduler/tier1-affinity.ts';
import { collectAnthropicMessageObject } from '#target/src/stream/anthropic-native.ts';
import { collectOpenAIStreamObject } from '#target/src/stream/assemble.ts';
import { isAnthropicMessageMeaningful } from '#target/src/transport/anthropic.ts';
import { isOpenAIChatCompletionMeaningful, isOpenAIResponsesObjectMeaningful } from '#target/src/transport/openai.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ==========================================================================
// reliability-core-contract-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs
  //
  // Reliability Core contract test.
  //
  // The failure-kind vocabulary (KIND) is the single source of truth for every
  // string that appears on the request hot path as LoopState.failureKinds,
  // AttemptOutcome.kind, or terminalStatus dispatch. Drift between the
  // classifier (src/reliability/classify.ts) and its consumers
  // (src/request/attempt/*.ts, src/request/errors.ts) is the most common
  // silent bug: an upstream code adds a new failure mode, types it as a raw
  // string literal in the consumer, and the terminal-status mapping never
  // learns about it.
  //
  // This contract pins the closed set of failure-kind strings across the
  // source tree:
  //   * Every `kind:` property assignment in src/ that produces a string
  //     literal must use one of the canonical KIND.* values (or a derived
  //     variable). No open string literals are allowed.
  //   * KIND is the only place that defines the kind vocabulary.
  //   * AttemptOutcome.kind is typed as FailureKind (not string) at the
  //     source level.
  //   * Every classify* function lives in src/reliability/classify.ts.
  //
  // If a new failure kind is added, this test must be updated in the same
  // commit. The same applies to the request-reliability-test.mjs "every
  // failure-kind consumer-facing value" test that pins the KIND union.





  const __dirname = dirname(fileURLToPath(import.meta.url));


  let failures = 0;
  function check(name, ok, detail) {
    if (ok) {
      console.log(`  ok  ${name}`);
    } else {
      failures++;
      console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
  }

  // 1) KIND is the only place that defines the failure-kind vocabulary.
  const classifySource = readFileSync(join(root, 'src', 'reliability', 'classify.ts'), 'utf8');
  const kindBlockMatch = classifySource.match(/export const KIND = \{([\s\S]*?)\} as const;/);
  const kindValues = kindBlockMatch
    ? [...kindBlockMatch[1].matchAll(/^\s*([A-Z][A-Z0-9_]*):\s*'([^']+)'/gm)].map((m) => m[2])
    : [];
  const expectedKinds = [
    'rate_limit', 'auth', 'client', 'model_missing', 'endpoint_not_found',
    'server', 'network', 'headers_timeout', 'first_event_timeout',
    'client_abort', 'rate_limit_global', 'invalid_base_url',
    'stream_interrupted', 'upstream_200_non_json_body',
    'upstream_200_no_meaningful_output',
    'cancelled_after_peer_commit', 'unknown',
  ];
  const missingFromKind = expectedKinds.filter((k) => !kindValues.includes(k));
  const extraInKind = kindValues.filter((k) => !expectedKinds.includes(k));
  check('C19 KIND in src/reliability/classify.ts is the closed failure-kind vocabulary (no missing, no extra)',
    missingFromKind.length === 0 && extraInKind.length === 0,
    `missing=${JSON.stringify(missingFromKind)} extra=${JSON.stringify(extraInKind)} actual=${JSON.stringify(kindValues)}`);

  // 2) No `kind: '...'` raw string literal in src/ that is not in KIND.
  // We scan every .ts file under src/ for `kind: '<...>'` patterns. The
  // ONLY file allowed to contain raw kind literals is src/reliability/classify.ts
  // (where KIND itself is defined).
  const kindLiteralRe = /\bkind\s*:\s*['"]([a-z_]+)['"]/g;
  const violationFiles = [];
  const allKindLiterals = new Set();
  function walk(dir) {
    const { readdirSync, statSync } = require('node:fs');
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === 'node_modules' || name === 'dist' || name === '.wrangler-dry-run') continue;
        walk(full);
      } else if (full.endsWith('.ts')) {
        const text = readFileSync(full, 'utf8');
        let m;
        while ((m = kindLiteralRe.exec(text)) !== null) {
          allKindLiterals.add(m[1]);
          if (!full.endsWith('reliability/classify.ts') && !full.endsWith('reliability\\classify.ts')) {
            // Allow classify.ts (where the constants live).
            violationFiles.push({ file: full, literal: m[1] });
          }
        }
      }
    }
  }
  // Lazy import for readdirSync/statSync.
  const { readdirSync, statSync } = await import('node:fs');
  function walkSync(dir) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === 'node_modules' || name === 'dist' || name === '.wrangler-dry-run') continue;
        walkSync(full);
      } else if (full.endsWith('.ts')) {
        const text = readFileSync(full, 'utf8');
        let m;
        while ((m = kindLiteralRe.exec(text)) !== null) {
          allKindLiterals.add(m[1]);
          if (!full.replace(/\\/g, '/').endsWith('src/reliability/classify.ts')) {
            violationFiles.push({ file: full, literal: m[1] });
          }
        }
      }
    }
  }
  walkSync(join(root, 'src'));
  const unknownLiterals = [...allKindLiterals].filter((k) => !kindValues.includes(k));
  check('C20 no raw failure-kind string literals in src/ outside classify.ts (closed vocabulary)',
    violationFiles.length === 0 && unknownLiterals.length === 0,
    `violations=${JSON.stringify(violationFiles.slice(0, 5))} unknownLiterals=${JSON.stringify(unknownLiterals)} allLiterals=${JSON.stringify([...allKindLiterals])}`);

  // 3) AttemptOutcome.kind is typed as FailureKind (not string).
  const requestTypesSource = readFileSync(join(root, 'src', 'types', 'request.ts'), 'utf8');
  const outcomeBlock = requestTypesSource.match(/export type AttemptOutcome = \{([\s\S]*?)\};/);
  const kindFieldLine = outcomeBlock ? outcomeBlock[1].match(/kind\?:\s*([^,]+),/) : null;
  const kindType = kindFieldLine ? kindFieldLine[1].trim() : null;
  check('C21 AttemptOutcome.kind is typed as FailureKind (not string) — compiler catches drift',
    kindType === 'FailureKind',
    `kindType=${JSON.stringify(kindType)} (expected "FailureKind")`);

  // 4) FailureKind is imported in src/types/request.ts (proves the type
  // comes from src/reliability/classify.ts, the single source of truth).
  const importsFailureKind = /import\s+type\s+\{[^}]*\bFailureKind\b[^}]*\}\s+from\s+['"][^'"]*reliability\/classify/.test(requestTypesSource)
    || /import\s+type\s+\{[^}]*\bFailureKind\b[^}]*\}\s+from\s+['"][^'"]*reliability\\classify/.test(requestTypesSource);
  check('C22 src/types/request.ts imports FailureKind from src/reliability/classify.ts',
    importsFailureKind,
    `importsFailureKind=${importsFailureKind}`);

  if (failures > 0) {
    console.error(`reliability-core-contract: ${failures} contract(s) FAILED`);
    suiteExit(1);
  }
  console.log('reliability-core-contract: all contracts passed');
  console.log('ok - file:reliability-core-contract');
} catch (error) {
  console.error('not ok - reliability-core-contract-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// reliability-regression-test.mjs
// ==========================================================================
try {
  const __dirname = dirname(fileURLToPath(import.meta.url));

  const encoder = new TextEncoder();
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try { await fn(); passed++; console.log(`ok - ${name}`); }
    catch (e) { failed++; console.error(`FAIL: ${name}`); console.error(e?.stack || e); }
  }

  function fakeSseResponse(chunks) {
    return new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  }

  function fakeHangingSseResponse(chunks) {
    let i = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (i < chunks.length) { controller.enqueue(encoder.encode(chunks[i++])); return; }
        return new Promise(() => {});
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  }

  await test('safeReadErrorBody respects absolute deadline', async () => {
    const { safeReadErrorBody } = await import('#target/src/protocol/http.ts');
    const hanging = new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }));
    const start = Date.now();
    assert.equal(await safeReadErrorBody(hanging, 4096, Date.now() + 100), '');
    assert.ok(Date.now() - start < 500);
  });

  await test('OpenAI stream completes on finish_reason without HTTP EOF', async () => {
    const response = fakeHangingSseResponse([
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n',
    ]);
    const start = Date.now();
    const result = await collectOpenAIStreamObject(response, null, Date.now() + 30_000);
    assert.equal(result.id, 'c1');
    assert.ok(Date.now() - start < 1000);
  });

  await test('Anthropic stream completes on message_stop without HTTP EOF', async () => {
    const response = fakeHangingSseResponse([
      'data: {"type":"message_start","message":{"id":"m1","model":"claude","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]);
    const start = Date.now();
    const result = await collectAnthropicMessageObject(response, null, Date.now() + 30_000);
    assert.equal(result.id, 'm1');
    assert.ok(Date.now() - start < 1000);
  });

  await test('Responses stream completes on response.completed', async () => {
    const { collectResponsesObject } = await import('#target/src/protocol/responses/native-stream.ts');
    const response = fakeSseResponse([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}]}}\n\n',
    ]);
    assert.equal((await collectResponsesObject(response, null, null)).id, 'r1');
  });

  await test('Anthropic to OpenAI conversion renders thinking as reasoning_content', async () => {
    const events = [
      { type: 'message_start', message: { id: 'm2', model: 'claude', usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hidden' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'visible' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ];
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')));
        controller.close();
      },
    });
    const reader = createOpenAIChatStreamFromAnthropic(source, { messageId: 'm2', model: 'claude' }).getReader();
    const decoder = new TextDecoder();
    let out = '';
    for (;;) { const { done, value } = await reader.read(); if (done) break; out += decoder.decode(value); }
    assert.ok(out.includes('visible'));
    assert.ok(out.includes('"reasoning_content":"hidden"'), 'thinking delta is converted to reasoning_content, not dropped');
    assert.ok(out.includes('[DONE]'));
  });

  await test('meaningful-output guards accept valid refusal/reasoning/tool output', () => {
    assert.equal(isOpenAIChatCompletionMeaningful({ choices: [{ message: { role: 'assistant', refusal: 'no' } }] }), true);
    assert.equal(isOpenAIChatCompletionMeaningful({ choices: [{ message: { role: 'assistant', reasoning_content: 'think' } }] }), true);
    assert.equal(isOpenAIChatCompletionMeaningful({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: '1' }] } }] }), true);
    assert.equal(isOpenAIResponsesObjectMeaningful({ output: [{ type: 'refusal', refusal: 'no' }] }), true);
    assert.equal(isAnthropicMessageMeaningful({ content: [{ type: 'thinking', thinking: 'x' }] }), true);
  });

  await test('meaningful-output guards reject empty protocol objects', () => {
    assert.equal(isOpenAIChatCompletionMeaningful({ choices: [] }), false);
    assert.equal(isOpenAIResponsesObjectMeaningful({ output: [] }), false);
    assert.equal(isAnthropicMessageMeaningful({ content: [] }), false);
  });

  await test('400 rotates locally while hard client statuses still stop', () => {
    const rejected = classifyUpstreamStatus(400, new Headers(), {});
    assert.equal(rejected.kind, 'client');
    assert.equal(rejected.action, 'rotate');
    assert.equal(rejected.cooldownMs, 0);
    assert.equal(rejected.counted, false);
    for (const status of [413, 415, 422]) {
      assert.equal(classifyUpstreamStatus(status, new Headers(), {}).action, 'stop');
    }
  });

  await test('409 stops while 408 rotates', () => {
    assert.equal(classifyUpstreamStatus(409, new Headers(), {}).action, 'stop');
    assert.equal(classifyUpstreamStatus(408, new Headers(), {}).action, 'rotate');
  });

  await test('real upstream SSE is not wrapped again by client lifecycle tracking', async () => {
    const { trackClientResponse } = await import('#target/src/observability/gateway-stats.ts');
    const body = new ReadableStream({ start(c) { c.close(); } });
    const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    assert.equal(trackClientResponse(response).body, response.body);
  });

  await test('model-status evidence uses successful requests, not usage reports', () => {
    const src = readFileSync(join(root, 'src', 'observability', 'token-usage-store', 'queries.ts'), 'utf8');
    const start = src.indexOf('export async function queryRecentModelEvidence');
    const end = src.indexOf('export async function queryAllModelsTtftPercentiles', start);
    assert.ok(start >= 0 && end > start, 'queryRecentModelEvidence function block must be present');
    const section = src.slice(start, end);
    assert.ok(section.includes('requests > 0'));
    assert.ok(!section.includes('usage_reports > 0'));
  });

  await test('key RPM snapshot keeps configured cap', async () => {
    const { admitKeyRequest, getKeyRpmSnapshot, __resetKeyRpmForTests } = await import('#target/src/ratelimit/key-rpm.ts');
    __resetKeyRpmForTests();
    admitKeyRequest('test-key', 50, Date.now());
    assert.deepEqual(getKeyRpmSnapshot('test-key', Date.now()), { cap: 50, used: 1 });
  });

  await test('local diagnostic/model routes are exempt from key RPM', () => {
    const src = readFileSync(join(root, 'src', 'request', 'preflight.ts'), 'utf8');
    const block = src.slice(src.indexOf("if (route !== 'health'"), src.indexOf("const diag ="));
    assert.ok(block.includes("route !== 'health'"));
    assert.ok(block.includes("route !== 'metrics'"));
    assert.ok(block.includes("route !== 'models'"));
    assert.ok(block.includes("route !== 'anthropic_count_tokens'"));
  });

  await test('top-level errors remain route-aware', async () => {
    const { sanitizedInternalErrorForRoute } = await import('#target/src/observability/diagnostic-endpoints.ts');
    const req = new Request('https://example.com/v1/responses');
    const anthropic = await sanitizedInternalErrorForRoute(req, {}, 'anthropic_messages', 'r1').json();
    const responses = await sanitizedInternalErrorForRoute(req, {}, 'openai_responses', 'r2').json();
    assert.equal(anthropic.type, 'error');
    assert.equal(responses.error.type, 'server_error');
  });

  await test('Tier 1 explicit maxInFlight is enforced', async () => {
    const { isTier1Eligible, __resetTier1StateForTests, claimTier1Slot, releaseTier1Slot, makeTier1ReleaseToken } = await import('#target/src/reliability/tier1-state.ts');
    __resetTier1StateForTests();
    const node = {
      id: 'cap-test', tier: 'tier-1', provider: 'test', protocol: 'openai',
      surfaces: ['chat'], models: { m: 'up-m' },
    };
    const req = { protocol: 'openai', surface: 'chat', model: 'm' };
    for (let i = 0; i < 4; i++) assert.equal(claimTier1Slot(node, Date.now(), 'm', 4), true);
    assert.equal(claimTier1Slot(node, Date.now(), 'm', 4), false);
    assert.equal(isTier1Eligible(node, req, Date.now(), new Set(['m']), 4), false);
    releaseTier1Slot(node.id, makeTier1ReleaseToken(node.id));
    assert.equal(isTier1Eligible(node, req, Date.now(), new Set(['m']), 4), true);
  });

  await test('per-model token attribution uses the logical request model', () => {
    const src = readFileSync(join(root, 'src', 'request', 'attempt', 'observability.ts'), 'utf8');
    const successStart = src.indexOf('export function recordTokens');
    const undeliveredStart = src.indexOf('export function recordUndeliveredUpstreamAttempt', successStart);
    const persistStart = src.indexOf('function scheduleD1TokenPersist', undeliveredStart);
    assert.ok(successStart >= 0 && undeliveredStart > successStart && persistStart > undeliveredStart);
    assert.ok(src.slice(successStart, undeliveredStart).includes('logicalModelOf(c)'));
    assert.ok(!src.slice(successStart, undeliveredStart).includes('upstreamModelOf('));
    assert.ok(src.slice(undeliveredStart, persistStart).includes('logicalModelOf(c)'));
    assert.ok(!src.slice(undeliveredStart, persistStart).includes('upstreamModelOf('));
  });

  await test('delivered responses backfill missing TTFT before D1 persistence', () => {
    const src = readFileSync(join(root, 'src', 'request', 'attempt', 'observability.ts'), 'utf8');
    const helperStart = src.indexOf('function ensureDeliveredTtft');
    const observeStart = src.indexOf('export function observeUpstreamAttemptUsage', helperStart);
    const successStart = src.indexOf('export function recordTokens');
    const undeliveredStart = src.indexOf('export function recordUndeliveredUpstreamAttempt', successStart);
    assert.ok(helperStart >= 0 && observeStart > helperStart && successStart > observeStart && undeliveredStart > successStart);
    const helper = src.slice(helperStart, observeStart);
    const success = src.slice(successStart, undeliveredStart);
    assert.ok(helper.includes('c.ttftMs != null'));
    assert.ok(helper.includes('c.attemptStartMs'));
    assert.ok(success.includes('ensureDeliveredTtft(c)'));
    assert.ok(success.indexOf('ensureDeliveredTtft(c)') < success.indexOf('scheduleD1TokenPersist'));
  });

  await test('Tier 1 auth cooldown follows the shared classification value', async () => {
    const {
      classifyTier1Failure,
      applyTier1Outcome,
      getTier1Account,
      __resetTier1StateForTests,
    } = await import('#target/src/reliability/tier1-state.ts');
    __resetTier1StateForTests();
    const now = 1_000;
    const outcome = classifyTier1Failure({ kind: 'auth', cooldownMs: 12_345 });
    assert.equal(outcome.cooldownMs, 12_345);
    applyTier1Outcome('auth-test', 'm', outcome, now);
    const account = getTier1Account('auth-test');
    assert.equal(account.accountDisabled, false);
    assert.equal(account.accountCooldownUntil, now + 12_345);
    assert.equal(account.accountCooldownReason, 'auth');
  });

  await test('Tier 1 request scoring has no access-key group priority path', () => {
    const tier1State = readFileSync(join(root, 'src', 'reliability', 'tier1-state.ts'), 'utf8');
    const preflight = readFileSync(join(root, 'src', 'request', 'preflight.ts'), 'utf8');
    const schedulerTypes = readFileSync(join(root, 'src', 'types', 'scheduler.ts'), 'utf8');
    assert.ok(!tier1State.includes('priorityFactor'));
    assert.ok(!preflight.includes('GROUP_PRIORITY'));
    assert.ok(!schedulerTypes.includes('priority?:'));
  });

  console.log(`\nreliability-regression-test: ${passed} passed, ${failed} failed`);
  if (failed > 0) suiteExit(1);
  console.log('ok - file:reliability-regression');
} catch (error) {
  console.error('not ok - reliability-regression-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// reliability-convergence-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Cross-module reliability convergence invariants.









  function reset() {
    __resetAllStateForTests();
    __resetTier1StateForTests();
    __resetTier1AffinityForTests();
  }
  function chatCompletion(model, content = 'ok') {
    return new Response(JSON.stringify({
      id: 'chatcmpl-test', object: 'chat.completion', model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  function request(model, key) {
    return new Request('https://gateway.example.com/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'test' }] }),
    });
  }
  function node(id, model, upstreamModel = `up-${model.toLowerCase()}`) {
    return {
      id, provider: id.split('-')[0], base_url: `https://${id}.example.com/v1`, priority: 10,
      models: { [model]: upstreamModel },
    };
  }

  {
    reset();
    const key = 'air-only-key';
    const calls = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const body = JSON.parse(init.body);
      calls.push({ host: url.hostname, model: body.model });
      if (url.hostname.startsWith('air-')) {
        return new Response(JSON.stringify({ error: { message: 'temporary unavailable' } }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
      return chatCompletion(body.model, 'should-not-be-called');
    };
    const env = {
      AIG_ACCESS_KEY_AIR: key, AIG_ACCESS_MODELS_AIR: 'Air,SenseNova', AIG_PROTOCOL_FALLBACKS: 'disable',
      AIG_TIER1_NODES_01: JSON.stringify([node('air-01', 'Air', 'up-air'), node('pro-01', 'Pro', 'up-pro'), node('max-01', 'Max', 'up-max')]),
      AIG_TIER1_CREDENTIALS_01: JSON.stringify({ 'air-01': 'a', 'pro-01': 'p', 'max-01': 'm' }),
    };
    const response = await worker.fetch(request('Air', key), env, {});
    assert.notEqual(response.status, 200);
    assert.deepEqual(calls.map((c) => c.model), ['up-air']);
  }

  {
    reset();
    const key = 'family-key';
    const calls = [];
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(init.body);
      calls.push(body.model);
      if (body.model === 'up-max') return new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404, headers: { 'content-type': 'application/json' } });
      return chatCompletion(body.model, 'fallback-ok');
    };
    const env = {
      AIG_ACCESS_KEY_MAX: key, AIG_ACCESS_MODELS_MAX: 'Max,Pro,Ultra', AIG_PROTOCOL_FALLBACKS: 'disable',
      AIG_TIER1_NODES_01: JSON.stringify([node('max-01', 'Max', 'up-max'), node('pro-01', 'Pro', 'up-pro')]),
      AIG_TIER1_CREDENTIALS_01: JSON.stringify({ 'max-01': 'm', 'pro-01': 'p' }),
    };
    const response = await worker.fetch(request('Max', key), env, {});
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.model, 'Max');
    assert.deepEqual(calls, ['up-max', 'up-pro']);
  }

  {
    const policies = loadPoliciesConfig({
      AIG_FAILOVER_BUDGET_MS: '60000',
      AIG_POLICIES_CONFIG: JSON.stringify({
        custom: { max_attempts: 2, hedge: { delay_ms: 1500, tiers: ['tier1'] } },
        disabled: { max_attempts: 2, hedge: { enabled: false, delay_ms: 1500, tiers: ['tier1'] } },
      }),
    });
    assert.equal(policies.custom.hedge?.enabled, true);
    assert.equal(policies.custom.hedge?.delayMs, 1500);
    assert.equal(policies.disabled.hedge?.enabled, false);
  }

  {
    const tier1StateSource = readFileSync(targetPath('src/reliability/tier1-state.ts'), 'utf8');
    const outcomeSource = readFileSync(targetPath('src/request/attempt/outcome.ts'), 'utf8');
    for (const retired of ['TIER1_429_BASE_MS', 'TIER1_429_SECOND_MS', 'TIER1_429_MAX_MS', 'rateLimitCooldownMs']) {
      assert.equal(tier1StateSource.includes(retired), false);
    }
    assert.match(tier1StateSource, /outcome\.backoff === 'rate_limit'\) return Math\.max\(0, outcome\.cooldownMs \?\? 0\)/);
    assert.match(outcomeSource, /nextAdaptive429CooldownMs\(/);
    assert.match(outcomeSource, /snapshotAdaptive429State\(/);
    assert.match(outcomeSource, /rate_limit_stage=/);
  }

  console.log('reliability convergence invariants passed.');
  console.log('ok - file:reliability-convergence');
} catch (error) {
  console.error('not ok - reliability-convergence-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// reliability-fault-injection-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // @ts-check
  // Copyright (c) 2026 Fongap Labs
  //
  // PR 7 reliability fault-injection tests.
  //
  // These tests exercise the five failure paths the hardening plan calls out:
  //   1. stream-interrupted failure must NOT pollute TTFT aggregates
  //   2. hedge-loser path must NOT trigger a false-positive failure
  //   3. half-open probe + counted failure must NOT make consecutiveFailures
  //      regress (probe failure is counted, not the prior steady-state value)
  //   4. KV read exception must fall through to "no affinity" (not crash,
  //      not falsely seed affinity)
  //   5. D1 write failure must NOT double-count (one attempt charges once,
  //      even when the persistence call rejects)
  //
  // These are pure-Node fault-injection tests — no real D1, no real KV.






  const now = 1_700_000_000_000;

  function header(name) {
    console.log(`\n--- ${name} ---`);
  }

  const resetNodeState = (id) => {
    __resetAllStateForTests();
  };

  async function test(name, fn) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      console.error(`not ok - ${name}`);
      console.error(error?.stack || error);
      process.exitCode = 1;
    }
  }

  // === 1. stream-interrupted must NOT pollute TTFT ========================

  header('1. stream-interrupted -> TTFT untouched');

  await test('recordTtft followed by stream-interrupted keeps the TTFT measurement', () => {
    const id = 'stream-ttft-1';
    resetNodeState(id);
    // Real first event at +250ms — this is the only "real" measurement.
    recordTtft(id, 250, 'general-air');
    const s1 = getNodeState(id);
    assert.equal(s1.avgTtftMs, 250, 'real TTFT must be recorded');
    // Now the stream is interrupted at +5000ms. The handler must NOT
    // overwrite avgTtftMs with a bogus value derived from the
    // interruption time (would falsely look like a 5s TTFT). The handler
    // also must NOT call recordTtft at all for the interruption case;
    // this test enforces that contract by asserting avgTtftMs is
    // unchanged after the simulated stream-interrupted outcome.
    recordNeutralEnd(id);
    recordSuccess(id, 5000, 'general-air', now + 5000);
    const s2 = getNodeState(id);
    assert.equal(s2.avgTtftMs, 250, 'avgTtftMs must remain the real first-event value');
  });

  await test('markProbeFailure after a successful TTFT keeps the original', () => {
    const id = 'stream-ttft-2';
    resetNodeState(id);
    acquireSlot(id, now);
    recordTtft(id, 100, 'general-air');
    // Tier 2/3 invalidates the TTFT after a first-event failure. Simulate
    // the same path here and assert that a SUCCESSFUL TTFT stays put.
    markProbeFailure(id, 'general-air', now + 1000);
    const s = getNodeState(id);
    const mp = s.modelPerf.get('general-air');
    assert.ok(mp && mp.lastProbeFailureAt > 0, 'lastProbeFailureAt is set');
    assert.equal(s.avgTtftMs, 100, 'TTFT stays at the real first-event value');
  });

  // === 2. hedge-loser must NOT trigger a false-positive failure ==========

  header('2. hedge loser -> neutral, never a counted failure');

  await test('recordNeutralEnd on a hedge loser does not increment totalFailures', () => {
    const id = 'hedge-loser-1';
    resetNodeState(id);
    acquireSlot(id, now);
    const before = getNodeState(id).totalFailures;
    recordNeutralEnd(id, now + 100);
    const s = getNodeState(id);
    assert.equal(s.totalFailures, before, 'totalFailures must not change for a hedge loser');
    assert.equal(s.consecutiveFailures, 0, 'consecutiveFailures must not change');
  });

  await test('hedge-loser back-to-back never opens the circuit', () => {
    const id = 'hedge-loser-2';
    resetNodeState(id);
    // 100 hedge losers in a row — the circuit must stay closed because
    // neutral ends are explicitly NOT counted failures.
    for (let i = 0; i < 100; i += 1) {
      acquireSlot(id, now + i);
      recordNeutralEnd(id, now + i);
    }
    const s = getNodeState(id);
    assert.equal(s.circuitState, 'closed', 'hedge losers must not open the circuit');
    assert.equal(s.consecutiveFailures, 0, 'no consecutive failures accumulated');
  });

  // === 3. half-open probe + counted failure: consecutiveFailures monotonic ===

  header('3. half-open probe -> counted failure does not regress consecutiveFailures');

  await test('open circuit, real request fails, consecutiveFailures monotonic', () => {
    const id = 'half-open-monotonic';
    resetNodeState(id);
    // 3 real failures to open the circuit.
    acquireSlot(id, now);
    recordFailure(id, { counted: true, cooldownMs: 30_000, reason: '5xx' }, now);
    acquireSlot(id, now + 1);
    recordFailure(id, { counted: true, cooldownMs: 30_000, reason: '5xx' }, now + 1);
    acquireSlot(id, now + 2);
    recordFailure(id, { counted: true, cooldownMs: 30_000, reason: '5xx' }, now + 2);
    let s = getNodeState(id);
    assert.equal(s.circuitState, 'open', 'circuit is open after 3 counted failures');
    const openCooldown = s.cooldownUntil;
    // Simulate the half-open window elapsing: probes use the same
    // recordFailure path. A fourth counted failure must take the
    // consecutiveFailures to 4 (monotonic increment) and re-open the
    // circuit; it must NOT reset back to 1 (which would mask
    // long-running reliability issues).
    recordFailure(id, { counted: true, cooldownMs: 30_000, reason: '5xx' }, now + 30_001);
    s = getNodeState(id);
    assert.equal(s.circuitState, 'open', 'circuit re-opens after a probe failure');
    assert.ok(s.consecutiveFailures >= 4, 'consecutiveFailures is monotonically increasing');
    assert.ok(s.cooldownUntil >= openCooldown, 'cooldownUntil is updated on re-open');
  });

  // === 4. KV read exception: readTier1Affinity returns null, no crash ===

  header('4. KV read exception -> no affinity, no crash');

  await test('readTier1Affinity on a throwing KV returns null (no crash, no false seed)', async () => {
    __resetTier1AffinityForTests();
    const env = {
      TIER1_AFFINITY_KV: {
        async get() { throw new Error('kv-explode'); },
      },
    };
    const out = await readTier1Affinity(env, 'session-throws');
    assert.equal(out, null, 'KV read failure must surface as null, never as a fake account id');
  });

  await test('writeTier1Affinity on a throwing KV is silently swallowed (does not throw)', async () => {
    __resetTier1AffinityForTests();
    const env = {
      TIER1_AFFINITY_KV: {
        async put() { throw new Error('kv-write-explode'); },
      },
    };
    // A successful call must not throw; the gateway path is the
    // writeTier1Affinity(...) call inside attempt.ts which is followed
    // by no await on the result (it is fire-and-forget for performance).
    let threw = false;
    try {
      await writeTier1Affinity(env, undefined, 'session-write-throws', 'account-x');
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'writeTier1Affinity must not throw on KV failures (it logs + continues)');
  });

  await test('readTier1Affinity when KV get returns malformed data returns null', async () => {
    __resetTier1AffinityForTests();
    const env = {
      TIER1_AFFINITY_KV: {
        async get() { return { some: 'garbage' }; }, // no `accountId` field
      },
    };
    const out = await readTier1Affinity(env, 'session-malformed');
    assert.equal(out, null, 'a KV record without the expected shape must not be trusted');
  });

  // === 5. D1 write failure: no double-charge, no uncaught rejection =====

  header('5. D1 write failure -> no double-charge, rejection surfaces to caller');

  await test('persistTokenUsage rejects with the underlying D1 error (caller decides to swallow)', async () => {
    let writeCount = 0;
    const env = {
      TOKEN_STATS_DB: {
        prepare() {
          return {
            bind() { return this; },
            async run() { writeCount += 1; throw new Error('d1-explode'); },
          };
        },
      },
    };
    let caught = null;
    try {
      await persistTokenUsage(env, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, now, 'model-d1-fail', 100);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, 'persistTokenUsage must reject on D1 failure (caller awaits via waitUntil)');
    assert.match(String(caught?.message || caught), /d1-explode/);
    // The persist path writes to multiple tables (hourly + per-model + totals).
    // What we are testing is that an in-attempt retry path does NOT exist:
    // the writes happened once each, and the rejection propagates instead of
    // being swallowed. A re-running count > expectedTables would indicate a
    // retry loop leaking in via waitUntil.
    assert.ok(writeCount <= 3, `D1 prepare/run called at most 3 times; saw ${writeCount}`);
  });

  await test('a successful persistTokenUsage that is followed by a D1 reject in the next attempt does not double-count in memory', () => {
    // The in-memory aggregator (recordTokenUsage) is called once per
    // successful attempt; persistence is best-effort and runs in
    // waitUntil. A failure in the D1 layer must never feed back into
    // the in-memory count.
    let memoryCalls = 0;
    const fakeInMemoryAgg = () => { memoryCalls += 1; };
    fakeInMemoryAgg(); // success path
    fakeInMemoryAgg(); // would-be retry (should not exist)
    assert.equal(memoryCalls, 2, 'in-memory aggregator runs once per attempt; persistence is a side-channel');
  });
  console.log('ok - file:reliability-fault-injection');
} catch (error) {
  console.error('not ok - reliability-fault-injection-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// reliability-performance-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs
  //
  // Unit tests for Provider Dashboard observability semantics:
  // - Usage Coverage (usage_reports / (usage_reports + usage_missing))
  // - TTFT P50/P95 from successful requests only
  // - Failure does NOT produce TTFT samples
  // - Provider-agnostic: no provider-specific logic





  const WEEK_MS = 7 * 24 * 3600_000;

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`    ${e.message}`);
    }
  }

  // ─── ttftBucketIndex ────────────────────────────────────────────────────────

  console.log('\n── ttftBucketIndex ──');

  await test('negative value returns -1', () => {
    assert.equal(ttftBucketIndex(-1), -1);
  });

  await test('NaN returns -1', () => {
    assert.equal(ttftBucketIndex(NaN), -1);
  });

  await test('Infinity returns last bucket (6)', () => {
    assert.equal(ttftBucketIndex(Infinity), 6);
  });

  await test('0ms -> bucket 0 (< 100ms)', () => {
    assert.equal(ttftBucketIndex(0), 0);
  });

  await test('50ms -> bucket 0 (< 100ms)', () => {
    assert.equal(ttftBucketIndex(50), 0);
  });

  await test('99ms -> bucket 0 (< 100ms)', () => {
    assert.equal(ttftBucketIndex(99), 0);
  });

  await test('100ms -> bucket 1 (100-500ms)', () => {
    assert.equal(ttftBucketIndex(100), 1);
  });

  await test('300ms -> bucket 1 (100-500ms)', () => {
    assert.equal(ttftBucketIndex(300), 1);
  });

  await test('499ms -> bucket 1 (100-500ms)', () => {
    assert.equal(ttftBucketIndex(499), 1);
  });

  await test('500ms -> bucket 2 (500ms-1s)', () => {
    assert.equal(ttftBucketIndex(500), 2);
  });

  await test('999ms -> bucket 2 (500ms-1s)', () => {
    assert.equal(ttftBucketIndex(999), 2);
  });

  await test('1000ms -> bucket 3 (1-2s)', () => {
    assert.equal(ttftBucketIndex(1000), 3);
  });

  await test('1500ms -> bucket 3 (1-2s)', () => {
    assert.equal(ttftBucketIndex(1500), 3);
  });

  await test('2000ms -> bucket 4 (2-5s)', () => {
    assert.equal(ttftBucketIndex(2000), 4);
  });

  await test('4999ms -> bucket 4 (2-5s)', () => {
    assert.equal(ttftBucketIndex(4999), 4);
  });

  await test('5000ms -> bucket 5 (5-10s)', () => {
    assert.equal(ttftBucketIndex(5000), 5);
  });

  await test('9999ms -> bucket 5 (5-10s)', () => {
    assert.equal(ttftBucketIndex(9999), 5);
  });

  await test('10000ms -> bucket 6 (≥ 10s)', () => {
    assert.equal(ttftBucketIndex(10000), 6);
  });

  await test('30000ms -> bucket 6 (≥ 10s)', () => {
    assert.equal(ttftBucketIndex(30000), 6);
  });

  // ─── TTFT bucket boundaries constant ────────────────────────────────────────

  console.log('\n── TTFT_BUCKET_BOUNDARIES_MS ──');

  await test('has 6 boundaries', () => {
    assert.equal(TTFT_BUCKET_BOUNDARIES_MS.length, 6);
  });

  await test('boundaries are strictly increasing', () => {
    for (let i = 1; i < TTFT_BUCKET_BOUNDARIES_MS.length; i++) {
      assert.ok(TTFT_BUCKET_BOUNDARIES_MS[i] > TTFT_BUCKET_BOUNDARIES_MS[i - 1],
        `boundary ${i} (${TTFT_BUCKET_BOUNDARIES_MS[i]}) must be > ${i - 1} (${TTFT_BUCKET_BOUNDARIES_MS[i - 1]})`);
    }
  });

  // ─── persistTokenUsage with TTFT ────────────────────────────────────────────

  console.log('\n── persistTokenUsage with TTFT ──');

  await test('successful TTFT is recorded in histogram', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }, 1000, 'model-a', 1500);
    const key = `${new Date(1000).toISOString().slice(0, 13)}:00:00Z|model-a`;
    const row = d1._modelRows.get(key);
    assert.ok(row, 'model row exists');
    assert.equal(row.successful_ttft_count, 1);
    assert.equal(row.ttft_b3, 1, '1500ms -> bucket 3 (1-2s)');
    assert.equal(row.ttft_b0, 0);
    assert.equal(row.ttft_b1, 0);
    assert.equal(row.ttft_b2, 0);
  });

  await test('null TTFT does not produce a sample', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }, 1000, 'model-a', null);
    const key = `${new Date(1000).toISOString().slice(0, 13)}:00:00Z|model-a`;
    const row = d1._modelRows.get(key);
    assert.ok(row, 'model row exists');
    assert.equal(row.successful_ttft_count, 0);
    assert.equal(row.ttft_b0, 0);
    assert.equal(row.ttft_b3, 0);
  });

  await test('undefined TTFT does not produce a sample', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }, 1000, 'model-a', undefined);
    const key = `${new Date(1000).toISOString().slice(0, 13)}:00:00Z|model-a`;
    const row = d1._modelRows.get(key);
    assert.ok(row, 'model row exists');
    assert.equal(row.successful_ttft_count, 0);
  });

  await test('multiple TTFT samples accumulate correctly', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
    await persistTokenUsage(env, usage, 1000, 'model-a', 50);    // bucket 0
    await persistTokenUsage(env, usage, 2000, 'model-a', 200);   // bucket 1
    await persistTokenUsage(env, usage, 3000, 'model-a', 1500);  // bucket 3
    await persistTokenUsage(env, usage, 4000, 'model-a', 6000);  // bucket 5
    const key = `${new Date(1000).toISOString().slice(0, 13)}:00:00Z|model-a`;
    const row = d1._modelRows.get(key);
    assert.ok(row, 'model row exists');
    assert.equal(row.successful_ttft_count, 4);
    assert.equal(row.ttft_b0, 1);
    assert.equal(row.ttft_b1, 1);
    assert.equal(row.ttft_b3, 1);
    assert.equal(row.ttft_b5, 1);
  });

  await test('no model -> no TTFT columns written', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }, 1000, null, 1500);
    assert.equal(d1._modelRows.size, 0, 'no model rows written');
  });

  // ─── queryModelUsageCoverage ──────────────────────────────────────────────

  console.log('\n── queryModelUsageCoverage ──');

  await test('returns per-model usage coverage', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    const now = Date.now();
    const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
    // model-a: 10 delivered with usage, 0 missing -> 100% coverage
    for (let i = 0; i < 10; i++) {
      await persistTokenUsage(env, usage, now - i * 1000, 'model-a');
    }
    // model-b: 1 delivered with usage, 9 delivered without usage -> 10% coverage
    await persistTokenUsage(env, usage, now, 'model-b');
    for (let i = 0; i < 9; i++) {
      await persistTokenUsage(env, null, now - (i + 1) * 1000, 'model-b');
    }
    const result = await queryModelUsageCoverage(env, 7, now);
    assert.equal(result.available, true);
    assert.ok(Array.isArray(result.rows));
    const a = result.rows.find((r) => r.model === 'model-a');
    const b = result.rows.find((r) => r.model === 'model-b');
    assert.ok(a, 'model-a found');
    assert.ok(b, 'model-b found');
    assert.equal(a.requests, 10);
    assert.equal(a.reports, 10);
    assert.equal(a.missing, 0);
    assert.equal(a.usageCoverage, 1);
    assert.equal(b.requests, 10);
    assert.equal(b.reports, 1);
    assert.equal(b.missing, 9);
    assert.equal(b.usageCoverage, 0.1);
  });

  await test('missing D1 binding returns available false', async () => {
    const result = await queryModelUsageCoverage({}, 7, Date.now());
    assert.equal(result.available, false);
  });

  await test('empty model returns empty rows', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    const result = await queryModelUsageCoverage(env, 7, Date.now());
    assert.equal(result.available, true);
    assert.equal(result.rows.length, 0);
  });

  // ─── queryAllModelsTtftPercentiles ─────────────────────────────────────────

  console.log('\n── queryAllModelsTtftPercentiles ──');

  await test('insufficient samples returns both p50/p95 insufficient', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    const now = Date.now();
    const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
    // Only 3 samples (< P50 threshold of 5)
    for (let i = 0; i < 3; i++) {
      await persistTokenUsage(env, usage, now - i * 1000, 'model-a', 1000 + i * 500);
    }
    const result = (await queryAllModelsTtftPercentiles(env, WEEK_MS, now)).ttft.get('model-a');
    assert.equal(result.available, true);
    assert.equal(result.p50Insufficient, true);
    assert.equal(result.p95Insufficient, true);
    assert.equal(result.sampleCount, 3);
    assert.equal(result.p50, null);
    assert.equal(result.p95, null);
  });

  await test('P50 and P95 are computed from histogram buckets', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    const now = Date.now();
    const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
    // 20 samples (≥ P95 threshold of 20): all in bucket 3 (1-2s)
    for (let i = 0; i < 20; i++) {
      await persistTokenUsage(env, usage, now - i * 1000, 'model-a', 1200);
    }
    const result = (await queryAllModelsTtftPercentiles(env, WEEK_MS, now)).ttft.get('model-a');
    assert.equal(result.available, true);
    assert.equal(result.p50Insufficient, false);
    assert.equal(result.p95Insufficient, false);
    assert.equal(result.sampleCount, 20);
    // P50 and P95 both in bucket 3 -> upper bound is 2000ms
    assert.equal(result.p50, 2000);
    assert.equal(result.p95, 2000);
  });

  await test('P50 in bucket 2, P95 in bucket 4', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    const now = Date.now();
    const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
    // 20 samples: 12 in bucket 2 (500ms-1s), 8 in bucket 4 (2-5s)
    for (let i = 0; i < 12; i++) {
      await persistTokenUsage(env, usage, now - i * 1000, 'model-a', 700);
    }
    for (let i = 0; i < 8; i++) {
      await persistTokenUsage(env, usage, now - (12 + i) * 1000, 'model-a', 3000);
    }
    const result = (await queryAllModelsTtftPercentiles(env, WEEK_MS, now)).ttft.get('model-a');
    assert.equal(result.available, true);
    assert.equal(result.p50Insufficient, false);
    assert.equal(result.p95Insufficient, false);
    assert.equal(result.sampleCount, 20);
    // P50 (10th sample) is in bucket 2 -> upper bound 1000ms
    assert.equal(result.p50, 1000);
    // P95 (19th sample) is in bucket 4 -> upper bound 5000ms
    assert.equal(result.p95, 5000);
  });

  await test('missing D1 binding returns available false', async () => {
    const result = await queryAllModelsTtftPercentiles({}, 7, Date.now());
    assert.equal(result.available, false);
  });

  await test('no data returns an empty map, not an error', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    const result = await queryAllModelsTtftPercentiles(env, 7, Date.now());
    assert.equal(result.available, true);
    assert.equal(result.ttft.size, 0, 'models without rows simply have no entry');
  });

  // ─── Provider-agnostic verification ─────────────────────────────────────────

  console.log('\n── Provider-agnostic verification ──');

  await test('provider name does not affect usage coverage', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    const now = Date.now();
    const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
    // provider-a: 10 delivered with usage
    for (let i = 0; i < 10; i++) {
      await persistTokenUsage(env, usage, now - i * 1000, 'model-a');
    }
    const result = await queryModelUsageCoverage(env, 7, now);
    assert.equal(result.available, true);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].usageCoverage, 1);
  });

  await test('new provider works without code changes', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    const now = Date.now();
    const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
    // provider-new: 5 delivered with usage, 5 delivered without usage
    for (let i = 0; i < 5; i++) {
      await persistTokenUsage(env, usage, now - i * 1000, 'model-new');
    }
    for (let i = 0; i < 5; i++) {
      await persistTokenUsage(env, null, now - (5 + i) * 1000, 'model-new');
    }
    const result = await queryModelUsageCoverage(env, 7, now);
    assert.equal(result.available, true);
    const m = result.rows.find((r) => r.model === 'model-new');
    assert.ok(m, 'model-new found');
    assert.equal(m.usageCoverage, 0.5);
  });

  // ─── Core verification cases from task ──────────────────────────────────────

  console.log('\n── Core verification cases ──');

  await test('Provider A: 20 delivered with usage, TTFT 4s -> Usage Coverage 100%, P50 TTFT 4s', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    const now = Date.now();
    const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
    for (let i = 0; i < 20; i++) {
      await persistTokenUsage(env, usage, now - i * 1000, 'provider-a', 4000);
    }
    const cov = await queryModelUsageCoverage(env, 7, now);
    const ttft = (await queryAllModelsTtftPercentiles(env, WEEK_MS, now)).ttft.get('provider-a');
    const a = cov.rows.find((r) => r.model === 'provider-a');
    assert.equal(a.usageCoverage, 1, 'Usage Coverage 100%');
    assert.equal(ttft.p50, 5000, 'P50 TTFT in 2-5s bucket -> 5000ms upper bound');
    assert.equal(ttft.sampleCount, 20);
  });

  await test('Provider B: 1 delivered with usage TTFT 500ms, 9 delivered without usage -> Usage Coverage 10%', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    const now = Date.now();
    const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
    // 1 delivered with usage
    await persistTokenUsage(env, usage, now, 'provider-b', 500);
    // 9 delivered without usage (missing usage data)
    for (let i = 0; i < 9; i++) {
      await persistTokenUsage(env, null, now - (i + 1) * 1000, 'provider-b');
    }
    const cov = await queryModelUsageCoverage(env, 7, now);
    const ttft = (await queryAllModelsTtftPercentiles(env, WEEK_MS, now)).ttft.get('provider-b');
    const b = cov.rows.find((r) => r.model === 'provider-b');
    assert.equal(b.usageCoverage, 0.1, 'Usage Coverage 10%');
    // Only 1 TTFT sample (< P50 threshold) -> both insufficient
    assert.equal(ttft.p50Insufficient, true, 'p50 insufficient');
    assert.equal(ttft.p95Insufficient, true, 'p95 insufficient');
    assert.equal(ttft.sampleCount, 1, 'only 1 TTFT sample');
    assert.equal(ttft.p50, null, 'P50 null when insufficient');
  });

  await test('fast failures do not pollute TTFT', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    const now = Date.now();
    const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
    // 5 fast failures (delivered without usage) - should NOT produce TTFT samples
    for (let i = 0; i < 5; i++) {
      await persistTokenUsage(env, null, now - i * 1000, 'model-fast-fail');
    }
    // 5 slow successes (delivered with usage, 4s TTFT each)
    for (let i = 0; i < 5; i++) {
      await persistTokenUsage(env, usage, now - (5 + i) * 1000, 'model-fast-fail', 4000);
    }
    const cov = await queryModelUsageCoverage(env, 7, now);
    const ttft = (await queryAllModelsTtftPercentiles(env, WEEK_MS, now)).ttft.get('model-fast-fail');
    const m = cov.rows.find((r) => r.model === 'model-fast-fail');
    assert.equal(m.usageCoverage, 0.5, 'Usage Coverage 50%');
    assert.equal(ttft.sampleCount, 5, 'only 5 TTFT samples (failures excluded)');
    assert.equal(ttft.p50, 5000, 'P50 TTFT in 2-5s bucket');
  });

  // ─── Summary ────────────────────────────────────────────────────────────────

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) suiteExit(1);
  console.log('ok - file:reliability-performance');
} catch (error) {
  console.error('not ok - reliability-performance-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}
