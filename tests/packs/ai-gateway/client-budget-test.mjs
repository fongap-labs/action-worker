// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import { assert, test } from '#kit/harness.mjs';
import { withMockFetch } from '#kit/fetch.mjs';
import worker from '#target/src/index.ts';
import { corsHeaders } from '#target/src/protocol/http.ts';
import { gatewayError, buildBudgetExhaustedResponse, buildExhaustedResponse } from '#target/src/request/errors.ts';
import { preflight } from '#target/src/request/preflight.ts';
import { buildWranglerConfig, DEFAULT_OPTIMAL_VARS } from '#target/scripts/github-deployment-config.mjs';
import { makeEnv, AIR_KEY } from './hardening-fixtures.mjs';

const ctx = { waitUntil() {} };
const state = () => ({ logicalAttempts: 3, dispatches: 3, hedges: 0, attempts: [], failureKinds: { headers_timeout: 3 } });
const request = (deadline, route = '/v1/chat/completions') => new Request(`https://gateway.example.com${route}`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${AIR_KEY}`,
    'content-type': 'application/json',
    ...(deadline === undefined ? {} : { 'x-gateway-deadline-ms': String(deadline) }),
  },
  body: JSON.stringify({ model: 'Code-Max', messages: [{ role: 'user', content: 'hi' }], input: 'hi', max_tokens: 32 }),
});

test('expired deadlines stop before dispatch on every protocol surface', async () => {
  let calls = 0;
  await withMockFetch(async () => { calls++; throw new Error('unexpected dispatch'); }, async () => {
    for (const route of ['/v1/chat/completions', '/v1/messages', '/v1/responses']) {
      const response = await worker.fetch(request(Date.now() - 1, route), makeEnv(), ctx);
      assert.equal(response.status, 408);
      assert.equal(response.headers.get('x-gateway-error-code'), 'gateway_client_deadline_exceeded');
      assert.equal(response.headers.get('x-gateway-retryable'), 'false');
      assert.equal(response.headers.get('x-should-retry'), 'false');
    }
  });
  assert.equal(calls, 0);
});

test('invalid deadline values are rejected without interpreting relative durations', async () => {
  for (const value of ['', 'NaN', '1e12', '-1', '9007199254740992']) {
    const result = await preflight(request(value), makeEnv(), ctx);
    assert.equal(result.ok, false);
    assert.equal(result.response.status, 400);
  }
});

test('a client deadline shortens the request budget and cannot extend server policy', async () => {
  const soon = Date.now() + 5_000;
  const limited = await preflight(request(soon), makeEnv(), ctx);
  assert.equal(limited.ok, true);
  assert.equal(limited.failoverBudgetMs, soon - limited.requestStartMs);
  const baseline = await preflight(request(), makeEnv(), ctx);
  const later = await preflight(request(Date.now() + 86_400_000), makeEnv(), ctx);
  assert.equal(baseline.ok, true);
  assert.equal(later.ok, true);
  assert.equal(later.failoverBudgetMs, baseline.failoverBudgetMs);
});

test('reusing an expired step deadline never gives a client retry a new budget', async () => {
  const deadline = Date.now() - 1;
  for (let i = 0; i < 2; i++) {
    const result = await preflight(request(deadline), makeEnv(), ctx);
    assert.equal(result.response.status, 408);
  }
});

test('terminal errors expose consistent retry and attempt headers while preserving protocol bodies', async () => {
  for (const route of ['openai_chat', 'anthropic_messages', 'openai_responses']) {
    const response = gatewayError(request(), {}, route, 503, 'capacity unavailable', 'request-1',
      { attempts: 3, dispatches: 3, hedges: 0, failure_kinds: { rate_limit: 3 } },
      { 'retry-after': '30' }, 'gateway_attempt_budget_exhausted', true);
    assert.equal(response.headers.get('x-gateway-retryable'), 'true');
    assert.equal(response.headers.get('x-gateway-budget-exhausted'), 'true');
    assert.equal(response.headers.get('x-gateway-attempts'), '3');
    assert.equal(response.headers.get('x-gateway-dispatches'), '3');
    assert.equal(response.headers.get('x-gateway-failure-kinds'), 'rate_limit:3');
    assert.equal(response.headers.get('retry-after'), '30');
    const body = await response.json();
    assert.equal(body.error.message, 'capacity unavailable');
    if (route === 'openai_responses') assert.equal(body.error.code, null);
    else {
      assert.equal(body.error.details.gateway_code, 'gateway_attempt_budget_exhausted');
      assert.equal(body.error.details.retryable, true);
      assert.equal(body.error.details.retry_after_ms, 30_000);
    }
    if (route === 'anthropic_messages') assert.equal(body.type, 'error');
  }
});

test('a deadline that expires during failover is non-retryable at either terminal path', () => {
  const req = request(Date.now() - 1);
  const budget = buildBudgetExhaustedResponse(req, {}, 'openai_chat', 'request-1', 'Code-Max', state(), false);
  const exhausted = buildExhaustedResponse(req, {}, 'openai_chat', 'request-1', 'Code-Max', state(), {}, false, {});
  for (const response of [budget, exhausted]) {
    assert.equal(response.status, 408);
    assert.equal(response.headers.get('x-gateway-retryable'), 'false');
    assert.equal(response.headers.get('x-should-retry'), 'false');
  }
});

test('ordinary failover exhaustion remains retryable within a future client deadline', () => {
  const response = buildBudgetExhaustedResponse(request(Date.now() + 60_000), {}, 'openai_chat', 'request-1', 'Code-Max', state(), false);
  assert.equal(response.status, 504);
  assert.equal(response.headers.get('x-gateway-retryable'), 'true');
  assert.equal(response.headers.get('x-gateway-budget-exhausted'), 'true');
});

test('browser clients can send deadlines and session ids and read retry diagnostics', () => {
  const req = new Request('https://gateway.example.com', { headers: {
    'access-control-request-headers': 'authorization,x-session-id,x-gateway-deadline-ms,x-unapproved',
  } });
  const headers = corsHeaders(req, { AIG_CORS_ORIGIN: 'https://client.example.com' });
  assert.match(headers['Access-Control-Allow-Headers'], /x-session-id/);
  assert.match(headers['Access-Control-Allow-Headers'], /x-gateway-deadline-ms/);
  assert.doesNotMatch(headers['Access-Control-Allow-Headers'], /x-unapproved/);
  assert.match(headers['Access-Control-Expose-Headers'], /X-Gateway-Retryable/);
});

test('deployment defaults bound free-tier amplification and preserve explicit overrides', () => {
  assert.equal(DEFAULT_OPTIMAL_VARS.AIG_STREAM_MAX_ATTEMPTS, '3');
  assert.equal(DEFAULT_OPTIMAL_VARS.AIG_NONSTREAM_MAX_ATTEMPTS, '3');
  assert.equal(DEFAULT_OPTIMAL_VARS.AIG_ISOLATE_MAX_IN_FLIGHT, '8');
  const config = buildWranglerConfig({ AIG_STREAM_MAX_ATTEMPTS: '5', AIG_ISOLATE_MAX_IN_FLIGHT: '16' });
  assert.equal(config.vars.AIG_STREAM_MAX_ATTEMPTS, '5');
  assert.equal(config.vars.AIG_ISOLATE_MAX_IN_FLIGHT, '16');
});
