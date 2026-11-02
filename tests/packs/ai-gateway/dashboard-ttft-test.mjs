// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import { assert, test } from '#kit/harness.mjs';
import { targetPath } from '#kit/target.mjs';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { renderModels } from '#target/src/dashboard/model-status-view.ts';
import { getCachedDashboardStats, usageSection, __resetDashboardCacheForTests } from '#target/src/dashboard/usage-view.ts';
import {
  __resetUsageBufferForTests,
  flushUsageBuffer,
  loadUpstreamModels,
  persistTokenUsage,
  persistUpstreamAttemptUsage,
  queryAllModelsTtftPercentiles,
  queryRecentModelEvidence,
} from '#target/src/observability/token-usage-store.ts';

function database() {
  const db = new DatabaseSync(':memory:');
  const migrationDir = targetPath('migrations');
  for (const name of readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(migrationDir, name), 'utf8'));
  }
  let batches = 0;
  const d1 = {
    prepare(sql) {
      const statement = db.prepare(sql);
      const bound = (args) => ({
        bind: (...values) => bound(values),
        run: async () => ({ success: true, meta: { changes: Number(statement.run(...args).changes) } }),
        all: async () => ({ results: statement.all(...args) }),
        first: async () => statement.get(...args) ?? null,
      });
      return bound([]);
    },
    async batch(statements) {
      batches++;
      db.exec('BEGIN');
      try {
        const out = [];
        for (const statement of statements) out.push(await statement.run());
        db.exec('COMMIT');
        return out;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { db, d1, batches: () => batches };
}

function reset() {
  __resetUsageBufferForTests();
  __resetDashboardCacheForTests();
}

test('the first delivered event is flushed while later events remain buffered', async () => {
  reset();
  const { db, d1, batches } = database();
  const now = Date.now();
  const env = { TOKEN_STATS_DB: d1, AIG_TOKEN_D1_SAMPLE_PCT: '0' };
  await persistTokenUsage(env, { prompt_tokens: 1 }, now, 'Air', 200);
  assert.equal(batches(), 1);
  await persistTokenUsage(env, { prompt_tokens: 1 }, now, 'Air', 200);
  assert.equal(batches(), 1);
  await flushUsageBuffer();
  db.close();
});

test('TTFT and success evidence are persisted and rendered when token detail sampling is disabled', async () => {
  reset();
  const { db, d1 } = database();
  const now = Date.now();
  const env = { TOKEN_STATS_DB: d1, AIG_TOKEN_D1_SAMPLE_PCT: '0' };
  await persistTokenUsage(env, { prompt_tokens: 11, completion_tokens: 4 }, now, ' Code-Max ', 600);
  for (let i = 0; i < 19; i++) await persistTokenUsage(env, null, now, 'code-max', 600);
  await flushUsageBuffer();
  const row = db.prepare('SELECT * FROM token_usage_model_hourly').get();
  assert.equal(row.model, 'code-max');
  assert.equal(row.requests, 20);
  assert.equal(row.usage_reports, 1);
  assert.equal(row.usage_missing, 19);
  assert.equal(row.successful_ttft_count, 20);
  assert.equal(row.ttft_b2, 20);
  assert.equal(row.upstream_attempts, 0);
  assert.equal(row.upstream_total_tokens, 0);
  const global = db.prepare("SELECT * FROM token_usage_totals WHERE scope = 'global'").get();
  assert.equal(global.upstream_attempts, 20);
  assert.equal(global.upstream_total_tokens, 15);
  assert.deepEqual((await loadUpstreamModels(env, 7, now)).rows, []);
  const result = await queryAllModelsTtftPercentiles(env, undefined, now);
  assert.equal(result.available, true);
  assert.deepEqual(result.ttft.get('code-max'), {
    available: true, p50: 1000, p95: 1000, sampleCount: 20, p50Insufficient: false, p95Insufficient: false,
  });
  assert.ok((await queryRecentModelEvidence(env, undefined, now)).has('code-max'));
  const html = renderModels({ models: [{ id: 'Code-Max', status: 'available' }] }, result.ttft).html;
  assert.match(html, /≤1s/);
  assert.match(html, />20<\/div>/);
  const usageHtml = await usageSection(env, now);
  assert.doesNotMatch(usageHtml, /D1 已持久化|统计批次在约|Worker 无法读取账户级/);
  db.close();
});

test('mixed sampling keeps sampled model token totals separate from unsampled success evidence', async () => {
  reset();
  const { db, d1 } = database();
  const now = Date.now();
  const env = { TOKEN_STATS_DB: d1, AIG_TOKEN_D1_SAMPLE_PCT: '50' };
  const original = Math.random;
  try {
    Math.random = () => 0.1;
    await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 2 }, now, 'Air', 200);
    Math.random = () => 0.9;
    await persistTokenUsage(env, { prompt_tokens: 20, completion_tokens: 4 }, now, 'AIR', 1200);
    await flushUsageBuffer();
  } finally {
    Math.random = original;
  }
  const row = db.prepare('SELECT * FROM token_usage_model_hourly').get();
  assert.equal(row.requests, 2);
  assert.equal(row.successful_ttft_count, 2);
  assert.equal(row.total_tokens, 12);
  assert.equal(row.upstream_total_tokens, 12);
  assert.equal(row.upstream_attempts, 1);
  const global = db.prepare("SELECT * FROM token_usage_totals WHERE scope = 'global'").get();
  assert.equal(global.upstream_total_tokens, 36);
  assert.equal(global.upstream_attempts, 2);
  db.close();
});

