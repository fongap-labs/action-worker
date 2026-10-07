// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// AIG-008: stored subscription tokens are bound to their node, provider and column, and rows written
// before the binding existed still open.

import { assert, beforeEach, test } from '#kit/harness.mjs';
import { decryptSecret, encryptSecret } from '#target/src/oauth/crypto.ts';
import { makeEnv, resetCaches } from './hardening-fixtures.mjs';

beforeEach(resetCaches);

const env = makeEnv();
const ctx = { nodeId: 'sub1', provider: 'mock', field: 'access' };

test('a bound ciphertext opens only for its own node, provider and column', async () => {
  const sealed = await encryptSecret(env, 'access-token', ctx);
  assert.ok(sealed.ciphertextB64.startsWith('v2.'));
  assert.equal(await decryptSecret(env, sealed, ctx), 'access-token');
  assert.equal(await decryptSecret(env, sealed, { ...ctx, nodeId: 'sub2' }), null);
  assert.equal(await decryptSecret(env, sealed, { ...ctx, provider: 'other' }), null);
  assert.equal(await decryptSecret(env, sealed, { ...ctx, field: 'refresh' }), null);
  assert.equal(await decryptSecret(env, sealed), null, 'a bound ciphertext cannot be opened without a context');
});

test('moving a row onto another node fails authentication', async () => {
  const sealed = await encryptSecret(env, 'node-one-token', { ...ctx, nodeId: 'node-one' });
  assert.equal(await decryptSecret(env, sealed, { ...ctx, nodeId: 'node-two' }), null);
});

test('rows written before the binding existed still decrypt', async () => {
  const legacy = await encryptSecret(env, 'old-token');
  assert.ok(!legacy.ciphertextB64.startsWith('v2.'));
  assert.equal(await decryptSecret(env, legacy), 'old-token');
  assert.equal(await decryptSecret(env, legacy, ctx), 'old-token');
});

test('tampering with a bound ciphertext is detected', async () => {
  const sealed = await encryptSecret(env, 'access-token', ctx);
  const body = sealed.ciphertextB64.slice(3);
  const flipped = `v2.${body.slice(0, 4)}${body[4] === 'A' ? 'B' : 'A'}${body.slice(5)}`;
  assert.equal(await decryptSecret(env, { ...sealed, ciphertextB64: flipped }, ctx), null);
});
