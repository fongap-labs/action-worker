// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Edge cache key: canonical, type-preserving, and scoped to the caller's key group.

import { assert, test } from '#kit/harness.mjs';
import { buildEdgeCacheKeyRequest } from '#target/src/request/edge-cache.ts';

async function key(body, group = 'AIR', route = 'openai_chat', model = 'Code-Max') {
  return (await buildEdgeCacheKeyRequest(route, model, body, group)).url;
}

test('object key order and wire-format fields do not change the key', async () => {
  const a = await key({ temperature: 0, messages: [{ role: 'user', content: 'hi' }] });
  const b = await key({ messages: [{ content: 'hi', role: 'user' }], temperature: 0, stream: true, stream_options: {} });
  assert.equal(a, b);
});

test('separators inside a string cannot forge a different request', async () => {
  assert.notEqual(await key({ a: '1,b:2' }), await key({ a: '1', b: '2' }));
  assert.notEqual(await key({ a: 'x}' }), await key({ a: 'x', '}': '' }));
});

test('value types stay distinct', async () => {
  assert.notEqual(await key({ x: 1 }), await key({ x: '1' }));
  assert.notEqual(await key({ x: null }), await key({ x: '' }));
  assert.notEqual(await key({ x: true }), await key({ x: 'true' }));
  assert.notEqual(await key({ x: [] }), await key({ x: '' }));
});

test('array order still matters', async () => {
  assert.notEqual(await key({ messages: ['a', 'b'] }), await key({ messages: ['b', 'a'] }));
});

test('entries are never shared between key groups, routes, or models', async () => {
  const body = { temperature: 0, messages: [{ role: 'user', content: 'hi' }] };
  assert.notEqual(await key(body, 'AIR'), await key(body, 'PRO'));
  assert.notEqual(await key(body, 'AIR', 'openai_chat'), await key(body, 'AIR', 'openai_responses'));
  assert.notEqual(await key(body, 'AIR', 'openai_chat', 'Code-Max'), await key(body, 'AIR', 'openai_chat', 'Code-Pro'));
});
