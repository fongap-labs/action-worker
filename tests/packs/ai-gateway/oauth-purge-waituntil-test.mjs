// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// AIG-007 replacement: a retired member OAuth request must neither schedule
// background work nor touch legacy D1 flow-state tables.

import { assert, beforeEach, test } from '#kit/harness.mjs';
import worker from '#target/src/index.ts';
import { AIR_KEY, makeEnv, RecordingD1, resetCaches } from './hardening-fixtures.mjs';

beforeEach(resetCaches);

test('retired onboarding route never registers waitUntil or D1 cleanup', async () => {
  const db = new RecordingD1();
  const pending = [];
  const response = await worker.fetch(
    new Request('https://gateway.example.com/oauth/start?provider=mock&node=sub1', {
      headers: { authorization: 'Bearer ' + AIR_KEY },
    }),
    makeEnv({ TOKEN_STATS_DB: db }),
    { waitUntil: (promise) => pending.push(promise) },
  );
  assert.equal(response.status, 404);
  assert.equal(pending.length, 0);
  assert.deepEqual(db.statements, []);
});

test('retired callback cannot access D1 or schedule a token refresh', async () => {
  const db = new RecordingD1();
  const pending = [];
  const response = await worker.fetch(
    new Request('https://gateway.example.com/oauth/callback/mock?code=c&state=s'),
    makeEnv({ TOKEN_STATS_DB: db }),
    { waitUntil: (promise) => pending.push(promise) },
  );
  assert.equal(response.status, 404);
  assert.equal(pending.length, 0);
  assert.deepEqual(db.statements, []);
});

test('without an execution context the retired route is still safe', async () => {
  const db = new RecordingD1();
  const response = await worker.fetch(
    new Request('https://gateway.example.com/oauth/start?provider=mock&node=sub1'),
    makeEnv({ TOKEN_STATS_DB: db }),
    {},
  );
  assert.equal(response.status, 404);
  assert.deepEqual(db.statements, []);
});
