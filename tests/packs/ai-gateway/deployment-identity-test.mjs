// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
import assert from 'node:assert/strict';
import { targetPath } from '#kit/target.mjs';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { verifyRemote } from '#target/scripts/github-deployment-config.mjs';
import { resolveBuildSha } from '#target/src/observability/diagnostic-endpoints.ts';

const assertPublicReadinessRequests = (requests) => {
  assert.ok(requests.length > 0);
  assert.ok(
    requests.every(
      ({ url, hasAuthorization }) => url.endsWith('/health/ready') && !hasAuthorization,
    ),
  );
};

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
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({
      url: String(url),
      hasAuthorization: new Headers(init?.headers).has('authorization'),
    });
    if (url.endsWith('/health/ready')) return Response.json({ ready: true, build: 'b'.repeat(40), degraded: false });
    return Response.json({});
  };
  try {
    await assert.rejects(verifyRemote('https://gateway.example', expected, shortGrace), /does not match/);
    assertPublicReadinessRequests(requests);
  } finally {
    globalThis.fetch = original;
  }
});

test('online verification polls public readiness until the new build is ready', async () => {
  const original = globalThis.fetch;
  const expected = 'a'.repeat(40);
  const propagation = { graceMs: 60_000, intervalMs: 1 };
  let readinessCalls = 0;
  let requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({
      url: String(url),
      hasAuthorization: new Headers(init?.headers).has('authorization'),
    });
    if (url.endsWith('/health/ready')) {
      readinessCalls += 1;
      return Response.json({
        ready: true,
        build: readinessCalls <= 2 ? 'b'.repeat(40) : expected,
        degraded: false,
      });
    }
    return Response.json({});
  };
  try {
    await verifyRemote('https://gateway.example', expected, propagation);
    assert.equal(readinessCalls, 3, 'two stale readiness responses are retried before accepting the new build');
    assertPublicReadinessRequests(requests);

    requests = [];
    readinessCalls = 0;
    globalThis.fetch = async (url, init) => {
      requests.push({
        url: String(url),
        hasAuthorization: new Headers(init?.headers).has('authorization'),
      });
      if (url.endsWith('/health/ready')) {
        readinessCalls += 1;
        return Response.json({ ready: true, build: expected, degraded: false });
      }
      return Response.json({});
    };
    await verifyRemote('https://gateway.example', expected, propagation);
    assert.equal(readinessCalls, 1, 'build verification uses one public readiness probe');
    assertPublicReadinessRequests(requests);

    requests = [];
    await verifyRemote('https://gateway.example');
    assert.equal(requests.length, 1, 'rollback probes public readiness without asserting a target SHA');
    assertPublicReadinessRequests(requests);
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
