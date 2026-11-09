// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// AIG-008 replacement: no reversible membership OAuth token store may remain;
// the public Gateway has metadata only, and private centers exclusively own
// static Token credentials.

import { assert, beforeEach, test } from '#kit/harness.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { targetRoot } from '#kit/target.mjs';
import { loadExecutionConfig, loadGatewayConfig } from '#target/src/config/nodes.ts';
import { makeEnv, resetCaches } from './hardening-fixtures.mjs';

beforeEach(resetCaches);

test('retired subscription encryption and token-storage modules cannot return', () => {
  for (const path of [
    'src/oauth/crypto.ts',
    'src/oauth/token-store.ts',
    'packages/oauth/crypto.ts',
    'packages/oauth/token-store.ts',
  ]) {
    assert.equal(existsSync(join(targetRoot, path)), false, 'retired reversible subscriber token store: ' + path);
  }
});

test('Gateway cannot read or report private static Provider Token values', () => {
  const cfg = loadGatewayConfig(makeEnv());
  assert.equal(cfg.status, 'ready');
  for (const tier of [1, 2]) {
    for (const node of cfg.tiers[tier]) assert.equal(node.credential, '');
  }
  assert.doesNotMatch(JSON.stringify(cfg), /paid-fixture-key|upstream-key/);
});

test('private Inference Center retains distinct Tier 1 and Tier 2 credential ownership', () => {
  const cfg = loadExecutionConfig(makeEnv());
  assert.equal(cfg.status, 'ready');
  assert.equal(cfg.tiers[1][0]?.credential, 'upstream-key');
  assert.equal(cfg.tiers[2][0]?.credential, 'paid-fixture-key');
});

test('old membership key and OAuth config are rejected, never decrypted or proxied', () => {
  for (const name of ['AIG_TOKEN_ENCRYPTION_KEY', 'AIG_OAUTH_PROVIDERS', 'AIG_IS_SUBSCRIPTION_ENABLED']) {
    const cfg = loadGatewayConfig(makeEnv({ [name]: 'old-secret-value' }));
    assert.equal(cfg.status, 'invalid', name);
    assert.equal(cfg.nodesUsable, 0);
    assert.doesNotMatch(JSON.stringify(cfg), /old-secret-value/, 'legacy secret value must not leak in diagnostics');
  }
});
