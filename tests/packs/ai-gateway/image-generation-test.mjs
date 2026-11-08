// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Central image-generation contract for ai-gateway. No real credentials,
// network access, or paid image dispatches. This suite exercises the target
// Worker through the same request boundary as the existing API suites.

import assert from 'node:assert/strict';
import worker from '#target/src/index.ts';
import { handleGenerationCenterRequest } from '#target/src/generation/generation-center-entry.ts';
import { __resetAllStateForTests } from '#target/src/reliability/node-state.ts';
import { __resetTier1StateForTests } from '#target/src/reliability/tier1-state.ts';
import { getProviderAdapter, providerWire } from '#target/src/providers/registry.ts';
import { validateImageGenerationRequest } from '#target/src/protocol/image.ts';

const IMAGE = Buffer.from('mock-image-binary-content').toString('base64');
const HIDDEN_IMAGE = {
  policy: 'default',
  visibility: 'internal',
  ui_visible: false,
  group: 'image',
  modalities: { input: ['text'], output: ['image'] },
};
const gatewayUrl = 'https://gateway.example';
const ctx = { waitUntil(promise) { Promise.resolve(promise).catch(() => {}); } };

function envFor(provider = 'openai-image', upstreamModel = 'gpt-image-1', extra = {}) {
  const node = { id: 'image-1', provider, base_url: provider === 'google-image' ? 'https://generativelanguage.googleapis.com'
    : provider === 'cloudflare-image' ? 'https://api.cloudflare.com/client/v4/accounts/example/ai/run'
    : 'https://api.openai.com', models: { 'Image-Creator': upstreamModel } };
  const env = {
    AIG_GENERATION_AUTH_KEY: 'ai-gateway-central-generation-test-auth-32chars',
    AIG_ACCESS_KEY_AGENT: 'backend-agent-test-key',
    AIG_ACCESS_MODELS_AGENT: 'Image-Creator',
    AIG_ACCESS_KEY_AIR: 'frontend-air-test-key',
    AIG_ACCESS_MODELS_AIR: '*',
    AIG_TIER1_NODES_01: JSON.stringify([node]),
    AIG_TIER1_CREDENTIALS_01: JSON.stringify({ 'image-1': 'upstream-mock-secret' }),
    AIG_MODELS_CONFIG: JSON.stringify({ 'Image-Creator': HIDDEN_IMAGE }),
    AIG_REQUEST_ADMISSION: 'false',
    ...extra,
  };
  // Exercise the real versioned, private Generation Center execution contract.
  // Only the center can reach the mocked physical Provider; tests do not rely
  // on Gateway's legacy direct-provider path.
  // The Gateway owns client access policy; the Generation Center receives
  // only its own node/credential shards and private authentication contract.
  // In particular, hidden UI model declarations are not needed for physical
  // image execution because each center invocation validates a node mapping.
  const centerEnv = {
    AIG_GENERATION_AUTH_KEY: env.AIG_GENERATION_AUTH_KEY,
    AIG_TIER1_NODES_01: env.AIG_TIER1_NODES_01,
    AIG_TIER1_CREDENTIALS_01: env.AIG_TIER1_CREDENTIALS_01,
  };
  env.AIG_GENERATION_SERVICE = {
    fetch: async (request) => {
      const result = await handleGenerationCenterRequest(request, centerEnv);
      if (result.headers.get('x-aig-result') !== 'dispatched') {
        // Only a fixed, public center error code; never print credentials,
        // provider response bodies or the private execution request.
        const error = await result.clone().json().catch(() => null);
        console.error('generation fixture center rejection', result.status, error?.error?.code ?? 'unknown');
      }
      return result;
    },
  };
  return env;
}

