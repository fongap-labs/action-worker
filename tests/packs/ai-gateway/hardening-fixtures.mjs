// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Shared fixtures for the gateway hardening suites (not itself a test: no -test.mjs suffix).

import { __resetAccessKeysCacheForTests } from '#target/src/config/access-keys.ts';
import { __resetTokenKeyCacheForTests } from '#target/src/oauth/crypto.ts';
import { __resetOAuthProvidersCacheForTests } from '#target/src/oauth/provider-configs.ts';

export const AIR_KEY = 'air-test-key';
export const AGENT_KEY = 'agent-test-key';

let keyB64 = '';
for (const byte of new Uint8Array(32).fill(9)) keyB64 += String.fromCharCode(byte);
export const TOKEN_KEY_B64 = btoa(keyB64);

export function resetCaches() {
  __resetAccessKeysCacheForTests();
  __resetTokenKeyCacheForTests();
  __resetOAuthProvidersCacheForTests();
}

export const oauthNode = (id, provider = 'mock') => ({
  id,
  provider,
  auth: 'oauth',
  base_url: `https://${id}.example.com/v1`,
  models: { 'Code-Max': 'up-model' },
});

export const staticNode = (id) => ({
  id,
  provider: 'openai',
  base_url: `https://${id}.example.com/v1`,
  models: { 'Code-Max': 'up-model' },
});

// A D1 stand-in that records every statement and answers writes with an empty result.
export class RecordingD1 {
  constructor() {
    this.statements = [];
  }
  prepare(query) {
    const record = (values) => this.statements.push({ query, values });
    return {
      bind: (...values) => ({
        first: async () => {
          record(values);
          return null;
        },
        run: async () => {
          record(values);
          return {};
        },
      }),
    };
  }
}

export function makeEnv(extra = {}) {
  return {
    AIG_ACCESS_KEY_AIR: AIR_KEY,
    AIG_ACCESS_MODELS_AIR: '*',
    AIG_ACCESS_KEY_AGENT: AGENT_KEY,
    AIG_ACCESS_MODELS_AGENT: '*',
    AIG_OAUTH_ADMIN_GROUPS: 'AIR',
    AIG_OAUTH_PROVIDERS: JSON.stringify({
      mock: {
        authorize_url: 'https://auth.mock.example.com/authorize',
        token_url: 'https://auth.mock.example.com/token',
        client_id: 'mock-client',
        scope: 'openid',
      },
    }),
    AIG_TOKEN_ENCRYPTION_KEY: TOKEN_KEY_B64,
    AIG_PUBLIC_URL: 'https://gateway.example.com',
    AIG_TIER1_NODES_01: JSON.stringify([staticNode('static1')]),
    AIG_TIER1_CREDENTIALS_01: JSON.stringify({ static1: 'upstream-key' }),
    AIG_TIER2_NODES_01: JSON.stringify([oauthNode('sub1')]),
    ...extra,
  };
}
