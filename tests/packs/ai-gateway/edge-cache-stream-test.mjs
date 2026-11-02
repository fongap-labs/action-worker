// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Edge cache: streamed and non-streamed answers never share an entry, entries are scoped to the
// credential that was presented, caching requires explicit caller opt-in, and unsafe responses are not stored.

import { assert, test } from '#kit/harness.mjs';
import {
  buildEdgeCacheKeyRequest,
  callerCacheScope,
  edgeCacheEligible,
  injectMissHeader,
  matchEdgeCache,
  resolveEdgeCachePlan,
  storeEdgeCacheResponse,
} from '#target/src/request/edge-cache.ts';

const body = { temperature: 0, messages: [{ role: 'user', content: 'hi' }] };
const ENV = { AIG_TOKEN_ENCRYPTION_KEY: 'k'.repeat(32) };

function req(headers = {}) {
  return new Request('https://gateway.example.com/v1/chat/completions', { method: 'POST', headers });
}

async function urlFor(options) {
  return (await buildEdgeCacheKeyRequest('openai_chat', 'Code-Max', body, 'AIR', { host: 'gateway.example.com', ...options })).url;
}

test('a streamed request never shares the entry of a non-streamed one', async () => {
  assert.notEqual(await urlFor({ stream: true }), await urlFor({ stream: false }));
  const streamed = { ...body, stream: true };
  const key = async (b) => (await buildEdgeCacheKeyRequest('openai_chat', 'Code-Max', b, 'AIR', { host: 'gateway.example.com' })).url;
  assert.notEqual(await key(streamed), await key(body));
  assert.equal(await key({ ...body, stream: false }), await key(body));
});

test('stream_options only matter for a streamed request', async () => {
  const withUsage = { ...body, stream: true, stream_options: { include_usage: true } };
  const without = { ...body, stream: true };
  const key = async (b) => (await buildEdgeCacheKeyRequest('openai_chat', 'Code-Max', b, 'AIR', { host: 'gateway.example.com' })).url;
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

test('temperature zero does not opt in; the explicit header is required', () => {
  assert.equal(edgeCacheEligible('openai_chat', req()), false);
  assert.equal(edgeCacheEligible('openai_chat', req()), false);
  assert.equal(edgeCacheEligible('openai_chat', req()), false);
  assert.equal(edgeCacheEligible('openai_chat', req()), false);
  assert.equal(edgeCacheEligible('openai_chat', req({ 'x-gateway-cache': 'true' })), true);
  assert.equal(edgeCacheEligible('models', req({ 'x-gateway-cache': 'true' })), false);
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
    const entries = new Map();
    const previous = globalThis.caches;
    globalThis.caches = {
      default: {
        put: async (key, value) => {
          const body = new Uint8Array(await value.arrayBuffer());
          const headers = new Headers(value.headers);
          const maxAge = Number(/max-age=(\d+)/i.exec(headers.get('cache-control') || '')?.[1] || 0);
          stored.push({ url: key.url, body, headers });
          entries.set(key.url, {
            response: new Response(body, { status: value.status, headers }),
            expiresAt: Date.now() + maxAge * 1000,
          });
        },
        match: async (key) => {
          const entry = entries.get(key.url);
          if (!entry || Date.now() >= entry.expiresAt) {
            entries.delete(key.url);
            return undefined;
          }
          return entry.response.clone();
        },
      },
    };
    try {
      await run(stored, entries);
    } finally {
      globalThis.caches = previous;
    }
  };
}

function beginStore(response, stream, route = 'openai_chat', options = {}) {
  const pending = [];
  const key = options.keyRequest || new Request(`https://gateway.example.com/__gateway_cache/v3/${route}/abc`);
  storeEdgeCacheResponse({ waitUntil: (p) => pending.push(p) }, key, response, options.ttlSec || 60, stream, route, options.signal);
  return { pending, key };
}

async function store(response, stream, route = 'openai_chat', options = {}) {
  const { pending, key } = beginStore(response, stream, route, options);
  await Promise.all(pending);
  return key;
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const sse = (text) => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });

test('a plain JSON answer is stored with a private-by-default client contract and a bounded edge TTL', withFakeCache(async (stored) => {
  await store(json({ choices: [{ message: { content: 'ok' } }] }), false);
  assert.equal(stored.length, 1);
  assert.match(new TextDecoder().decode(stored[0].body), /"content":"ok"/);
  assert.equal(stored[0].headers.get('cache-control'), 'public, max-age=60');
  assert.equal(stored[0].headers.has('x-gateway-cache-status'), false, 'HIT is added only at lookup time');
}));

test('lookup returns a genuine MISS then HIT with client-private headers', withFakeCache(async (stored) => {
  const request = req({ origin: 'https://client.example' });
  const absent = new Request('https://gateway.example.com/__gateway_cache/v3/openai_chat/absent');
  assert.equal(await matchEdgeCache(absent, request, ENV), null);
  const miss = injectMissHeader(json({ choices: [] }), request, ENV);
  assert.equal(miss.headers.get('x-gateway-cache-status'), 'MISS');
  assert.equal(miss.headers.get('cache-control'), 'private, no-store');

  const key = await store(json({ choices: [{ message: { content: 'cached' } }] }), false);
  const hit = await matchEdgeCache(key, request, ENV);
  assert.ok(hit);
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get('x-gateway-cache-status'), 'HIT');
  assert.equal(hit.headers.get('cache-control'), 'private, no-store');
  assert.match(await hit.text(), /cached/);
  assert.equal(stored.length, 1);
}));