function request(path, body, key = 'backend-agent-test-key') {
  return new Request(gatewayUrl + path, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function imageRequest(overrides = {}) {
  return { model: 'Image-Creator', prompt: 'test image generation', size: '1024x1024', n: 1, ...overrides };
}

let passed = 0;
async function test(name, fn) {
  __resetAllStateForTests();
  __resetTier1StateForTests();
  try {
    await fn();
    passed += 1;
    console.log('ok - ' + name);
  } catch (error) {
    process.exitCode = 1;
    console.error('FAIL - ' + name);
    console.error(error?.stack || error);
  }
}

async function withMockFetch(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (target, init) => {
    calls.push({ url: String(target), init });
    return handler(target, init, calls.length);
  };
  try { return await fn(calls); }
  finally { globalThis.fetch = original; }
}

const openaiResult = () => new Response(JSON.stringify({ created: 1700000000, data: [{ b64_json: IMAGE }] }), {
  status: 200, headers: { 'content-type': 'application/json' },
});

await test('image-generation provider surface is separate from existing OpenAI chat wire', () => {
  assert.deepEqual(providerWire('openai').surfaces, ['chat_completions', 'responses']);
  for (const name of ['openai-image', 'google-image', 'cloudflare-image']) {
    assert.deepEqual(providerWire(name).surfaces, ['images_generations']);
    assert.equal(typeof getProviderAdapter(name).image?.prepare, 'function');
  }
  assert.equal(getProviderAdapter('google').image, undefined);
});

await test('image request schema rejects unsupported fields, sizes and multi-image requests', () => {
  assert.equal(validateImageGenerationRequest(imageRequest()), null);
  for (const body of [imageRequest({ n: 2 }), imageRequest({ stream: true }), imageRequest({ size: '5000x5000' }),
    imageRequest({ response_format: 'url' }), imageRequest({ prompt: '' })]) {
    assert.equal(typeof validateImageGenerationRequest(body), 'string');
  }
});

await test('image-only model is absent from public model list even for AGENT group', async () => {
  await withMockFetch(() => { throw new Error('no upstream expected'); }, async (calls) => {
    const res = await worker.fetch(new Request(gatewayUrl + '/v1/models', {
      headers: { authorization: 'Bearer backend-agent-test-key' },
    }), envFor(), ctx);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.some((model) => model.id === 'Image-Creator'), false);
    assert.equal(calls.length, 0);
  });
});

await test('frontend AIR access key cannot invoke the backend image tool', async () => {
  await withMockFetch(() => { throw new Error('no upstream expected'); }, async (calls) => {
    const res = await worker.fetch(request('/v1/images/generations', imageRequest(), 'frontend-air-test-key'), envFor(), ctx);
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
  });
});

await test('image-only model cannot be called through chat completions', async () => {
  await withMockFetch(() => { throw new Error('no upstream expected'); }, async (calls) => {
    const res = await worker.fetch(request('/v1/chat/completions', {
      model: 'Image-Creator', messages: [{ role: 'user', content: 'draw a cat' }],
    }), envFor(), ctx);
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });
});

await test('OpenAI Images receives correct model, prompt and single-image request', async () => {
  await withMockFetch((_url, _init) => openaiResult(), async (calls) => {
    const res = await worker.fetch(request('/v1/images/generations', imageRequest()), envFor(), ctx);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/v1/images/generations'));
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, 'gpt-image-1');
    assert.equal(body.prompt, 'test image generation');
    assert.equal(body.n, 1);
    assert.equal(JSON.parse(await res.text()).data[0].b64_json, IMAGE);
  });
});

await test('Gemini image provider uses x-goog-api-key and translates IMAGE response', async () => {
  await withMockFetch(() => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: IMAGE } }] } }],
  }), { headers: { 'content-type': 'application/json' } }), async (calls) => {
    const res = await worker.fetch(request('/v1/images/generations', imageRequest()), envFor('google-image', 'gemini-2.5-flash-image'), ctx);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('/v1beta/models/gemini-2.5-flash-image:generateContent'));
    assert.equal(new Headers(calls[0].init.headers).get('x-goog-api-key'), 'upstream-mock-secret');
    assert.equal(new Headers(calls[0].init.headers).get('authorization'), null);
    assert.deepEqual(JSON.parse(calls[0].init.body).generationConfig.responseModalities, ['IMAGE']);
    assert.equal((await res.json()).data[0].b64_json, IMAGE);
  });
});

await test('Cloudflare image provider maps native result.image to standard b64_json', async () => {
  await withMockFetch(() => new Response(JSON.stringify({ result: { image: IMAGE } }), {
    headers: { 'content-type': 'application/json' },
  }), async (calls) => {
    const res = await worker.fetch(request('/v1/images/generations', imageRequest()),
      envFor('cloudflare-image', '@cf/black-forest-labs/flux-1-schnell'), ctx);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('/ai/run/@cf/black-forest-labs/flux-1-schnell'));
    assert.equal((await res.json()).data[0].b64_json, IMAGE);
  });
});

await test('a successful but invalid image reply stops instead of regenerating', async () => {
  await withMockFetch(() => new Response(JSON.stringify({ data: [] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }), async (calls) => {
    const res = await worker.fetch(request('/v1/images/generations', imageRequest()),
      envFor('google-image', 'gemini-2.5-flash-image'), ctx);
    assert.equal(res.status, 502);
    assert.equal(calls.length, 1);
    assert.equal(res.headers.get('x-should-retry'), 'false');
  });
});

if (process.exitCode) throw new Error('image-generation contract suite failed');
console.log('image-generation contracts passed (' + passed + ').');
