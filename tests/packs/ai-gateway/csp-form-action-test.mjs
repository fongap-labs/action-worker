// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// AIG-001 replacement: no retired OAuth HTML form may be served.
// Dashboard and ordinary HTML keep strict CSP and header precedence.

import { assert, beforeEach, test } from '#kit/harness.mjs';
import worker from '#target/src/index.ts';
import { htmlResponse } from '#target/src/protocol/http.ts';
import { makeEnv, resetCaches } from './hardening-fixtures.mjs';

beforeEach(resetCaches);
const csp = (response) => response.headers.get('content-security-policy') ?? '';

test('retired OAuth onboarding and paste forms cannot render or redirect', async () => {
  for (const [method, uri] of [
    ['GET', '/oauth/start?provider=mock&node=sub1'],
    ['POST', '/oauth/start'],
    ['GET', '/oauth/paste?state=s'],
    ['GET', '/oauth/callback/mock?state=s&code=x'],
  ]) {
    const res = await worker.fetch(new Request('https://gateway.example.com' + uri, { method }), makeEnv(), {});
    assert.equal(res.status, 404, method + ' ' + uri);
    assert.equal(res.headers.get('location'), null, 'retired membership routes must not redirect');
    assert.equal(res.headers.get('set-cookie'), null, 'retired membership routes must not create sessions');
    const body = await res.text();
    assert.doesNotMatch(body, /<form|http-equiv=["']refresh/i);
  }
});

test('dashboard and generic HTML responses retain form-action none', async () => {
  const res = await worker.fetch(new Request('https://gateway.example.com/', { headers: { accept: 'text/html' } }), makeEnv(), {});
  assert.equal(res.status, 200);
  assert.match(csp(res), /form-action 'none'/);
  assert.match(csp(htmlResponse('x')), /form-action 'none'/);
});

test('caller headers cannot replace gateway security headers', () => {
  const res = htmlResponse('x', {
    headers: { 'content-security-policy': 'default-src *', 'x-extra': '1', 'x-frame-options': 'ALLOWALL' },
  });
  assert.equal(res.headers.get('x-extra'), '1');
  assert.doesNotMatch(csp(res), /default-src \*/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});
