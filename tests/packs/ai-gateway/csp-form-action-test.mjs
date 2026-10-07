// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// AIG-001: the OAuth pages must be able to submit their forms, every other HTML page must not, and a
// form submit must not answer with a redirect (the browser applies form-action to it).

import { assert, beforeEach, test } from '#kit/harness.mjs';
import worker from '#target/src/index.ts';
import { htmlResponse } from '#target/src/protocol/http.ts';
import { AIR_KEY, makeEnv, RecordingD1, resetCaches } from './hardening-fixtures.mjs';

beforeEach(resetCaches);

const csp = (response) => response.headers.get('content-security-policy') ?? '';

test('the gateway key page allows form-action self', async () => {
  const res = await worker.fetch(new Request('https://gateway.example.com/oauth/start?provider=mock&node=sub1'), makeEnv(), {});
  assert.equal(res.status, 401);
  assert.match(csp(res), /form-action 'self'/);
  assert.doesNotMatch(csp(res), /form-action 'none'/);
});

test('the code paste page allows form-action self', async () => {
  const db = new RecordingD1();
  db.prepare = () => ({
    bind: () => ({
      first: async () => ({ state: 's', provider: 'mock', node_id: 'sub1', code_verifier: 'v', created_at: Date.now() }),
      run: async () => ({}),
    }),
  });
  const res = await worker.fetch(new Request('https://gateway.example.com/oauth/paste?state=s'), makeEnv({ TOKEN_STATS_DB: db }), {});
  assert.equal(res.status, 200);
  assert.match(csp(res), /form-action 'self'/);
});

test('the dashboard and other HTML pages keep form-action none', async () => {
  const res = await worker.fetch(new Request('https://gateway.example.com/', { headers: { accept: 'text/html' } }), makeEnv(), {});
  assert.equal(res.status, 200);
  assert.match(csp(res), /form-action 'none'/);
  assert.match(csp(htmlResponse('x')), /form-action 'none'/);
  assert.match(csp(htmlResponse('x', { allowSelfForm: true })), /form-action 'self'/);
});

test('caller headers never replace the security headers of an HTML response', () => {
  const res = htmlResponse('x', {
    headers: { 'content-security-policy': 'default-src *', 'x-extra': '1', 'x-frame-options': 'ALLOWALL' },
  });
  assert.equal(res.headers.get('x-extra'), '1');
  assert.doesNotMatch(csp(res), /default-src \*/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('a form start answers with a refresh page, not a redirect', async () => {
  const env = makeEnv({ TOKEN_STATS_DB: new RecordingD1() });
  const res = await worker.fetch(
    new Request('https://gateway.example.com/oauth/start', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ provider: 'mock', node: 'sub1', key: AIR_KEY }).toString(),
    }),
    env,
    {},
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('location'), null);
  assert.match(await res.text(), /http-equiv="refresh" content="0; url=https:\/\/auth\.mock\.example\.com\/authorize\?/);
});

test('a header-authenticated start still redirects', async () => {
  const env = makeEnv({ TOKEN_STATS_DB: new RecordingD1() });
  const res = await worker.fetch(
    new Request('https://gateway.example.com/oauth/start?provider=mock&node=sub1', { headers: { authorization: `Bearer ${AIR_KEY}` } }),
    env,
    {},
  );
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^https:\/\/auth\.mock\.example\.com\/authorize\?/);
});
