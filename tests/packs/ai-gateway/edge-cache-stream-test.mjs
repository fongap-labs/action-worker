// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Edge cache: streamed and non-streamed answers never share an entry, entries are scoped to the
// credential that was presented, automatic caching is opt-in, and unsafe responses are not stored.

import { assert, test } from '#kit/harness.mjs';
import {
  buildEdgeCacheKeyRequest,
  callerCacheScope,
  edgeCacheEligible,
  resolveEdgeCachePlan,
  storeEdgeCacheResponse,
} from '#target/src/request/edge-cache.ts';

const body = { temperature: 0, messages: [{ role: 'user', content: 'hi' }] };
const ENV = { AIG_TOKEN_ENCRYPTION_KEY: 'k'.repeat(32) };

function req(headers = {}) {
  return new Request('https://gateway.example.com/v1/chat/completions', { method: 'POST', headers });
}

async function urlFor(options) {
  return (await buildEdgeCacheKeyRequest('openai_chat', 'Code-Max', body, 'AIR', options)).url;
}

test('a streamed request never shares the entry of a non-streamed one', async () => {
  assert.notEqual(await urlFor({ stream: true }), await urlFor({ stream: false }));
  const streamed = { ...body, stream: true };
  const key = async (b) => (await buildEdgeCacheKeyRequest('openai_chat', 'Code-Max', b, 'AIR')).url;
  assert.notEqual(await key(streamed), await key(body));
  assert.equal(await key({ ...body, stream: false }), await key(body));
});

test('stream_options only matter for a streamed request', async () => {
  const withUsage = { ...body, stream: true, stream_options: { include_usage: true } };
  const without = { ...body, stream: true };
  const key = async (b) => (await buildEdgeCacheKeyRequest('openai_chat', 'Code-Max', b, 'AIR')).url;
  assert.notEqual(await key(withUsage), await key(without));
  assert.equal(
    await key({ ...body, stream_options: { include_usage: true } }),
    await key(body),
  );
});

test('entries are scoped to the credential the caller presented', async () => {
  const a = await callerCacheScope(req({ authorization: 'Bearer secret-a' }), ENV);
  const b = await callerCacheScope(req({ authorization: 'Bearer secret-b' }), ENV);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
  assert.equal(a, await callerCacheScope(req({ 'x-api-key': 'secret-a' }), ENV));
  assert.ok(!a.includes('secret-a'));
  assert.notEqual(await urlFor({ scope: a }), await urlFor({ scope: b }));
  // The fingerprint is keyed: another deployment secret gives another fingerprint.
  assert.notEqual(a, await callerCacheScope(req({ authorization: 'Bearer secret-a' }), { AIG_TOKEN_ENCRYPTION_KEY: 'z'.repeat(32) }));
  assert.equal(await callerCacheScope(req(), ENV), '');
});

test('temperature 0 is only cached automatically when AIG_EDGE_CACHE_AUTO is on', () => {
  assert.equal(edgeCacheEligible('openai_chat', body, req()), false);
  assert.equal(edgeCacheEligible('openai_chat', body, req(), {}), false);
  assert.equal(edgeCacheEligible('openai_chat', body, req(), { AIG_EDGE_CACHE_AUTO: 'true' }), true);
  assert.equal(edgeCacheEligible('openai_chat', { ...body, temperature: 0.7 }, req(), { AIG_EDGE_CACHE_AUTO: 'true' }), false);
  assert.equal(edgeCacheEligible('openai_chat', { messages: [] }, req({ 'x-gateway-cache': 'true' })), true);
  assert.equal(edgeCacheEligible('models', body, req({ 'x-gateway-cache': 'true' }), { AIG_EDGE_CACHE_AUTO: 'true' }), false);
});

test('the cache plan keys on the caller credential and the client stream choice', async () => {
  const request = req({ authorization: 'Bearer secret-a', 'x-gateway-cache': 'true' });
  const plain = await resolveEdgeCachePlan('openai_chat', 'Code-Max', body, request, ENV, 'AIR', false);
  const streamed = await resolveEdgeCachePlan('openai_chat', 'Code-Max', body, request, ENV, 'AIR', true);
  const other = await resolveEdgeCachePlan('openai_chat', 'Code-Max', body, req({ authorization: 'Bearer secret-b', 'x-gateway-cache': 'true' }), ENV, 'AIR', false);
  assert.equal(plain.stream, false);
  assert.equal(streamed.stream, true);
  assert.notEqual(plain.keyRequest.url, streamed.keyRequest.url);
  assert.notEqual(plain.keyRequest.url, other.keyRequest.url);
  assert.equal(await resolveEdgeCachePlan('openai_chat', 'Code-Max', body, req({ authorization: 'Bearer x' }), ENV, 'AIR', false), null);
});

function withFakeCache(run) {
  return async () => {
    const stored = [];
    const previous = globalThis.caches;
    globalThis.caches = { default: { put: async (key, value) => stored.push([key, await value.text()]), match: async () => undefined } };
    try {
      await run(stored);
    } finally {
      globalThis.caches = previous;
    }
  };
}

async function store(response, stream) {
  const pending = [];
  storeEdgeCacheResponse({ waitUntil: (p) => pending.push(p) }, new Request('https://edge-cache.ai-gateway.internal/x'), response, 60, stream);
  await Promise.all(pending);
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const sse = (text) => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });

test('a plain JSON answer is stored with the HIT marker', withFakeCache(async (stored) => {
  await store(json({ choices: [{ message: { content: 'ok' } }] }), false);
  assert.equal(stored.length, 1);
  assert.match(stored[0][1], /"content":"ok"/);
}));

test('answers that ask the client to run a tool are never stored', withFakeCache(async (stored) => {
  await store(json({ choices: [{ message: { tool_calls: [{ id: 'c1' }] } }] }), false);
  await store(json({ choices: [{ message: { function_call: { name: 'f' } } }] }), false);
  await store(json({ content: [{ type: 'tool_use', id: 't1' }] }), false);
  await store(sse('data: {"choices":[{"delta":{"tool_calls":[{"index":0}]}}]}\n\ndata: [DONE]\n\n'), true);
  assert.deepEqual(stored, []);
}));

test('a response whose shape does not match the key is not stored', withFakeCache(async (stored) => {
  await store(sse('data: {"x":1}\n\ndata: [DONE]\n\n'), false);
  await store(json({ ok: true }), true);
  await store(new Response('plain', { status: 200, headers: { 'content-type': 'text/plain' } }), false);
  await store(json({ error: 1 }, 500), false);
  assert.deepEqual(stored, []);
}));

test('only a stream that ended normally is stored', withFakeCache(async (stored) => {
  await store(sse('data: {"choices":[{"delta":{"content":"par'), true);
  assert.deepEqual(stored, []);
  await store(sse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'), true);
  await store(sse('event: message_stop\ndata: {"type":"message_stop"}\n\n'), true);
  assert.equal(stored.length, 2);
}));
