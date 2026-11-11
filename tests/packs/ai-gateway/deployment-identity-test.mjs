// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
import assert from 'node:assert/strict';
import { targetPath } from '#kit/target.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifyRemote } from '#target/scripts/github-deployment-config.mjs';
import {
  confirmRestoredIdentity,
  guardedRollbackTarget,
  parseActiveDeployment,
  recordPublishedDeployment,
} from '#target/scripts/deployment-recovery.mjs';
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

test('recovery records an untagged Gateway via Cloudflare when the public route would return 401', () => {
  const accountId = 'a'.repeat(32);
  const previous = {
    deployment_id: '11111111-1111-4111-8111-111111111111',
    version_id: '22222222-2222-4222-8222-222222222222',
  };
  const inventory = {
    success: true,
    result: {
      deployments: [{
        id: previous.deployment_id,
        versions: [{ version_id: previous.version_id, percentage: 100 }],
      }],
    },
  };
  const mockFetch = `
    globalThis.fetch = async (url, options) => {
      const host = new URL(url).hostname;
      console.log('Requested ' + host);
      if (host !== 'api.cloudflare.com') return new Response(null, { status: 401 });
      const expected = 'https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/ai-gateway/deployments?per_page=1&page=1';
      if (url !== expected || options.method !== 'GET') throw new Error('Unexpected Cloudflare request');
      return Response.json(${JSON.stringify(inventory)});
    };
  `;
  const directory = mkdtempSync(join(tmpdir(), 'gateway-recovery-'));
  const ledger = join(directory, 'ledger.json');
  try {
    const result = spawnSync(process.execPath, [
      '--import',
      `data:text/javascript,${encodeURIComponent(mockFetch)}`,
      targetPath('scripts/deployment-recovery.mjs'),
      'snapshot',
      ledger,
    ], {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_API_TOKEN: 'test-token',
        AIG_PUBLIC_URL: 'https://gateway.example',
      },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.match(/^Requested .+$/gm), ['Requested api.cloudflare.com']);

    const baseline = JSON.parse(readFileSync(ledger, 'utf8'));
    assert.deepEqual(baseline.previous, previous);
    const build = 'b'.repeat(40);
    const deployed = {
      deployment_id: '33333333-3333-4333-8333-333333333333',
      version_id: '44444444-4444-4444-8444-444444444444',
      message: `action-worker:deploy:${build}`,
    };
    assert.throws(() => recordPublishedDeployment(baseline, { ...deployed, message: null }, build), /not verified/);
    const published = recordPublishedDeployment(baseline, deployed, build);
    assert.equal(guardedRollbackTarget(published, deployed), previous.version_id);
    const drifted = { ...deployed, deployment_id: '55555555-5555-4555-8555-555555555555' };
    assert.throws(() => guardedRollbackTarget(published, drifted), /drifted/);
    assert.throws(() => confirmRestoredIdentity(published, drifted), /has not restored/);
    assert.doesNotThrow(() => confirmRestoredIdentity(published, { ...drifted, version_id: previous.version_id }));

    inventory.result.deployments[0].versions[0].percentage = 50;
    assert.throws(() => parseActiveDeployment(inventory), /exactly one verified 100% Worker version/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('public readiness still rejects a 401 after publishing', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 401 });
  try {
    await assert.rejects(
      verifyRemote('https://gateway.example', 'a'.repeat(40), { graceMs: 1, intervalMs: 1 }),
      /HTTP 401/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