test('stored TTL expires the entry and cache keys retain caller and request-host isolation', withFakeCache(async () => {
  const originalNow = Date.now;
  try {
    Date.now = () => 10_000;
    const env = { ...ENV, AIG_EDGE_CACHE_TTL_SEC: '2' };
    const requestA = req({ authorization: 'Bearer secret-a', 'x-gateway-cache': 'true' });
    const requestB = req({ authorization: 'Bearer secret-b', 'x-gateway-cache': 'true' });
    const planA = await resolveEdgeCachePlan('openai_chat', 'Code-Max', body, requestA, env, 'AIR', false);
    const planB = await resolveEdgeCachePlan('openai_chat', 'Code-Max', body, requestB, env, 'AIR', false);
    assert.ok(planA && planB);
    assert.equal(new URL(planA.keyRequest.url).host, 'gateway.example.com');
    assert.notEqual(planA.keyRequest.url, planB.keyRequest.url);
    await store(json({ choices: [{ message: { content: 'a only' } }] }), false, 'openai_chat', {
      keyRequest: planA.keyRequest,
      ttlSec: planA.ttlSec,
    });
    assert.ok(await matchEdgeCache(planA.keyRequest, requestA, env));
    assert.equal(await matchEdgeCache(planB.keyRequest, requestB, env), null);
    Date.now = () => 12_001;
    assert.equal(await matchEdgeCache(planA.keyRequest, requestA, env), null);
  } finally {
    Date.now = originalNow;
  }
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
  await store(sse('event: message_stop\ndata: {"type":"message_stop"}\n\n'), true, 'anthropic_messages');
  assert.equal(stored.length, 2);
}));

test('incomplete Responses events and byte content after a terminal marker are not replayed', withFakeCache(async (stored) => {
  await store(sse('event: response.incomplete\ndata: {"type":"response.incomplete"}\n\n'), true, 'openai_responses');
  const original = 'event: message_start\ndata: {"message":{"usage":{"input_tokens":1}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  await store(sse(original), true, 'anthropic_messages');
  assert.equal(stored.length, 1);
  assert.equal(new TextDecoder().decode(stored[0].body), original);
}));

test('malformed SSE and data after completion are never cached, while event-like model text is safe', withFakeCache(async (stored) => {
  await store(sse('data: not-json\n\ndata: [DONE]\n\n'), true);
  await store(
    sse('data: {"choices":[{"delta":{"content":"the text says response.incomplete"}}]}\n\ndata: [DONE]\n\n'),
    true,
  );
  await store(sse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\ndata: extra\n\n'), true);
  assert.equal(stored.length, 1);
}));

test('client cancellation aborts cache-fill reads and prevents storage', withFakeCache(async (stored) => {
  const encoder = new TextEncoder();
  const controller = new AbortController();
  let sourceCancelled = 0;
  const response = new Response(
    new ReadableStream({
      start(streamController) {
        streamController.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
      },
      pull() {
        return new Promise(() => {});
      },
      cancel() {
        sourceCancelled++;
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
  const clientResponse = response.clone();
  const { pending } = beginStore(clientResponse, true, 'openai_chat', { signal: controller.signal });
  const clientReader = response.body.getReader();
  await clientReader.read();
  controller.abort();
  await clientReader.cancel();
  await Promise.all(pending);
  assert.equal(sourceCancelled, 1);
  assert.deepEqual(stored, []);
}));

test('an oversized SSE frame is not cached when the bounded safety observer cannot inspect it', withFakeCache(async (stored) => {
  const toolFrame = `data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(70 * 1024), tool_calls: [{ index: 0 }] } }] })}\n\ndata: [DONE]\n\n`;
  await store(sse(toolFrame), true);
  assert.deepEqual(stored, []);
}));

test('responses larger than the per-fill memory cap are cancelled and not cached', withFakeCache(async (stored) => {
  await store(json({ choices: [{ message: { content: 'x'.repeat(300 * 1024) } }] }), false);
  assert.deepEqual(stored, []);
}));
