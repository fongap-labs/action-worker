// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
import assert from 'node:assert/strict';
import { targetPath } from '#kit/target.mjs';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { verifyRemote } from '#target/scripts/github-deployment-config.mjs';
import { resolveBuildSha } from '#target/src/observability/diagnostic-endpoints.ts';

test('runtime build identity uses the gateway-scoped source SHA only', () => {
  const sourceSha = 'a'.repeat(40);
  const controlSha = 'b'.repeat(40);
  assert.equal(resolveBuildSha({ AIG_BUILD_SHA: sourceSha, GITHUB_SHA: controlSha }), sourceSha);
  assert.equal(resolveBuildSha({ GITHUB_SHA: controlSha }), 'unknown');
});

test('online verification rejects a Worker build that never matches', async () => {
  const original = globalThis.fetch;
  const expected = 'a'.repeat(40);
  const shortGrace = { graceMs: 100, intervalMs: 10 };
  globalThis.fetch = async (url) => {
    if (url.endsWith('/health')) return Response.json({ ready: true, build: 'b'.repeat(40) });
    return Response.json({});
  };
  try {
    await assert.rejects(verifyRemote('https://gateway.example', 'test-placeholder', expected, shortGrace), /does not match/);
  } finally {
    globalThis.fetch = original;
  }
});

test('online verification keeps polling until the new build reports health', async () => {
  const original = globalThis.fetch;
  const expected = 'a'.repeat(40);
  // A count, not a wall-clock window, decides when the new build appears, so the test does not depend on machine load.
  const propagation = { graceMs: 60_000, intervalMs: 1 };
  let healthCalls = 0;
  let calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (url.endsWith('/health')) {
      healthCalls += 1;
      return Response.json({ ready: true, build: healthCalls <= 2 ? 'b'.repeat(40) : expected });
    }
    return Response.json({});
  };
  try {
    await verifyRemote('https://gateway.example', 'test-placeholder', expected, propagation);
    assert.equal(healthCalls, 3, 'two stale health responses are retried before the new build is accepted');

    calls = [];
    healthCalls = 0;
    globalThis.fetch = async (url) => {
      calls.push(url);
      if (url.endsWith('/health')) return Response.json({ ready: true, build: expected });
      return Response.json({});
    };
    await verifyRemote('https://gateway.example', 'test-placeholder', expected, propagation);
    assert.equal(calls.length, 3, 'build verification reuses the health probe');

    calls = [];
    await verifyRemote('https://gateway.example', 'test-placeholder');
    assert.equal(calls.length, 3, 'rollback probes health without asserting a target SHA');
  } finally {
    globalThis.fetch = original;
  }
});

test('deployment validation remains project-owned while orchestration is central', () => {
  const pkg = JSON.parse(readFileSync(targetPath('package.json')));
  assert.match(pkg.scripts['validate:deploy'], /npm run typecheck/);
  assert.match(pkg.scripts['validate:deploy'], /npm run check:links/);
  assert.match(pkg.scripts['check:deploy'], /cloudflare-wrangler\.mjs deploy --dry-run/);
});
