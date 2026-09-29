// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Merged suite. Each section below was a standalone suite and keeps its own scope:
//   - family-rate-limit-retry-test.mjs
//   - model-family-failure-domain-test.mjs
//   - fallback-conversion-observability-test.mjs
//   - responses-error-diagnostics-test.mjs
//   - protocol-matrix-test.mjs

import { convertAnthropicToOpenAIRequest } from '#target/src/conversion/anthropic-to-openai.ts';
import worker from '#target/src/index.ts';
import { buildResponsesError } from '#target/src/protocol/responses/index.ts';
import { __resetAdaptive429StateForTests } from '#target/src/reliability/adaptive-429.ts';
import { KIND } from '#target/src/reliability/classify.ts';
import { __resetAllStateForTests } from '#target/src/reliability/node-state.ts';
import { __resetTier1StateForTests } from '#target/src/reliability/tier1-state.ts';
import { terminalStatus } from '#target/src/request/errors.ts';
import { failedDomainNodeIds, modelFailureDomainKey, rememberFailedDomains } from '#target/src/request/model-fallback.ts';
import { __resetTier1AffinityForTests } from '#target/src/scheduler/tier1-affinity.ts';
import assert from 'node:assert/strict';

// ==========================================================================
// family-rate-limit-retry-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs







  const ACCESS_KEY = 'family-rate-limit-test-key';
  const calls = [];
  __resetAllStateForTests();
  __resetTier1StateForTests();
  __resetTier1AffinityForTests();

  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ host: url.hostname, model: body.model });
    return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '30' },
    });
  };

  const nodes = [
    {
      id: 'code-ultra-rl',
      provider: 'provider-ultra',
      base_url: 'https://code-ultra-rl.example.com/v1',
      priority: 10,
      models: { 'Code-Ultra': 'up-code-ultra' },
    },
    {
      id: 'code-max-rl',
      provider: 'provider-max',
      base_url: 'https://code-max-rl.example.com/v1',
      priority: 10,
      models: { 'Code-Max': 'up-code-max' },
    },
    {
      id: 'code-pro-rl',
      provider: 'provider-pro',
      base_url: 'https://code-pro-rl.example.com/v1',
      priority: 10,
      models: { 'Code-Pro': 'up-code-pro' },
    },
  ];

  const env = {
    AIG_ACCESS_KEY_ULTRA: ACCESS_KEY,
    AIG_ACCESS_MODELS_ULTRA: '*',
    AIG_PROTOCOL_FALLBACKS: 'disable',
    AIG_TIER1_NODES_01: JSON.stringify(nodes),
    AIG_TIER1_CREDENTIALS_01: JSON.stringify({
      'code-ultra-rl': 'k-ultra',
      'code-max-rl': 'k-max',
      'code-pro-rl': 'k-pro',
    }),
  };

  const request = new Request('https://gateway.example.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
    body: JSON.stringify({ model: 'Code-Ultra', messages: [{ role: 'user', content: 'continue the task' }] }),
  });

  const response = await worker.fetch(request, env, {});
  const body = await response.json();
  assert.equal(response.status, 503, 'all-transient compatible family exhaustion must remain retryable');
  assert.match(body?.error?.message || '', /Transient failures exhausted the compatible-model failover plan/i);
  assert.doesNotMatch(body?.error?.message || '', /Compatible model capacity is temporarily unavailable/i);
  assert.doesNotMatch(body?.error?.message || '', /All attempted nodes failed/i);
  assert.equal(response.headers.get('x-should-retry'), null);
  const retryAfter = Number(response.headers.get('retry-after'));
  assert.ok(Number.isFinite(retryAfter) && retryAfter >= 25 && retryAfter <= 30);
  assert.equal(body?.error?.details?.failure_kinds?.rate_limit, 3);
  assert.deepEqual(
    calls.map((c) => c.model),
    ['up-code-ultra', 'up-code-max', 'up-code-pro'],
  );

  calls.length = 0;
  __resetAllStateForTests();
  __resetTier1StateForTests();
  __resetTier1AffinityForTests();

  const auditNodes = [
    {
      id: 'audit-ultra-rl',
      provider: 'provider-audit-ultra',
      base_url: 'https://audit-ultra-rl.example.com/v1',
      priority: 10,
      models: { 'Audit-Ultra': 'up-audit-ultra' },
    },
    {
      id: 'audit-max-rl',
      provider: 'provider-audit-max',
      base_url: 'https://audit-max-rl.example.com/v1',
      priority: 10,
      models: { 'Audit-Max': 'up-audit-max' },
    },
    {
      id: 'audit-pro-rl',
      provider: 'provider-audit-pro',
      base_url: 'https://audit-pro-rl.example.com/v1',
      priority: 10,
      models: { 'Audit-Pro': 'up-audit-pro' },
    },
  ];

  const auditEnv = {
    AIG_ACCESS_KEY_AGENT: ACCESS_KEY,
    AIG_ACCESS_MODELS_AGENT: '*',
    AIG_PROTOCOL_FALLBACKS: 'disable',
    AIG_TIER1_NODES_01: JSON.stringify(auditNodes),
    AIG_TIER1_CREDENTIALS_01: JSON.stringify({
      'audit-ultra-rl': 'k-audit-ultra',
      'audit-max-rl': 'k-audit-max',
      'audit-pro-rl': 'k-audit-pro',
    }),
  };

  const auditRequest = new Request('https://gateway.example.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
    body: JSON.stringify({ model: 'Audit-Ultra', messages: [{ role: 'user', content: 'review the architecture' }] }),
  });

  const auditResponse = await worker.fetch(auditRequest, auditEnv, {});
  assert.equal(auditResponse.status, 503);
  assert.deepEqual(
    calls.map((c) => c.model),
    ['up-audit-ultra', 'up-audit-max', 'up-audit-pro'],
    'prefixed logical aliases must fail over across configured sibling tiers',
  );

  console.log('family rate-limit retry test passed.');
  console.log('ok - file:family-rate-limit-retry');
} catch (error) {
  console.error('not ok - family-rate-limit-retry-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// model-family-failure-domain-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs









  const ACCESS_KEY = 'family-domain-test-key';
  let calls = [];
  function reset() {
    calls = [];
    __resetAllStateForTests();
    __resetTier1StateForTests();
    __resetTier1AffinityForTests();
    __resetAdaptive429StateForTests();
  }

  // Direct helper consumers still use RuntimeNode, which includes resolved wire
  // fields. When projected back into config JSON below, those fields are omitted.
  function node(id, models) {
    return {
      id,
      tier: 'tier-1',
      provider: 'openai',
      protocol: 'openai',
      surfaces: ['responses'],
      baseUrl: `https://${id}.example.com/v1`,
      credential: `secret-${id}`,
      priority: 10,
      models,
    };
  }

  const shared = node('acct-a', { 'Code-Max': 'real-shared', 'Code-Pro': 'real-shared', 'Code-Ultra': 'real-ultra' });
  const peer = node('acct-b', { 'Code-Pro': 'real-shared' });
  assert.equal(modelFailureDomainKey(shared, 'Code-Max'), modelFailureDomainKey(shared, 'Code-Pro'));
  assert.notEqual(modelFailureDomainKey(shared, 'Code-Max'), modelFailureDomainKey(shared, 'Code-Ultra'));
  assert.notEqual(modelFailureDomainKey(shared, 'Code-Pro'), modelFailureDomainKey(peer, 'Code-Pro'));
  assert.doesNotMatch(modelFailureDomainKey(shared, 'Code-Max'), /secret-acct-a/);

  const failed = new Set();
  rememberFailedDomains(failed, new Map([[shared.id, shared]]), new Set([shared.id]), 'Code-Max');
  assert.deepEqual([...failedDomainNodeIds([shared], 'Code-Pro', failed)], ['acct-a']);
  assert.deepEqual([...failedDomainNodeIds([shared], 'Code-Ultra', failed)], []);

  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ host: url.hostname, model: body.model });
    return new Response(JSON.stringify({ error: { message: 'temporary upstream failure' } }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  };

  function envFor(nodes) {
    const configs = nodes.map(({ id, provider, baseUrl, priority, models }) => ({
      id,
      provider,
      base_url: baseUrl,
      priority,
      models,
    }));
    return {
      AIG_ACCESS_KEY_ULTRA: ACCESS_KEY,
      AIG_ACCESS_MODELS_ULTRA: '*',
      TIER1_SCHEDULER_SEED: 'family-domain-test',
      AIG_PROTOCOL_FALLBACKS: 'disable',
      AIG_TIER1_NODES_01: JSON.stringify(configs),
      AIG_TIER1_CREDENTIALS_01: JSON.stringify(Object.fromEntries(nodes.map((n) => [n.id, n.credential]))),
    };
  }

  function request() {
    return new Request('https://gateway.example.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
      body: JSON.stringify({ model: 'Code-Max', input: 'continue the task' }),
    });
  }

  reset();
  const oneDomain = node('shared-account', {
    'Code-Max': 'same-real-model',
    'Code-Pro': 'same-real-model',
    'Code-Ultra': 'same-real-model',
  });
  const collapsed = await worker.fetch(request(), envFor([oneDomain]), {});
  assert.equal(collapsed.status, 503);
  const collapsedBody = await collapsed.json();
  assert.match(collapsedBody?.error?.message || '', /compatible-model failover plan/i);
  assert.equal(collapsed.headers.get('x-gateway-error-code'), 'gateway_attempt_budget_exhausted');
  assert.deepEqual(calls, [{ host: 'shared-account.example.com', model: 'same-real-model' }]);
  assert.equal(collapsed.headers.get('x-gateway-attempts'), '1');
  assert.equal(collapsed.headers.get('x-gateway-dispatches'), '1');
  assert.equal(collapsed.headers.get('x-gateway-failure-kinds'), 'server:1');

  reset();
  const distinctModels = node('multi-model-account', {
    'Code-Max': 'real-max',
    'Code-Pro': 'real-pro',
    'Code-Ultra': 'real-ultra',
  });
  const distinct = await worker.fetch(request(), envFor([distinctModels]), {});
  assert.equal(distinct.status, 503);
  assert.deepEqual(
    calls.map((c) => c.model),
    ['real-max', 'real-pro', 'real-ultra'],
  );
  assert.equal(distinct.headers.get('x-gateway-attempts'), '3');
  assert.equal(distinct.headers.get('x-gateway-dispatches'), '3');
  assert.equal(distinct.headers.get('x-gateway-failure-kinds'), 'server:3');

  reset();
  const accountA = node('account-a', { 'Code-Max': 'real-shared', 'Code-Pro': 'real-shared', 'Code-Ultra': 'real-shared' });
  const accountB = node('account-b', { 'Code-Max': 'real-shared', 'Code-Pro': 'real-shared', 'Code-Ultra': 'real-shared' });
  const twoAccounts = await worker.fetch(request(), envFor([accountA, accountB]), {});
  assert.equal(twoAccounts.status, 503);
  assert.equal(calls.length, 2);
  assert.deepEqual(new Set(calls.map((c) => c.host)), new Set(['account-a.example.com', 'account-b.example.com']));
  assert.equal(twoAccounts.headers.get('x-gateway-attempts'), '2');

  console.log('model-family failure-domain tests passed.');
  console.log('ok - file:model-family-failure-domain');
} catch (error) {
  console.error('not ok - model-family-failure-domain-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// fallback-conversion-observability-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs








  const ACCESS_KEY = 'test-access-key';
  const PRIVATE_TEXT = 'PRIVATE_PROMPT_DO_NOT_LOG';

  __resetAllStateForTests();
  __resetTier1StateForTests();
  __resetTier1AffinityForTests();

  const structuredSchema = {
    type: 'object',
    properties: {
      answer: { type: 'string' },
      confidence: { type: 'number' },
    },
    required: ['answer'],
    additionalProperties: false,
  };
  const structured = convertAnthropicToOpenAIRequest({
    model: 'code-max',
    max_tokens: 1024,
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema: structuredSchema },
    },
    messages: [{ role: 'user', content: 'answer the question' }],
  });
  assert.equal(structured.messages[0].role, 'system');
  assert.match(structured.messages[0].content, /final assistant text response/);
  assert.ok(structured.messages[0].content.includes(JSON.stringify(structuredSchema)));
  assert.deepEqual(structured.messages[1], { role: 'user', content: 'answer the question' });
  assert.equal(Object.hasOwn(structured, 'output_config'), false);

  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    upstreamCalls++;
    throw new Error('upstream must not be called when conversion is rejected');
  };

  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args.map((arg) => String(arg)).join(' '));

  try {
    const env = {
      AIG_ACCESS_KEY_AIR: ACCESS_KEY,
      AIG_ACCESS_MODELS_AIR: '*',
      AIG_PROTOCOL_FALLBACKS: JSON.stringify({
        'anthropic:messages': ['openai:chat_completions'],
      }),
      AIG_TIER1_NODES_01: JSON.stringify([
        {
          id: 'openai-only',
          provider: 'mock',
          base_url: 'https://openai-only.example.com/v1',
          models: { 'code-max': 'up-model' },
        },
      ]),
      AIG_TIER1_CREDENTIALS_01: JSON.stringify({ 'openai-only': 'upstream-key' }),
    };

    const request = new Request('https://gateway.example.com/v1/messages?beta=true', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ACCESS_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'code-max',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'thinking', thinking: PRIVATE_TEXT },
              { type: 'text', text: 'hello' },
            ],
          },
        ],
      }),
    });

    const response = await worker.fetch(request, env, {});
    assert.equal(response.status, 502, 'pre-dispatch conversion incompatibility must be reported as 502, not cooldown 429');
    assert.equal(upstreamCalls, 0, 'conversion failure must not dispatch upstream');

    const body = await response.json();
    assert.equal(body.type, 'error');
    assert.equal(body.error.message, 'Configured protocol fallback cannot represent this request.');
    assert.equal(body.error.details.failure_kind, 'conversion_not_supported');
    assert.equal(body.error.details.dispatches, 0);

    const recordLine = logs.find((line) => line.includes('fallback_conversion_skipped'));
    assert.ok(recordLine, 'conversion rejection must emit a searchable diagnostic');
    const record = JSON.parse(recordLine);
    assert.equal(record.event, 'fallback_conversion_skipped');
    assert.equal(record.route, 'anthropic_messages');
    assert.equal(record.fallback_protocol, 'openai');
    assert.equal(record.fallback_surface, 'chat_completions');
    assert.match(record.reason, /conversion_not_supported: user content\.thinking/);
    assert.equal(record.request_id, response.headers.get('request-id'));

    const joinedLogs = logs.join('\n');
    assert.equal(joinedLogs.includes(PRIVATE_TEXT), false, 'request content must never be logged');
    assert.equal(joinedLogs.includes(ACCESS_KEY), false, 'gateway credential must never be logged');
    assert.equal(joinedLogs.includes('upstream-key'), false, 'upstream credential must never be logged');

    console.log('fallback conversion observability test passed');
  } finally {
    console.error = originalError;
    globalThis.fetch = originalFetch;
  }
  console.log('ok - file:fallback-conversion-observability');
} catch (error) {
  console.error('not ok - fallback-conversion-observability-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// responses-error-diagnostics-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs
  //
  // Responses/Codex terminal-error diagnostics contract. The OpenAI-compatible
  // body remains unchanged (`error.code === null`); Gateway-owned routing
  // classification and aggregate counters travel only in non-sensitive headers.











  const ACCESS_KEY = 'responses-diagnostics-key';
  let routeHandlers = {};
  function reset() {
    __resetAllStateForTests();
    __resetTier1StateForTests();
    __resetTier1AffinityForTests();
    __resetAdaptive429StateForTests();
    routeHandlers = {};
  }

  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const handler = routeHandlers[url.hostname];
    if (!handler) throw new Error(`no mock upstream for ${url.hostname}`);
    if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return handler(input, init);
  };

  const node = (id) => ({
    id,
    provider: 'openai',
    base_url: `https://${id}.example.com/v1`,
    models: { 'code-max': 'up-model' },
  });

  function envFor(id, extra = {}) {
    return {
      AIG_ACCESS_KEY_AIR: ACCESS_KEY,
      AIG_ACCESS_MODELS_AIR: '*',
      TIER1_SCHEDULER_SEED: 'responses-diagnostics-test',
      AIG_TIER1_NODES_01: JSON.stringify([node(id)]),
      AIG_TIER1_CREDENTIALS_01: JSON.stringify({ [id]: 'k' }),
      ...extra,
    };
  }

  function request(model = 'code-max') {
    return new Request('https://gateway.example.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
      body: JSON.stringify({ model, input: 'hi' }),
    });
  }
  function json(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
  }

  assert.equal(terminalStatus({ [KIND.RATE_LIMIT]: 1, [KIND.HEADERS_TIMEOUT]: 1 }), 504);
  assert.equal(terminalStatus({ [KIND.HEADERS_TIMEOUT]: 1, [KIND.RATE_LIMIT]: 1 }), 504);
  assert.equal(terminalStatus({ [KIND.RATE_LIMIT]: 1, [KIND.SERVER]: 1 }), 502);
  assert.equal(terminalStatus({ [KIND.SERVER]: 1, [KIND.RATE_LIMIT]: 1 }), 502);
  assert.equal(terminalStatus({ [KIND.RATE_LIMIT]: 1, [KIND.RATE_LIMIT_GLOBAL]: 1, [KIND.SERVER]: 1 }), 429);
  assert.equal(terminalStatus({ [KIND.HEADERS_TIMEOUT]: 1, [KIND.FIRST_EVENT_TIMEOUT]: 1, [KIND.SERVER]: 1 }), 504);
  assert.equal(terminalStatus({}), null);
  assert.equal(buildResponsesError('x', 'api_error').error.code, null);

  reset();
  routeHandlers['cool.example.com'] = () => json({ error: { message: 'rate' } }, 429, { 'retry-after': '30' });
  const coolingEnv = envFor('cool');
  await worker.fetch(request(), coolingEnv, {});
  const cooling = await worker.fetch(request(), coolingEnv, {});
  assert.equal(cooling.status, 429);
  const coolingBody = await cooling.json();
  assert.equal(coolingBody.error.type, 'rate_limit_error');
  assert.equal(coolingBody.error.code, null);
  assert.equal(cooling.headers.get('x-gateway-error-code'), 'gateway_no_dispatchable_node');
  assert.equal(cooling.headers.get('x-gateway-attempts'), '0');
  assert.equal(cooling.headers.get('x-gateway-dispatches'), '0');
  assert.equal(cooling.headers.get('x-gateway-hedges'), '0');
  assert.equal(cooling.headers.get('x-gateway-failure-kinds'), null);
  assert.ok(Number(cooling.headers.get('retry-after')) > 0);

  reset();
  routeHandlers['dead.example.com'] = () => json({}, 503);
  const dead = await worker.fetch(request(), envFor('dead'), {});
  assert.equal(dead.status, 502);
  const deadBody = await dead.json();
  assert.equal(deadBody.error.type, 'api_error');
  assert.equal(deadBody.error.code, null);
  assert.equal(dead.headers.get('x-gateway-error-code'), 'gateway_upstream_exhausted');
  assert.equal(dead.headers.get('x-gateway-attempts'), '1');
  assert.equal(dead.headers.get('x-gateway-dispatches'), '1');
  assert.equal(dead.headers.get('x-gateway-hedges'), '0');
  assert.equal(dead.headers.get('x-gateway-failure-kinds'), 'server:1');
  assert.equal(dead.headers.get('x-gateway-node'), null);
  assert.equal(dead.headers.get('x-gateway-provider'), null);

  reset();
  routeHandlers['badreq.example.com'] = () => json({ error: { message: 'bad input' } }, 400);
  const badReq = await worker.fetch(request(), envFor('badreq'), {});
  assert.equal(badReq.status, 502);
  const badReqBody = await badReq.json();
  assert.equal(badReqBody.error.type, 'api_error');
  assert.equal(badReqBody.error.code, null);
  assert.equal(badReq.headers.get('x-gateway-error-code'), 'gateway_upstream_exhausted');
  assert.equal(badReq.headers.get('x-gateway-attempts'), '1');
  assert.equal(badReq.headers.get('x-gateway-dispatches'), '1');
  assert.equal(badReq.headers.get('x-gateway-failure-kinds'), 'client:1');
  assert.equal(badReqBody.error.message, 'All attempted nodes failed for model "code-max".');
  assert.ok(!JSON.stringify(badReqBody).includes('bad input'), 'raw upstream 4xx message must be hidden by default');

  reset();
  routeHandlers['badreq-exposed.example.com'] = () => json({ error: { message: 'provider-specific bad input' } }, 400);
  const badReqExposed = await worker.fetch(request(), envFor('badreq-exposed', { AIG_SHOULD_EXPOSE_UPSTREAM: 'true' }), {});
  assert.equal(badReqExposed.status, 502);
  const badReqExposedBody = await badReqExposed.json();
  assert.equal(badReqExposedBody.error.message, 'All attempted nodes failed for model "code-max".');
  assert.equal(badReqExposed.headers.get('x-gateway-failure-kinds'), 'client:1');

  reset();
  const unknown = await worker.fetch(request('not-a-model'), envFor('unused'), {});
  assert.equal(unknown.status, 404);
  const unknownBody = await unknown.json();
  assert.equal(unknownBody.error.type, 'not_found_error');
  assert.equal(unknownBody.error.code, null);
  assert.equal(unknown.headers.get('x-gateway-error-code'), null);
  assert.equal(unknown.headers.get('x-gateway-attempts'), null);
  assert.equal(unknown.headers.get('x-gateway-dispatches'), null);

  console.log('responses error diagnostics tests passed.');
  console.log('ok - file:responses-error-diagnostics');
} catch (error) {
  console.error('not ok - responses-error-diagnostics-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// protocol-matrix-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Current protocol-routing matrix: Provider profiles own native surfaces,
  // Chat/Messages conversion is explicit/bounded, Responses remains Native Only.






  const ACCESS_KEY = 'test-access-key';
  let passed = 0;
  const calls = [];
  let handlers = {};
  async function test(name, fn) {
    try {
      __resetAllStateForTests();
      __resetTier1StateForTests();
      __resetTier1AffinityForTests();
      calls.length = 0;
      handlers = {};
      await fn();
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (error) {
      console.error(`FAIL: ${name}`);
      console.error(error?.stack || error);
      process.exitCode = 1;
    }
  }

  globalThis.fetch = async (input, init) => {
    const source = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const url = new URL(source);
    const handler = handlers[url.hostname];
    if (!handler) throw new Error(`no mock upstream for ${url.hostname}`);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    let bodyText = init?.body;
    if (bodyText === undefined && input instanceof Request) bodyText = await input.clone().text();
    const body = typeof bodyText === 'string' && bodyText ? JSON.parse(bodyText) : null;
    calls.push({ host: url.hostname, path: url.pathname, headers, body });
    return handler(url, init, body);
  };

  const chatNode = (id) => ({ id, provider: 'mock', base_url: `https://${id}.example.com/v1`, models: { max: 'up-model' } });
  const openaiNode = (id) => ({ id, provider: 'openai', base_url: `https://${id}.example.com/v1`, models: { max: 'up-model' } });
  const messagesNode = (id) => ({ id, provider: 'anthropic', base_url: `https://${id}.example.com`, models: { max: 'up-model' } });
  function env(nodes, extra = {}) {
    return {
      AIG_ACCESS_KEY_AIR: ACCESS_KEY,
      AIG_ACCESS_MODELS_AIR: 'max',
      AIG_TIER1_NODES_01: JSON.stringify(nodes),
      AIG_TIER1_CREDENTIALS_01: JSON.stringify(Object.fromEntries(nodes.map((n) => [n.id, `key-${n.id}`]))),
      TIER1_SCHEDULER_SEED: 'protocol-matrix',
      AIG_MODELS_CONFIG: JSON.stringify({ max: { policy: 'default' } }),
      ...extra,
    };
  }

  const auth = { authorization: `Bearer ${ACCESS_KEY}`, 'content-type': 'application/json' };
  const chatRequest = (extra = {}) =>
    new Request('https://gateway.example.com/v1/chat/completions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'max', messages: [{ role: 'user', content: 'hi' }], ...extra }),
    });
  const responsesRequest = (extra = {}) =>
    new Request('https://gateway.example.com/v1/responses', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'max', input: 'hi', ...extra }),
    });
  const messagesRequest = (extra = {}) =>
    new Request('https://gateway.example.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ACCESS_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'max', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], ...extra }),
    });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const chatOk = () => ({
    id: 'chat-1',
    object: 'chat.completion',
    model: 'up-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  const messageOk = () => ({
    id: 'msg-1',
    type: 'message',
    role: 'assistant',
    model: 'up-model',
    content: [{ type: 'text', text: 'hello' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const responsesOk = () => ({
    id: 'resp-1',
    object: 'response',
    status: 'completed',
    model: 'up-model',
    output: [{ id: 'm1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  });

  await test('Chat uses OpenAI-compatible providers and never Anthropic when conversion is disabled', async () => {
    handlers['chat.example.com'] = () => json(chatOk());
    handlers['anth.example.com'] = () => json(messageOk());
    const res = await worker.fetch(chatRequest(), env([messagesNode('anth'), chatNode('chat')], { AIG_PROTOCOL_FALLBACKS: 'disable' }), {});
    assert.equal(res.status, 200);
    assert.deepEqual(
      calls.map((c) => c.host),
      ['chat.example.com'],
    );
    assert.equal(calls[0].path, '/v1/chat/completions');
  });

  await test('Chat failover stays inside the same native surface', async () => {
    handlers['a.example.com'] = () => json({ error: 'down' }, 500);
    handlers['b.example.com'] = () => json(chatOk());
    const res = await worker.fetch(chatRequest(), env([chatNode('a'), chatNode('b')], { AIG_PROTOCOL_FALLBACKS: 'disable' }), {});
    assert.equal(res.status, 200);
    assert.deepEqual(
      calls.map((c) => c.host),
      ['a.example.com', 'b.example.com'],
    );
    assert.ok(calls.every((c) => c.path === '/v1/chat/completions'));
  });

  await test('Responses uses only the OpenAI provider profile', async () => {
    handlers['chat.example.com'] = () => json(chatOk());
    handlers['oa.example.com'] = () => json(responsesOk());
    const res = await worker.fetch(responsesRequest(), env([chatNode('chat'), openaiNode('oa')], { AIG_PROTOCOL_FALLBACKS: 'disable' }), {});
    assert.equal(res.status, 200);
    assert.deepEqual(
      calls.map((c) => c.host),
      ['oa.example.com'],
    );
    assert.equal(calls[0].path, '/v1/responses');
  });

  await test('Responses remains Native Only and never converts to Messages', async () => {
    handlers['anth.example.com'] = () => json(messageOk());
    const res = await worker.fetch(responsesRequest(), env([messagesNode('anth')]), {});
    assert.notEqual(res.status, 200);
    assert.equal(calls.length, 0);
  });

  await test('Messages uses only Anthropic provider when conversion is disabled', async () => {
    handlers['chat.example.com'] = () => json(chatOk());
    handlers['anth.example.com'] = () => json(messageOk());
    const res = await worker.fetch(messagesRequest(), env([chatNode('chat'), messagesNode('anth')], { AIG_PROTOCOL_FALLBACKS: 'disable' }), {});
    assert.equal(res.status, 200);
    assert.deepEqual(
      calls.map((c) => c.host),
      ['anth.example.com'],
    );
    assert.equal(calls[0].path, '/v1/messages');
    assert.equal(calls[0].headers.get('x-api-key'), 'key-anth');
  });

  await test('Chat falls back to Messages only through configured conversion', async () => {
    handlers['chat.example.com'] = () => json({ error: 'down' }, 500);
    handlers['anth.example.com'] = () => json(messageOk());
    const res = await worker.fetch(
      chatRequest(),
      env([chatNode('chat'), messagesNode('anth')], {
        AIG_PROTOCOL_FALLBACKS: JSON.stringify({
          'openai:chat_completions': ['anthropic:messages'],
          'anthropic:messages': ['openai:chat_completions'],
        }),
      }),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.choices[0].message.content, 'hello');
    assert.deepEqual(
      calls.map((c) => c.path),
      ['/v1/chat/completions', '/v1/messages'],
    );
  });

  await test('Messages falls back to Chat only through configured conversion', async () => {
    handlers['anth.example.com'] = () => json({ error: 'down' }, 500);
    handlers['chat.example.com'] = () => json(chatOk());
    const res = await worker.fetch(
      messagesRequest(),
      env([messagesNode('anth'), chatNode('chat')], {
        AIG_PROTOCOL_FALLBACKS: JSON.stringify({
          'anthropic:messages': ['openai:chat_completions'],
          'openai:chat_completions': ['anthropic:messages'],
        }),
      }),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.type, 'message');
    assert.equal(body.content[0].text, 'hello');
    assert.deepEqual(
      calls.map((c) => c.path),
      ['/v1/messages', '/v1/chat/completions'],
    );
  });

  await test('disable turns off the built-in Chat/Messages fallback', async () => {
    handlers['anth.example.com'] = () => json(messageOk());
    const res = await worker.fetch(chatRequest(), env([messagesNode('anth')], { AIG_PROTOCOL_FALLBACKS: 'disable' }), {});
    assert.notEqual(res.status, 200);
    assert.equal(calls.length, 0);
  });

  await test('hedge twin stays inside the same provider wire profile', async () => {
    handlers['slow.example.com'] = (_url, init) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(json(chatOk())), 2_000);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
    handlers['fast.example.com'] = () => json(chatOk());
    handlers['anth.example.com'] = () => json(messageOk());
    const res = await worker.fetch(
      chatRequest(),
      env([chatNode('slow'), chatNode('fast'), messagesNode('anth')], {
        AIG_PROTOCOL_FALLBACKS: 'disable',
        AIG_HEDGE_DELAY_MS: '50',
        AIG_FAILOVER_BUDGET_MS: '5000',
        AIG_POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 3, hedge: { enabled: true, delay_ms: 50, tiers: ['tier1'] } } }),
      }),
      {},
    );
    assert.equal(res.status, 200);
    assert.deepEqual(
      calls.map((c) => c.host),
      ['slow.example.com', 'fast.example.com'],
    );
    assert.ok(calls.every((c) => c.path === '/v1/chat/completions'));
  });

  await test('protocol or surfaces in Node JSON are rejected before dispatch', async () => {
    handlers['broken.example.com'] = () => json(chatOk());
    for (const extra of [{ protocol: 'openai' }, { surfaces: ['chat_completions'] }]) {
      calls.length = 0;
      const res = await worker.fetch(chatRequest(), env([{ ...chatNode('broken'), ...extra }], { AIG_PROTOCOL_FALLBACKS: 'disable' }), {});
      assert.notEqual(res.status, 200);
      assert.equal(calls.length, 0);
    }
  });

  await test('requested model identity is preserved in native client response', async () => {
    handlers['chat.example.com'] = () => json(chatOk());
    const res = await worker.fetch(chatRequest(), env([chatNode('chat')], { AIG_PROTOCOL_FALLBACKS: 'disable' }), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.model, 'max');
    assert.equal(calls[0].body.model, 'up-model');
  });

  if (process.exitCode) suiteExit(1);
  console.log(`\nprotocol-matrix tests passed (${passed}).`);
  console.log('ok - file:protocol-matrix');
} catch (error) {
  console.error('not ok - protocol-matrix-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}
