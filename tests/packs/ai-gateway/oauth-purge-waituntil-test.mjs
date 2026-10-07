// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// AIG-007: expired OAuth flow states are purged under waitUntil, so the runtime cannot cancel the
// cleanup when the response is sent.

import { assert, beforeEach, test } from '#kit/harness.mjs';
import worker from '#target/src/index.ts';
import { AIR_KEY, makeEnv, RecordingD1, resetCaches } from './hardening-fixtures.mjs';

beforeEach(resetCaches);

const purges = (db) => db.statements.filter((s) => /DELETE FROM oauth_flow_states WHERE created_at/.test(s.query));
const start = (db, ctx) =>
  worker.fetch(
    new Request('https://gateway.example.com/oauth/start?provider=mock&node=sub1', { headers: { authorization: `Bearer ${AIR_KEY}` } }),
    makeEnv({ TOKEN_STATS_DB: db }),
    ctx,
  );

test('an onboarding start hands the purge to waitUntil', async () => {
  const db = new RecordingD1();
  const pending = [];
  const res = await start(db, { waitUntil: (promise) => pending.push(promise) });
  assert.equal(res.status, 302);
  assert.equal(pending.length, 1, 'exactly one background task was registered');
  await Promise.all(pending);
  assert.equal(purges(db).length, 1);
});

test('a callback hands the purge to waitUntil too', async () => {
  const db = new RecordingD1();
  const pending = [];
  await worker.fetch(new Request('https://gateway.example.com/oauth/callback/mock?code=c&state=s'), makeEnv({ TOKEN_STATS_DB: db }), {
    waitUntil: (promise) => pending.push(promise),
  });
  assert.equal(pending.length, 1);
  await Promise.all(pending);
  assert.equal(purges(db).length, 1);
});

test('without an execution context the purge still runs before the response', async () => {
  const db = new RecordingD1();
  await start(db, {});
  assert.equal(purges(db).length, 1);
});