test('a failed first flush retains TTFT increments and retries after the throttle window', async () => {
  reset();
  const { db, d1 } = database();
  const initialNow = Date.now();
  const env = { TOKEN_STATS_DB: d1, AIG_TOKEN_D1_SAMPLE_PCT: '0' };
  const batch = d1.batch.bind(d1);
  const originalNow = Date.now;
  let attempts = 0;
  d1.batch = async (statements) => {
    attempts++;
    if (attempts === 1) throw new Error('temporary failure');
    return batch(statements);
  };
  try {
    Date.now = () => initialNow;
    await assert.rejects(persistTokenUsage(env, null, initialNow, 'Air', 200), /temporary failure/);
    await persistTokenUsage(env, null, initialNow, 'Air', 200);
    assert.equal(attempts, 1, 'the failed batch is not retried on every request');
    Date.now = () => initialNow + 5 * 60_000;
    await persistTokenUsage(env, null, initialNow, 'Air', 200);
    const result = await queryAllModelsTtftPercentiles(env, undefined, initialNow);
    assert.equal(result.ttft.get('air').sampleCount, 3);
    assert.equal(db.prepare("SELECT requests FROM token_usage_totals WHERE scope = 'global'").get().requests, 3);
    assert.equal(attempts, 2);
  } finally {
    Date.now = originalNow;
    db.close();
  }
});

test('failed upstream attempts never create successful TTFT evidence', async () => {
  reset();
  const { db, d1 } = database();
  const now = Date.now();
  const env = { TOKEN_STATS_DB: d1, AIG_TOKEN_D1_SAMPLE_PCT: '100' };
  await persistUpstreamAttemptUsage(env, { prompt_tokens: 8 }, now, 'Pro');
  await flushUsageBuffer();
  assert.equal((await queryRecentModelEvidence(env, undefined, now)).size, 0);
  assert.equal((await queryAllModelsTtftPercentiles(env, undefined, now)).ttft.get('pro').sampleCount, 0);
  db.close();
});

test('a TTFT query failure is distinguished from an empty result', async () => {
  reset();
  const env = { TOKEN_STATS_DB: { prepare() { throw new Error('read failed'); } }, AIG_LOG_LEVEL: 'none' };
  const stats = await getCachedDashboardStats(env, Date.now());
  assert.equal(stats.ttft, null);
  const html = renderModels({ models: [{ id: 'Air', status: 'no_record' }] }, stats.ttft).html;
  assert.match(html, /TTFT 统计暂不可用/);
  assert.doesNotMatch(html, /暂无 TTFT 样本/);
});
