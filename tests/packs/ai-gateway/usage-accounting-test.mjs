// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Merged suite. Each section below was a standalone suite and keeps its own scope:
//   - token-usage-test.mjs
//   - token-usage-store-test.mjs
//   - upstream-attempt-usage-test.mjs
//   - daily-token-overlay-test.mjs
//   - ttft-query-contract-test.mjs
//   - model-stats-canonicalization-test.mjs

import { createMockD1 } from '#kit/mock-d1-database.mjs';
import { createOpenAIChatStreamFromAnthropic } from '#target/src/conversion/anthropic-stream-to-openai-chat.ts';
import { ensureModelTtftContainers, fmtModelTtft } from '#target/src/dashboard/model-status-view.ts';
import { __resetDashboardCacheForTests, dashboardResponse } from '#target/src/dashboard/pages.ts';
import { metricsResponse } from '#target/src/observability/diagnostic-endpoints.ts';
import { reportedUsageFromPayload } from '#target/src/observability/reported-usage.ts';
import { TTFT_BUCKET_BOUNDARIES_MS, cleanupModelStats, loadUpstreamSummary, normalizeHour, normalizeModelKey, persistTokenUsage, persistUpstreamAttemptUsage, queryAllModelsTtftPercentiles, queryModelUsageCoverage, queryRecentModelEvidence, queryTokenDailySeries, queryTokenModelUsage, queryTokenSummary, tokenStatsD1, tokenUsagePayload } from '#target/src/observability/token-usage-store.ts';
import { __resetTokenStatsForTests, normalizeTokenUsage, normalizeUsageReport, recordTokenUsage, summarizeTokenStats, tokenMetricSeries } from '#target/src/observability/token-usage.ts';
import { withUsageStreamOptions } from '#target/src/protocol/openai.ts';
import { observeUpstreamAttemptUsage, recordTokens, recordUndeliveredUpstreamAttempt } from '#target/src/request/attempt/observability.ts';
import { trackStreamResponse } from '#target/src/stream/track.ts';
import assert from 'node:assert/strict';

// ==========================================================================
// token-usage-test.mjs
// ==========================================================================
try {
  // Unit tests for isolate-local token usage observability: the
  // reported-vs-missing normalization gate, dimension sanitization, aggregation
  // + coverage, the rolling 24h/7d time windows (sum + prune), the
  // transform-level onUsage contract (once per stream; client abort reports
  // nothing), and the public dashboard token panel (4 aggregate cards,
  // compaction formatting, zero-data state, no internal-dimension leak). Run
  // directly; resetTokenStats keeps every test hermetic.









  let passed = 0;
  async function test(name, fn) {
    try {
      __resetTokenStatsForTests();
      __resetDashboardCacheForTests();
      await fn();
      passed++;
      console.log(`ok - ${name}`);
    } catch (e) {
      console.error(`FAIL: ${name}`);
      console.error(e?.stack || e);
      process.exitCode = 1;
    }
  }

  const ENV = { AIG_ACCESS_KEY_AIR: 'test-access-key', AIG_ACCESS_MODELS_AIR: '*' };
  const authedRequest = () =>
    new Request('https://gateway.example.com/', {
      headers: { authorization: 'Bearer test-access-key', accept: 'text/html' },
    });
  const anonRequest = () =>
    new Request('https://gateway.example.com/', {
      headers: { accept: 'text/html' },
    });
  const record = (usage, dims = {}) =>
    recordTokenUsage({
      model: 'm',
      tier: 'tier-1',
      provider: 'p',
      nodeId: 'n',
      ...dims,
      usage,
    });
  const pageText = async (request, env = ENV) => (await dashboardResponse(request, env)).text();
  const deepClone = (o) => JSON.parse(JSON.stringify(o));

  await test('non-object usage normalizes to null (counted missing)', async () => {
    for (const bad of [null, undefined, 'x', 42, [], {}]) assert.equal(normalizeTokenUsage(bad), null, String(bad));
  });

  await test('numeric strings and invalid numbers are rejected, never coerced', async () => {
    assert.equal(normalizeTokenUsage({ prompt_tokens: '5' }), null);
    assert.equal(normalizeTokenUsage({ prompt_tokens: '5', completion_tokens: 3 }), null);
    assert.equal(normalizeTokenUsage({ prompt_tokens: -1 }), null);
    assert.equal(normalizeTokenUsage({ prompt_tokens: Infinity }), null);
    assert.equal(normalizeTokenUsage({ prompt_tokens: NaN }), null);
    assert.equal(normalizeTokenUsage({ prompt_tokens: 2, completion_tokens: '9' }), null);
    assert.equal(normalizeTokenUsage({ prompt_tokens: 2, total_tokens: -1 }), null);
    assert.deepEqual(normalizeTokenUsage({ prompt_tokens: 2 }), { input: 2, output: 0, cacheCreation: 0, cacheRead: 0, effectiveInput: 2, total: 2 });
  });

  await test('openai and anthropic/responses alias shapes both normalize', async () => {
    assert.deepEqual(normalizeTokenUsage({ prompt_tokens: 2, completion_tokens: 3 }), {
      input: 2,
      output: 3,
      cacheCreation: 0,
      cacheRead: 0,
      effectiveInput: 2,
      total: 5,
    });
    assert.deepEqual(normalizeTokenUsage({ input_tokens: 4, output_tokens: 6 }), {
      input: 4,
      output: 6,
      cacheCreation: 0,
      cacheRead: 0,
      effectiveInput: 4,
      total: 10,
    });
    assert.deepEqual(normalizeTokenUsage({ prompt_tokens: 2 }), { input: 2, output: 0, cacheCreation: 0, cacheRead: 0, effectiveInput: 2, total: 2 });
    assert.deepEqual(normalizeTokenUsage({ prompt_tokens: 1.9, completion_tokens: 2.1 }), {
      input: 1,
      output: 2,
      cacheCreation: 0,
      cacheRead: 0,
      effectiveInput: 1,
      total: 3,
    });
  });

  await test('a reported total_tokens wins verbatim over input+output', async () => {
    assert.deepEqual(normalizeTokenUsage({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 10 }), {
      input: 2,
      output: 3,
      cacheCreation: 0,
      cacheRead: 0,
      effectiveInput: 2,
      total: 10,
    });
  });

  await test('OpenAI-compatible cached-token details are recognized without double-counting input', async () => {
    assert.deepEqual(
      normalizeTokenUsage({
        prompt_tokens: 100,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 80 },
      }),
      { input: 100, output: 10, cacheCreation: 0, cacheRead: 80, effectiveInput: 100, total: 110 },
    );
    assert.deepEqual(
      normalizeTokenUsage({
        input_tokens: 120,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: 90 },
      }),
      { input: 120, output: 5, cacheCreation: 0, cacheRead: 90, effectiveInput: 120, total: 125 },
    );
    assert.deepEqual(normalizeTokenUsage({ prompt_tokens: 50, completion_tokens: 2, prompt_cache_hit_tokens: 40 }), {
      input: 50,
      output: 2,
      cacheCreation: 0,
      cacheRead: 40,
      effectiveInput: 50,
      total: 52,
    });
  });

  await test('cache aliases are alternatives, not additive token sources', async () => {
    assert.deepEqual(
      normalizeTokenUsage({
        prompt_tokens: 100,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 80 },
        prompt_cache_hit_tokens: 80,
      }),
      { input: 100, output: 10, cacheCreation: 0, cacheRead: 80, effectiveInput: 100, total: 110 },
    );
    assert.equal(
      normalizeTokenUsage({ prompt_tokens: 50, prompt_tokens_details: { cached_tokens: 51 } }),
      null,
      'cached subset larger than parent input is contradictory',
    );
  });

  await test('Anthropic cache fields remain additive while explicit zero is distinguishable from unreported cache', async () => {
    assert.deepEqual(normalizeTokenUsage({ input_tokens: 30, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 10 }), {
      input: 30,
      output: 10,
      cacheCreation: 10,
      cacheRead: 20,
      effectiveInput: 60,
      total: 70,
    });
    const explicitZero = normalizeUsageReport({ prompt_tokens: 40, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } });
    assert.equal(explicitZero?.hasCacheRead, true);
    assert.equal(explicitZero?.observedCacheInput, 40);
    assert.equal(explicitZero?.observedCacheRead, 0);
    const unreported = normalizeUsageReport({ prompt_tokens: 40, completion_tokens: 1 });
    assert.equal(unreported?.hasCacheRead, false);
    assert.equal(unreported?.observedCacheInput, 0);
    assert.equal(unreported?.observedCacheRead, 0);
  });

  await test('withUsageStreamOptions adds include_usage while preserving existing stream_options', async () => {
    assert.deepEqual(withUsageStreamOptions({ model: 'm', stream: true, stream_options: { other: 'kept' } }), {
      model: 'm',
      stream: true,
      stream_options: { other: 'kept', include_usage: true },
    });
    assert.deepEqual(withUsageStreamOptions({ stream: true, stream_options: { include_usage: false } }), {
      stream: true,
      stream_options: { include_usage: false },
    });
    assert.deepEqual(withUsageStreamOptions({ model: 'm', stream: true }), { model: 'm', stream: true, stream_options: { include_usage: true } });
    assert.deepEqual(withUsageStreamOptions({ stream: true, stream_options: 'bogus' }), { stream: true, stream_options: { include_usage: true } });
  });

  await test('recordTokenUsage: empty usage counts missing, real usage reports — never both', async () => {
    record({ prompt_tokens: 5, completion_tokens: 7 });
    record(null);
    record(undefined);
    record({});
    const t = summarizeTokenStats().totals;
    assert.equal(t.reports, 1);
    assert.equal(t.missing, 3);
    assert.equal(t.input, 5);
    assert.equal(t.output, 7);
    assert.equal(t.total, 12);
  });

  await test('hostile dimension values are sanitized at storage time', async () => {
    record({ prompt_tokens: 1, completion_tokens: 1 }, { model: 'a"b\\c\nd', provider: 'üri provider', nodeId: '', tier: 'tier-9' });
    const [row] = tokenMetricSeries();
    assert.equal(row.model, 'a_b_c_d');
    assert.equal(row.provider, '_ri_provider');
    assert.equal(row.nodeId, 'unknown');
    assert.equal(row.tier, 'tier-9');
  });

  await test('raw hostile dimensions never reach /metrics text', async () => {
    record({ prompt_tokens: 1, completion_tokens: 1 }, { model: 'a"b\\c\nd', provider: 'üri provider', nodeId: '' });
    const text = await metricsResponse(new Request('https://gateway.example.com/metrics'), ENV).text();
    assert.ok(text.includes('a_b_c_d'));
    assert.ok(!text.includes('a"b'));
    assert.ok(!text.includes('üri provider'));
  });

  await test('summarizeTokenStats aggregates per dimension sorted by total desc', async () => {
    record({ prompt_tokens: 100, completion_tokens: 50 }, { model: 'small', provider: 'prov-a', nodeId: 'n1' });
    record({ prompt_tokens: 900, completion_tokens: 600 }, { model: 'big', provider: 'prov-b', nodeId: 'n2' });
    record({ prompt_tokens: 10, completion_tokens: 5 }, { model: 'tiny', provider: 'prov-a', nodeId: 'n1' });
    const s = summarizeTokenStats();
    assert.deepEqual(
      s.byModel.map((r) => r.name),
      ['big', 'small', 'tiny'],
    );
    assert.deepEqual(
      s.byProvider.map((r) => r.name),
      ['prov-b', 'prov-a'],
    );
    assert.deepEqual(
      s.byNode.map((r) => r.name),
      ['n2', 'n1'],
    );
    assert.equal(s.byModel[0].total, 1500);
    assert.equal(s.byProvider[1].total, 165);
  });

  await test('usage coverage is reports/(reports+missing), null at 0/0', async () => {
    assert.equal(summarizeTokenStats().usageCoverage, null);
    record({ prompt_tokens: 1, completion_tokens: 1 });
    record({ prompt_tokens: 1, completion_tokens: 1 });
    record({ prompt_tokens: 1, completion_tokens: 1 });
    record(null);
    const s = summarizeTokenStats();
    assert.equal(s.usageCoverage, 0.75);
    assert.equal(s.totals.reports, 3);
    assert.equal(s.totals.missing, 1);
  });

  await test('usage coverage is also aggregated per dimension row', async () => {
    record({ prompt_tokens: 3, completion_tokens: 0 }, { model: 'cov' });
    record(null, { model: 'cov' });
    record({ prompt_tokens: 1, completion_tokens: 1 }, { model: 'other' });
    const row = summarizeTokenStats().byModel.find((r) => r.name === 'cov');
    assert.equal(row.reports, 1);
    assert.equal(row.missing, 1);
  });

  await test('missing records land in their dimension bucket for accurate per-node coverage', async () => {
    record({ prompt_tokens: 5, completion_tokens: 5 }, { nodeId: 'a', model: 'm' });
    record(null, { nodeId: 'a', model: 'm' });
    record(null, { nodeId: 'b', model: 'm' });
    const s = summarizeTokenStats();
    assert.equal(s.totals.missing, 2);
    assert.equal(s.totals.reports, 1);
    const a = s.byNode.find((r) => r.name === 'a');
    const b = s.byNode.find((r) => r.name === 'b');
    assert.equal(a.reports, 1);
    assert.equal(a.missing, 1);
    assert.equal(b.reports, 0);
    assert.equal(b.missing, 1);
    const series = tokenMetricSeries();
    const bSeries = series.find((r) => r.nodeId === 'b');
    assert.equal(bSeries.missing, 1);
    assert.equal(bSeries.input, 0);
  });

  const cellCount = (html) => (html.match(/class="cell"/g) || []).length;
  const monthLabels = (html) => [...html.matchAll(/<span style="grid-column:\d+">(\d{1,2})月<\/span>/g)].map((m) => m[1]);
  function seededEnv(writes) {
    const d1 = createMockD1();
    const env = deepClone(ENV);
    env.TOKEN_STATS_DB = d1;
    const h0 = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    for (const [usage, offsetHours = 0] of writes) persistTokenUsage(env, usage, h0 - offsetHours * 3_600_000);
    return env;
  }

  await test('no D1 binding degrades to 统计暂不可用 with em dashes, never a fake 0', async () => {
    const html = await pageText(authedRequest(), ENV);
    assert.ok(html.includes('使用情况'));
    assert.ok(!html.includes('class="utc8"'));
    assert.ok(html.includes('今日'));
    assert.ok(html.includes('累计'));
    assert.ok(html.includes('24 小时'));
    assert.ok(!html.includes('近 24 小时'));
    assert.ok(html.includes('7 天'));
    assert.ok(!html.includes('24 小时构成'));
    assert.ok(!html.includes('累计请求'));
    assert.ok(!html.includes('今日 Token'));
    assert.ok(!html.includes('累计 Token'));
    assert.ok(html.includes('>—<'));
    assert.equal((html.match(/>—</g) || []).length, 5);
    assert.ok(html.includes('model-usage-empty'));
    assert.ok(!html.includes('>0<'));
    assert.ok(!html.includes('class="cell"'));
    assert.ok(!html.includes('NaN'));
    assert.ok(!html.includes('undefined'));
    assert.ok(!html.includes('API 地址'));
    assert.ok(!html.includes('api-url'));
    assert.ok(html.includes('快速开始'));
    assert.ok(html.includes('data-tab="openai"'));
    assert.ok(html.includes('data-tab="anthropic"'));
  });

  await test('a failing D1 query also degrades instead of 500 / fake zero', async () => {
    const env = deepClone(ENV);
    env.TOKEN_STATS_DB = createMockD1({ failReads: true });
    const res = await dashboardResponse(authedRequest(), env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('统计暂不可用'));
    assert.ok(!html.includes('>0<'));
    assert.ok(!html.includes('class="cell"'));
  });

  await test('the D1-backed card renders the four KPIs from real aggregates', async () => {
    const env = seededEnv([[{ prompt_tokens: 10, completion_tokens: 20 }], [{ prompt_tokens: 3, completion_tokens: 2 }], [null]]);
    const html = await pageText(anonRequest(), env);
    assert.ok(html.includes('使用情况'));
    assert.ok(html.includes('>35<'));
    assert.ok(!html.includes('class="utc8"'));
    assert.ok(!html.includes('累计请求'));
    assert.ok(!html.includes('Usage 覆盖率'));
  });

  await test('token composition uses cumulative input, output, and reported cache-read totals without an extra heading', async () => {
    const d1 = createMockD1();
    const env = deepClone(ENV);
    env.TOKEN_STATS_DB = d1;
    const HOUR = 3_600_000;
    const h0 = Math.floor(Date.now() / HOUR) * HOUR;
    await persistTokenUsage(env, { input_tokens: 50, output_tokens: 20 }, h0);
    await persistTokenUsage(env, { input_tokens: 30, cache_read_input_tokens: 20, output_tokens: 10 }, h0 - 25 * HOUR);
    const html = await pageText(anonRequest(), env);
    assert.ok(!html.includes('24 小时 Token 构成'));
    assert.ok(!html.includes('累计 Token 构成'));
    assert.ok(!html.includes('输入与输出按物理上游调用统计'));
    assert.ok(html.includes('输入 Token'));
    assert.ok(html.includes('输出 Token'));
    assert.ok(html.includes('缓存读取 Token'));
    assert.match(html, /输入 Token<\/div>\s*<strong>80<\/strong>/);
    assert.match(html, /输出 Token<\/div>\s*<strong>30<\/strong>/);
    assert.match(html, /缓存读取 Token<\/div>\s*<strong>20<\/strong>/);
    assert.match(html, /缓存读取占比<\/div>\s*<strong>40\.0%<\/strong>/);
    assert.ok(html.includes('class="composition-cache"'));
    assert.ok(!html.includes('已包含于输入'));
    assert.match(html, /composition-metric metric-left[^>]*>[\s\S]*?缓存读取占比/);
    assert.match(html, /composition-metric metric-center[^>]*>[\s\S]*?输入 Token/);
    assert.match(html, /composition-metric metric-center[^>]*>[\s\S]*?输出 Token/);
    assert.match(html, /composition-metric metric-right[^>]*>[\s\S]*?缓存读取 Token/);
    assert.ok(html.indexOf('缓存读取占比</div>') < html.indexOf('输入 Token</div>'));
    assert.ok(html.indexOf('输入 Token</div>') < html.indexOf('输出 Token</div>'));
    assert.ok(html.indexOf('输出 Token</div>') < html.indexOf('缓存读取 Token</div>'));
    assert.ok(!html.includes('class="cache-ring"'));
  });

  await test('token composition renders unknown cache as dash instead of zero when no provider reported cache detail', async () => {
    const d1 = createMockD1();
    const env = deepClone(ENV);
    env.TOKEN_STATS_DB = d1;
    const h0 = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    await persistTokenUsage(env, { prompt_tokens: 100, completion_tokens: 10 }, h0);
    const html = await pageText(anonRequest(), env);
    assert.match(html, /缓存读取占比<\/div>\s*<strong>—<\/strong>/);
    assert.match(html, /缓存读取 Token<\/div>\s*<strong>—<\/strong>/);
  });

  await test('模型使用 renders ranked rows with proportional bars', async () => {
    const d1 = createMockD1();
    const env = deepClone(ENV);
    env.TOKEN_STATS_DB = d1;
    const HOUR = 3_600_000;
    const h0 = Math.floor(Date.now() / HOUR) * HOUR;
    await persistTokenUsage(env, { prompt_tokens: 100, completion_tokens: 0 }, h0, 'code-max');
    await persistTokenUsage(env, { prompt_tokens: 40, completion_tokens: 10 }, h0, 'ultra');
    const html = await pageText(anonRequest(), env);
    assert.ok(html.includes('模型使用 · 近 7 天'));
    assert.ok(html.includes('model-ranking'));
    assert.ok(html.includes('model-rank-row'));
    assert.ok(html.includes('code-max'));
    assert.ok(html.includes('ultra'));
    assert.ok(html.includes('model-rank-bar'));
    assert.ok(html.includes('data-tooltip='));
    assert.ok(!html.includes('class="donut"'));
    assert.ok(html.includes('code-max\n100 Token'));
    assert.ok(html.includes('ultra\n50 Token'));
    assert.match(html, /<div class="model-rank-value">100<\/div>/);
    assert.match(html, /<div class="model-rank-value">50<\/div>/);
  });

  await test('模型使用 shows official logical IDs, not lowercase statistics keys', async () => {
    __resetDashboardCacheForTests();
    const d1 = createMockD1();
    const env = deepClone(ENV);
    env.TOKEN_STATS_DB = d1;
    env.AIG_TIER1_NODES_01 = JSON.stringify([
      { id: 'node-a', provider: 'mock', base_url: 'https://a.example.com/v1', models: { 'Code-Max': 'up-max', 'Code-Ultra': 'up-ultra' } },
    ]);
    env.AIG_TIER1_CREDENTIALS_01 = JSON.stringify({ 'node-a': 'test-key' });
    const HOUR = 3_600_000;
    const h0 = Math.floor(Date.now() / HOUR) * HOUR;
    await persistTokenUsage(env, { prompt_tokens: 900, completion_tokens: 0 }, h0, 'code-max');
    await persistTokenUsage(env, { prompt_tokens: 300, completion_tokens: 0 }, h0, 'CODE-ULTRA');
    const html = await pageText(anonRequest(), env);
    assert.ok(html.includes('>Code-Max<'));
    assert.ok(html.includes('>Code-Ultra<'));
    assert.ok(!html.includes('>code-max<'));
    assert.ok(!html.includes('>code-ultra<'));
    assert.ok(html.includes('Code-Max\n900 Token'));
  });

  await test('模型使用 keeps Top 3 and folds the remainder into one 其他 row', async () => {
    const d1 = createMockD1();
    const env = deepClone(ENV);
    env.TOKEN_STATS_DB = d1;
    const HOUR = 3_600_000;
    const h0 = Math.floor(Date.now() / HOUR) * HOUR;
    const models = [
      ['m1', 600],
      ['m2', 500],
      ['m3', 400],
      ['m4', 300],
      ['m5', 30],
      ['m6', 20],
    ];
    for (const [model, tokens] of models) await persistTokenUsage(env, { prompt_tokens: tokens, completion_tokens: 0 }, h0, model);
    const html = await pageText(anonRequest(), env);
    for (const model of ['m1', 'm2', 'm3']) assert.ok(html.includes(`>${model}<`));
    for (const model of ['m4', 'm5', 'm6']) assert.ok(!html.includes(`>${model}<`));
    assert.ok(html.includes('>其他<'));
    assert.match(html, /<div class="model-rank-value">350<\/div>/);
  });

  await test('Token 活动 · 近 52 周 renders a full 364-cell heatmap with month labels', async () => {
    const env = seededEnv([[{ prompt_tokens: 7, completion_tokens: 7 }]]);
    const html = await pageText(anonRequest(), env);
    assert.ok(html.includes('Token 活动 · 近 52 周'));
    assert.ok(html.includes('次请求'));
    assert.ok(!html.includes('次上游调用'));
    assert.equal(cellCount(html), 364);
    const labels = monthLabels(html);
    assert.ok(labels.length >= 11 && labels.length <= 13);
    for (const label of labels) assert.match(label, /^\d{1,2}$/);
    assert.ok(html.includes('data-level="4"'));
    assert.ok(html.includes('data-level="0"'));
    assert.ok(html.includes('data-tooltip="'));
    assert.ok(html.includes('· 1 次请求'));
    assert.match(html, /class="heatmap-wrap" tabindex="0" role="img"/);
    assert.ok(html.includes('aria-label="近 52 周 Token 活动热力图'));
  });

  await test('the heatmap colors derive from daily totals, not per-hour noise', async () => {
    const env = seededEnv([[{ prompt_tokens: 4000, completion_tokens: 0 }], [{ prompt_tokens: 1000, completion_tokens: 0 }, 24]]);
    const html = await pageText(authedRequest(), env);
    assert.ok(html.includes('data-level="4"'));
    assert.ok(html.includes('data-level="1"'));
    assert.ok(html.includes('4000') && html.includes('Token'));
    assert.ok(!html.includes('4,000 Token'));
  });

  await test('the usage card leaks no internal dimensions', async () => {
    record(
      { prompt_tokens: 10, completion_tokens: 20 },
      { model: 'secret-model', provider: 'secret-provider', nodeId: 'secret-node', tier: 'secret-tier' },
    );
    const env = seededEnv([[{ prompt_tokens: 1, completion_tokens: 1 }]]);
    const html = await pageText(anonRequest(), env);
    assert.ok(!html.includes('secret-node'));
    assert.ok(!html.includes('secret-provider'));
    assert.ok(!html.includes('secret-tier'));
    assert.ok(!html.includes('secret-model'));
  });

  await test('Chinese unit (万/亿) compaction renders on KPI values, never K/M/B', async () => {
    const card = async (usage) => pageText(authedRequest(), seededEnv([[usage]]));
    assert.ok((await card({ prompt_tokens: 0, completion_tokens: 0 })).includes('>0<'));
    assert.ok((await card({ prompt_tokens: 999, completion_tokens: 0 })).includes('>999<'));
    assert.ok((await card({ prompt_tokens: 9820, completion_tokens: 0 })).includes('>9820<'));
    assert.ok((await card({ prompt_tokens: 10000, completion_tokens: 0 })).includes('>1万<'));
    assert.ok((await card({ prompt_tokens: 128000, completion_tokens: 0 })).includes('>12.8万<'));
    assert.ok((await card({ prompt_tokens: 1280000, completion_tokens: 0 })).includes('>128万<'));
    assert.ok((await card({ prompt_tokens: 48600000, completion_tokens: 0 })).includes('>4860万<'));
    assert.ok((await card({ prompt_tokens: 128000000, completion_tokens: 0 })).includes('>1.28亿<'));
    assert.ok((await card({ prompt_tokens: 2500000000, completion_tokens: 0 })).includes('>25亿<'));
    const one = await card({ prompt_tokens: 1, completion_tokens: 0 });
    assert.ok(!one.includes('NaN'));
    const cardHtml = await card({ prompt_tokens: 1234567, completion_tokens: 0 });
    assert.ok(!cardHtml.includes('K<') && !cardHtml.includes('M<') && !cardHtml.includes('B<'));
  });

  await test('rolling 24h/7d windows sum recent totals and prune expired buckets', async () => {
    const h0 = Math.floor(Date.now() / 3600_000) * 3600_000;
    const HOUR = 3600_000,
      DAY = 86400_000;
    record({ prompt_tokens: 50, completion_tokens: 50 }, { now: h0 });
    record({ prompt_tokens: 50, completion_tokens: 50 }, { now: h0 + HOUR });
    record({ prompt_tokens: 50, completion_tokens: 50 }, { now: h0 + 2 * HOUR });
    let s = summarizeTokenStats();
    assert.equal(s.windows.h24.total, 300);
    assert.equal(s.windows.d7.total, 300);
    assert.equal(s.windows.h24.reports, 3);
    record({ prompt_tokens: 10, completion_tokens: 0 }, { now: h0 + 27 * HOUR });
    s = summarizeTokenStats();
    assert.equal(s.windows.h24.total, 10);
    assert.equal(s.windows.h24.reports, 1);
    assert.equal(s.windows.d7.total, 310);
    record({ prompt_tokens: 5, completion_tokens: 0 }, { now: h0 + 27 * HOUR + 8 * DAY });
    s = summarizeTokenStats();
    assert.equal(s.windows.d7.total, 5);
    assert.equal(s.windows.h24.total, 5);
    assert.equal(s.totals.total, 315);
  });

  const encoder = new TextEncoder();
  function sseUpstream(lines) {
    return new Response(
      new ReadableStream({
        pull(c) {
          for (const line of lines.splice(0)) c.enqueue(encoder.encode(line));
          c.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }
  const _chatChunk = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
  const _chatUsage = (usage) => `data: ${JSON.stringify({ choices: [], usage })}\n\n`;
  async function drain(response) {
    const reader = response.body.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) return;
    }
  }
  const noopTrack = { idleTimeoutMs: 0, onSuccess: () => {}, onFailure: () => {}, onNeutral: () => {} };
  const anthropicTextDelta = (text) =>
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`;
  const anthropicUsage = (input, output) =>
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: input, output_tokens: output } })}\n\n`;
  const anthropicStop = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  const responsesTextDelta = (text) =>
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', sequence_number: 1, item_id: 'msg_1', output_index: 0, content_index: 0, delta: text })}\n\n`;
  const responsesCompleted = (usage) =>
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', sequence_number: 2, response: { id: 'resp_1', object: 'response', status: 'completed', model: 'up-model', output: [], usage } })}\n\n`;

  await test('anthropic passthrough: interrupted does NOT report usage', async () => {
    const calls = [];
    const upstream = sseUpstream([anthropicTextDelta('partial'), anthropicUsage(6, 8)]);
    const res = trackStreamResponse(upstream, { ...noopTrack, completionMarker: /event:\s*message_stop\b/, onUsage: (u) => calls.push(u) });
    await drain(res);
    assert.equal(calls.length, 0, 'interrupted stream must not report usage');
  });
  await test('anthropic passthrough: client abort reports nothing', async () => {
    const calls = [];
    const ac = new AbortController();
    const upstream = new Response(
      new ReadableStream({
        pull(c) {
          c.enqueue(encoder.encode(anthropicTextDelta('flowing')));
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
    const res = trackStreamResponse(upstream, { ...noopTrack, completionMarker: /event:\s*message_stop\b/, onUsage: (u) => calls.push(u) });
    const reader = res.body.getReader();
    await reader.read();
    ac.abort();
    await reader.cancel().catch(() => {});
    assert.equal(calls.length, 0);
  });
  await test('responses passthrough: completed stream reports usage exactly once (verbatim native shape)', async () => {
    const calls = [];
    const upstream = sseUpstream([responsesTextDelta('hello'), responsesCompleted({ input_tokens: 6, output_tokens: 8, total_tokens: 14 })]);
    const res = trackStreamResponse(upstream, {
      ...noopTrack,
      completionMarker: /event:\s*response\.(?:completed|incomplete)\b/,
      onUsage: (u) => calls.push(u),
    });
    await drain(res);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { input_tokens: 6, output_tokens: 8, total_tokens: 14 });
  });
  await test('responses passthrough: client abort reports nothing', async () => {
    const calls = [];
    const ac = new AbortController();
    const upstream = new Response(
      new ReadableStream({
        pull(c) {
          c.enqueue(encoder.encode(responsesTextDelta('flowing')));
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
    const res = trackStreamResponse(upstream, {
      ...noopTrack,
      completionMarker: /event:\s*response\.(?:completed|incomplete)\b/,
      onUsage: (u) => calls.push(u),
    });
    const reader = res.body.getReader();
    await reader.read();
    ac.abort();
    await reader.cancel().catch(() => {});
    assert.equal(calls.length, 0);
  });
  await test('passthrough without onUsage stays fully functional (observability optional)', async () => {
    const upstream = sseUpstream([anthropicTextDelta('hello'), anthropicUsage(1, 1), anthropicStop]);
    const res = trackStreamResponse(upstream, { ...noopTrack, completionMarker: /event:\s*message_stop\b/ });
    const text = await res.text();
    assert.ok(text.includes('message_stop'));
  });

  await test('dashboard D1 cache coalesces concurrent requests within TTL', async () => {
    const d1 = createMockD1();
    const env = deepClone(ENV);
    env.TOKEN_STATS_DB = d1;
    const HOUR = 3_600_000;
    const h0 = Math.floor(Date.now() / HOUR) * HOUR;
    await persistTokenUsage(env, { prompt_tokens: 100, completion_tokens: 0 }, h0, 'code-max');
    const [html1, html2] = await Promise.all([pageText(anonRequest(), env), pageText(anonRequest(), env)]);
    // Each render mints its own CSP nonce, so strip it before comparing.
    assert.equal(html1.replace(/nonce="[^"]*"/g, 'nonce=""'), html2.replace(/nonce="[^"]*"/g, 'nonce=""'));
    assert.equal(d1._reads.length, 8);
    await pageText(anonRequest(), env);
    assert.equal(d1._reads.length, 8);
  });
  await test('dashboard D1 cache refreshes after TTL expires', async () => {
    const d1 = createMockD1();
    const env = deepClone(ENV);
    env.TOKEN_STATS_DB = d1;
    const HOUR = 3_600_000;
    const h0 = Math.floor(Date.now() / HOUR) * HOUR;
    await persistTokenUsage(env, { prompt_tokens: 100, completion_tokens: 0 }, h0, 'code-max');
    const realNow = Date.now;
    let fakeNow = h0 + 1_000;
    Date.now = () => fakeNow;
    try {
      const html1 = await pageText(anonRequest(), env);
      assert.ok(html1.includes('code-max'));
      assert.equal(d1._reads.length, 8);
      await persistTokenUsage(env, { prompt_tokens: 200, completion_tokens: 0 }, h0, 'ultra');
      fakeNow += 44_000;
      const cached = await pageText(anonRequest(), env);
      assert.ok(!cached.includes('>200<'));
      assert.equal(d1._reads.length, 8);
      fakeNow += 2_000;
      const refreshed = await pageText(anonRequest(), env);
      assert.ok(refreshed.includes('>200<'));
      assert.ok(refreshed.includes('code-max'));
      assert.equal(d1._reads.length, 16);
    } finally {
      Date.now = realNow;
    }
  });
  await test('dashboard cache does not leak across different D1 bindings', async () => {
    const d1a = createMockD1();
    const d1b = createMockD1();
    const envA = deepClone(ENV);
    const envB = deepClone(ENV);
    envA.TOKEN_STATS_DB = d1a;
    envB.TOKEN_STATS_DB = d1b;
    const HOUR = 3_600_000;
    const h0 = Math.floor(Date.now() / HOUR) * HOUR;
    await persistTokenUsage(envA, { prompt_tokens: 100, completion_tokens: 0 }, h0, 'model-a');
    await persistTokenUsage(envB, { prompt_tokens: 200, completion_tokens: 0 }, h0, 'model-b');
    const htmlA = await pageText(anonRequest(), envA);
    assert.ok(htmlA.includes('model-a'));
    assert.ok(!htmlA.includes('model-b'));
    const htmlB = await pageText(anonRequest(), envB);
    assert.ok(htmlB.includes('model-b'));
    assert.ok(!htmlB.includes('model-a'));
    assert.equal(d1a._reads.length, 8);
    assert.equal(d1b._reads.length, 8);
  });
  await test('public homepage does not leak raw D1 errors in degraded state', async () => {
    __resetDashboardCacheForTests();
    const d1 = createMockD1({ failReads: true });
    const env = deepClone(ENV);
    env.TOKEN_STATS_DB = d1;
    const html = await pageText(anonRequest(), env);
    assert.ok(html.includes('统计暂不可用'));
    for (const leak of [
      'token_usage_hourly',
      'token_usage_model_hourly',
      'TOKEN_STATS_DB',
      'mock D1 read failure',
      'SELECT',
      'FROM',
      'WHERE',
      'GROUP BY',
      'ORDER BY',
    ])
      assert.ok(!html.includes(leak));
  });
  await test('model usage panel does not leak raw D1 errors in degraded state', async () => {
    __resetDashboardCacheForTests();
    const d1 = createMockD1({ failReads: true });
    const env = deepClone(ENV);
    env.TOKEN_STATS_DB = d1;
    const html = await pageText(anonRequest(), env);
    assert.ok(html.includes('模型使用'));
    assert.ok(html.includes('model-usage-empty'));
    for (const leak of ['token_usage_model_hourly', 'mock D1 read failure', 'SELECT', 'FROM']) assert.ok(!html.includes(leak));
  });
  await test('模型状态 section has model rows with status, P50, P95, sample count', async () => {
    __resetDashboardCacheForTests();
    const d1 = createMockD1();
    const env = deepClone(ENV);
    env.TOKEN_STATS_DB = d1;
    env.AIG_TIER1_NODES_01 = JSON.stringify([{ id: 'node-a', provider: 'mock', base_url: 'https://a.example.com/v1', models: { max: 'up-max' } }]);
    env.AIG_TIER1_CREDENTIALS_01 = JSON.stringify({ 'node-a': 'test-key' });
    const html = await pageText(anonRequest(), env);
    assert.ok(html.includes('P50'));
    assert.ok(html.includes('P95'));
    assert.ok(html.includes('samples'));
    assert.ok(html.includes('mr-status'));
    assert.ok(html.includes('status-grid'));
  });
  await test('使用情况 section does NOT contain success rate, reliability, TTFT P50, TTFT P95', async () => {
    __resetDashboardCacheForTests();
    const d1 = createMockD1();
    const env = deepClone(ENV);
    env.TOKEN_STATS_DB = d1;
    const html = await pageText(anonRequest(), env);
    for (const leak of ['perf-section', '成功率', 'reliability', 'Reliability', 'Model Reliability', 'Provider Reliability', '可靠性'])
      assert.ok(!html.includes(leak));
    assert.ok(html.includes('使用情况'));
    assert.ok(html.includes('Token 活动'));
  });
  await test('public dashboard does not leak provider, node id, tier, credential, key', async () => {
    __resetDashboardCacheForTests();
    const d1 = createMockD1();
    const env = deepClone(ENV);
    env.TOKEN_STATS_DB = d1;
    const html = await pageText(anonRequest(), env);
    for (const leak of ['provider', 'node', 'tier', 'credential', 'api_key', 'cooldown', 'circuit']) assert.ok(!html.includes(leak));
  });
  await test('model status section is structurally separate from usage section', async () => {
    __resetDashboardCacheForTests();
    const d1 = createMockD1();
    const env = deepClone(ENV);
    env.TOKEN_STATS_DB = d1;
    env.AIG_TIER1_NODES_01 = JSON.stringify([
      { id: 'node-a', provider: 'mock', base_url: 'https://a.example.com/v1', models: { 'unconfigured-model': 'up-x' } },
    ]);
    env.AIG_TIER1_CREDENTIALS_01 = JSON.stringify({ 'node-a': 'test-key' });
    const html = await pageText(anonRequest(), env);
    const modelStatusIdx = html.indexOf('模型状态');
    const usageIdx = html.indexOf('使用情况');
    assert.ok(modelStatusIdx >= 0);
    assert.ok(usageIdx >= 0);
    assert.ok(modelStatusIdx < usageIdx);
    assert.ok(!html.includes('perf-section'));
    assert.ok(!html.includes('可靠性 · 性能'));
    assert.ok(html.includes('status-grid'));
  });

  if (!process.exitCode) console.log(`\ntoken-usage tests passed (${passed}).`);
  else suiteExit(1);
  console.log('ok - file:token-usage');
} catch (error) {
  console.error('not ok - token-usage-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// token-usage-store-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs
  //
  // Unit tests for the Cloudflare D1 token-usage store
  // (src/observability/token-usage-store.ts): UTC hour normalization, per-response
  // payload derivation, atomic UPSERT persistence (insert / same-hour upsert /
  // different hours / reports / missing / requests / totals), the aggregate
  // dashboard query (cumulative / 24h / 7d / coverage), and the fail-open
  // contract (no binding, write rejection, read rejection — none may ever throw
  // or fabricate tokens). Run directly.




  let passed = 0;
  async function test(name, fn) {
    try {
      await fn();
      passed++;
      console.log(`ok - ${name}`);
    } catch (e) {
      console.error(`FAIL: ${name}`);
      console.error(e?.stack || e);
      process.exitCode = 1;
    }
  }

  const HOUR = 3600_000;
  const DAY = 86400_000;
  const H0 = Math.floor(Date.now() / HOUR) * HOUR;

  // ---- normalizeHour -----------------------------------------------------------

  await test('normalizeHour produces a UTC-aligned YYYY-MM-DDTHH:00:00Z key', async () => {
    assert.equal(normalizeHour(new Date('2026-08-28T08:59:59Z')), '2026-08-28T08:00:00Z');
    assert.equal(normalizeHour(H0), `${new Date(H0).toISOString().slice(0, 13)}:00:00Z`);
    assert.equal(normalizeHour(new Date('2026-01-01T23:30:00Z')), '2026-01-01T23:00:00Z');
  });

  // ---- tokenUsagePayload (reported-vs-missing gate) ----------------------------

  await test('reported usage yields a report payload with its token totals', async () => {
    assert.deepEqual(tokenUsagePayload({ prompt_tokens: 2, completion_tokens: 3 }), {
      input: 2,
      output: 3,
      cacheCreation: 0,
      cacheRead: 0,
      effectiveInput: 2,
      observedCacheRead: 0,
      observedCacheInput: 0,
      cacheReadReports: 0,
      total: 5,
      requests: 1,
      reports: 1,
      missing: 0,
    });
    assert.deepEqual(tokenUsagePayload({ input_tokens: 4, output_tokens: 6 }), {
      input: 4,
      output: 6,
      cacheCreation: 0,
      cacheRead: 0,
      effectiveInput: 4,
      observedCacheRead: 0,
      observedCacheInput: 0,
      cacheReadReports: 0,
      total: 10,
      requests: 1,
      reports: 1,
      missing: 0,
    });
  });

  await test('missing usage yields a missing payload and never fabricates tokens', async () => {
    for (const usage of [null, undefined, {}, [], 'x', 42]) {
      assert.deepEqual(
        tokenUsagePayload(usage),
        {
          input: 0,
          output: 0,
          cacheCreation: 0,
          cacheRead: 0,
          effectiveInput: 0,
          observedCacheRead: 0,
          observedCacheInput: 0,
          cacheReadReports: 0,
          total: 0,
          requests: 1,
          reports: 0,
          missing: 1,
        },
        String(usage),
      );
    }
  });

  // ---- persistTokenUsage: atomic hour-bucket UPSERT ---------------------------

  await test('first insert creates the hour bucket and records both accounting views', async () => {
    const d1 = createMockD1();
    await persistTokenUsage({ TOKEN_STATS_DB: d1 }, { prompt_tokens: 2, completion_tokens: 8 }, H0);
    assert.deepEqual(d1._rows.get(normalizeHour(H0)), {
      input: 2,
      output: 8,
      cacheCreation: 0,
      cacheRead: 0,
      total: 10,
      requests: 1,
      reports: 1,
      missing: 0,
      upstreamInput: 2,
      upstreamOutput: 8,
      upstreamCacheCreation: 0,
      upstreamCacheRead: 0,
      upstreamEffectiveInput: 2,
      upstreamObservedRead: 0,
      upstreamObservedInput: 0,
      upstreamReadReports: 0,
      upstreamTotal: 10,
      upstreamAttempts: 1,
      upstreamReports: 1,
      upstreamMissing: 0,
    });
    assert.equal(d1._writes.length, 2, 'global + totals writes');
    assert.match(d1._writes[0].sql, /ON CONFLICT\(hour\) DO UPDATE SET/);
    assert.match(d1._writes[1].sql, /token_usage_totals/i, 'second write is totals');
  });

  await test('same-hour upsert accumulates delivered and upstream success views atomically', async () => {
    const d1 = createMockD1();
    await persistTokenUsage({ TOKEN_STATS_DB: d1 }, { prompt_tokens: 2, completion_tokens: 3 }, H0);
    await persistTokenUsage({ TOKEN_STATS_DB: d1 }, { prompt_tokens: 4, completion_tokens: 6 }, H0);
    assert.deepEqual(d1._rows.get(normalizeHour(H0)), {
      input: 6,
      output: 9,
      cacheCreation: 0,
      cacheRead: 0,
      total: 15,
      requests: 2,
      reports: 2,
      missing: 0,
      upstreamInput: 6,
      upstreamOutput: 9,
      upstreamCacheCreation: 0,
      upstreamCacheRead: 0,
      upstreamEffectiveInput: 6,
      upstreamObservedRead: 0,
      upstreamObservedInput: 0,
      upstreamReadReports: 0,
      upstreamTotal: 15,
      upstreamAttempts: 2,
      upstreamReports: 2,
      upstreamMissing: 0,
    });
  });

  await test('different hours create separate buckets', async () => {
    const d1 = createMockD1();
    await persistTokenUsage({ TOKEN_STATS_DB: d1 }, { prompt_tokens: 1, completion_tokens: 0 }, H0);
    await persistTokenUsage({ TOKEN_STATS_DB: d1 }, { prompt_tokens: 0, completion_tokens: 2 }, H0 + HOUR);
    assert.equal(d1._rows.size, 2);
    assert.equal(d1._rows.get(normalizeHour(H0)).total, 1);
    assert.equal(d1._rows.get(normalizeHour(H0 + HOUR)).total, 2);
  });

  await test('missing usage bumps both success and upstream coverage counters, never tokens', async () => {
    const d1 = createMockD1();
    await persistTokenUsage({ TOKEN_STATS_DB: d1 }, null, H0);
    await persistTokenUsage({ TOKEN_STATS_DB: d1 }, {}, H0);
    const row = d1._rows.get(normalizeHour(H0));
    assert.deepEqual(row, {
      input: 0,
      output: 0,
      cacheCreation: 0,
      cacheRead: 0,
      total: 0,
      requests: 2,
      reports: 0,
      missing: 2,
      upstreamInput: 0,
      upstreamOutput: 0,
      upstreamCacheCreation: 0,
      upstreamCacheRead: 0,
      upstreamEffectiveInput: 0,
      upstreamObservedRead: 0,
      upstreamObservedInput: 0,
      upstreamReadReports: 0,
      upstreamTotal: 0,
      upstreamAttempts: 2,
      upstreamReports: 0,
      upstreamMissing: 2,
    });
  });

  // ---- tokenStatsD1: binding detection ----------------------------------------

  await test('tokenStatsD1 returns null when the binding is missing or not a D1', async () => {
    assert.equal(tokenStatsD1({}), null);
    assert.equal(tokenStatsD1({ TOKEN_STATS_DB: {} }), null);
    assert.equal(tokenStatsD1(undefined), null);
    const d1 = createMockD1();
    assert.equal(tokenStatsD1({ TOKEN_STATS_DB: d1 }), d1);
  });

  // ---- queryTokenSummary: cumulative / 24h / 7d / coverage --------------------

  await test('no binding -> queryTokenSummary returns null (dashboard degrades)', async () => {
    assert.equal(await queryTokenSummary({}), null);
  });

  await test('cumulative, 24h and 7d windows sum the right buckets', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    // A at H0 (5) is current; B at H0-25h (10) inside 7d but outside 24h; C at
    // H0-9d (20) outside 7d. Query "now" just after A.
    await persistTokenUsage(env, { prompt_tokens: 5, completion_tokens: 0 }, H0);
    await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 0 }, H0 - 25 * HOUR);
    await persistTokenUsage(env, { prompt_tokens: 20, completion_tokens: 0 }, H0 - 9 * DAY);
    const s = await queryTokenSummary(env, H0 + HOUR);
    assert.equal(s.available, true);
    assert.equal(s.cumulative.total, 35);
    assert.equal(s.cumulative.requests, 3);
    // 24h window only contains A (B is >24h old).
    assert.equal(s.h24.total, 5);
    assert.equal(s.h24.requests, 1);
    // 7d window contains A + B (C is >7d old).
    assert.equal(s.d7.total, 15);
    assert.equal(s.d7.requests, 2);
  });

  await test('upstream cumulative summary exposes lifetime input/output/cache composition from totals', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    await persistTokenUsage(env, { input_tokens: 50, output_tokens: 20 }, H0);
    await persistTokenUsage(env, { input_tokens: 30, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 10 }, H0 - 25 * HOUR);
    const s = await loadUpstreamSummary(env, H0 + HOUR);
    assert.equal(s.available, true);
    assert.equal(s.cumulative.input, 90, 'recognized cache-read tokens are split out of input');
    assert.equal(s.cumulative.output, 30);
    assert.equal(s.cumulative.cacheRead, 20);
    assert.equal(s.cumulative.cacheHitRatio, 20 / 60, 'cache ratio only uses reliable cache-observed input');
    assert.equal(s.h24.input, 50, '24h input remains a separate rolling-window metric');
    assert.equal(s.h24.output, 20, '24h output remains a separate rolling-window metric');
  });

  await test('historical cache totals stay in input until reliable cache observation begins', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    await persistTokenUsage(env, { prompt_tokens: 1, completion_tokens: 0 }, H0);

    const historical = {
      upstreamInput: 80,
      upstreamOutput: 10,
      upstreamCacheCreation: 0,
      upstreamCacheRead: 20,
      upstreamEffectiveInput: 100,
      upstreamObservedRead: 0,
      upstreamObservedInput: 0,
      upstreamReadReports: 0,
      upstreamTotal: 110,
      upstreamAttempts: 1,
      upstreamReports: 1,
      upstreamMissing: 0,
    };
    Object.assign(d1._rows.get(normalizeHour(H0)), historical);
    Object.assign(d1._totalsRow, historical);

    const s = await loadUpstreamSummary(env, H0 + HOUR / 2);
    assert.equal(s.available, true);
    assert.equal(s.cumulative.input, 100, 'pre-cutover cache is not split from historical input');
    assert.equal(s.cumulative.cacheRead, 0, 'pre-cutover cache totals are excluded from reliable cache display');
    assert.equal(s.cumulative.cacheHitRatio, null);
  });

  await test('upstream summary recognizes OpenAI-compatible cached-token details without inflating input', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    await persistTokenUsage(
      env,
      {
        prompt_tokens: 100,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 80 },
      },
      H0,
    );
    await persistTokenUsage(env, { prompt_tokens: 50, completion_tokens: 5 }, H0);
    const s = await loadUpstreamSummary(env, H0 + HOUR / 2);
    assert.equal(s.available, true);
    assert.equal(s.cumulative.input, 70, 'recognized cached tokens are split out while unknown cache stays in input');
    assert.equal(s.cumulative.output, 15);
    assert.equal(s.cumulative.cacheRead, 80);
    assert.equal(s.cumulative.cacheReadReports, 1);
    assert.equal(s.cumulative.cacheHitRatio, 0.8);
  });

  await test('explicit zero cache report is preserved as observed zero instead of unknown', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    await persistTokenUsage(
      env,
      {
        input_tokens: 40,
        output_tokens: 2,
        input_tokens_details: { cached_tokens: 0 },
      },
      H0,
    );
    const s = await loadUpstreamSummary(env, H0 + HOUR / 2);
    assert.equal(s.available, true);
    assert.equal(s.cumulative.cacheRead, 0);
    assert.equal(s.cumulative.cacheReadReports, 1);
    assert.equal(s.cumulative.cacheHitRatio, 0);
  });

  await test('coverage is reports/(reports+missing), null at 0/0', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    await persistTokenUsage(env, { prompt_tokens: 1, completion_tokens: 1 }, H0);
    await persistTokenUsage(env, { prompt_tokens: 1, completion_tokens: 1 }, H0);
    await persistTokenUsage(env, { prompt_tokens: 1, completion_tokens: 1 }, H0);
    await persistTokenUsage(env, null, H0);
    const s = await queryTokenSummary(env, H0 + HOUR);
    assert.equal(s.cumulative.requests, 4);
    assert.equal(s.cumulative.reports, 3);
    assert.equal(s.cumulative.missing, 1);
    assert.equal(s.coverage, 0.75);
    assert.equal(s.h24.requests, 4);
    assert.equal(s.d7.requests, 4);
  });

  await test('today follows the UTC+8 day boundary (Beijing 00:00 = 16:00Z)', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    // H0 is the current hour; H0 - 24h is 24 hours before.
    // In UTC+8, they fall on different calendar days because they are exactly 24h apart.
    await persistTokenUsage(env, { prompt_tokens: 5, completion_tokens: 0 }, H0);
    await persistTokenUsage(env, { prompt_tokens: 7, completion_tokens: 0 }, H0 - 24 * HOUR);
    const s = await queryTokenSummary(env, H0 + HOUR / 2);
    assert.equal(s.today.total, 5, 'only the current UTC+8 day counts as today');
    assert.equal(s.today.requests, 1);
    assert.equal(s.cumulative.total, 12, 'cumulative still counts both days');
  });

  // ---- queryTokenDailySeries: daily rollup for the activity heatmap -----------

  // Helper: convert UTC ms to UTC+8 date string (YYYY-MM-DD)
  function _toUtc8Day(ms) {
    return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
  }

  await test('daily series groups hourly buckets by UTC+8 day', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    // Use fixed timestamps to ensure deterministic UTC+8 day boundaries.
    // 2026-08-29 00:00 UTC+8 = 2026-08-28T16:00:00Z
    const d0_00 = Date.UTC(2026, 7, 28, 16, 0, 0); // 2026-08-28T16:00:00Z = 2026-08-29 UTC+8
    const d0_01 = Date.UTC(2026, 7, 28, 17, 0, 0); // 2026-08-28T17:00:00Z = 2026-08-29 UTC+8 (same day)
    const d1_00 = Date.UTC(2026, 7, 27, 16, 0, 0); // 2026-08-27T16:00:00Z = 2026-08-28 UTC+8 (previous day)
    await persistTokenUsage(env, { prompt_tokens: 1, completion_tokens: 2 }, d0_00);
    await persistTokenUsage(env, { prompt_tokens: 3, completion_tokens: 4 }, d0_01);
    await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 0 }, d1_00);
    const day = '2026-08-29'; // UTC+8 day for d0_00 and d0_01
    const prevDay = '2026-08-28'; // UTC+8 day for d1_00
    const series = await queryTokenDailySeries(env, prevDay, d0_01 + HOUR);
    assert.equal(series.get(day).total, 10, 'two same UTC+8-day buckets roll up');
    assert.equal(series.get(day).requests, 2);
    assert.equal(series.get(prevDay).total, 10);
    // Days before the requested start are excluded.
    const strict = await queryTokenDailySeries(env, day, d0_01 + HOUR);
    assert.equal(strict.size, 1);
    assert.ok(strict.has(day));
  });

  await test('daily series fails open on missing binding or read errors', async () => {
    assert.equal(await queryTokenDailySeries({}, '2026-08-28'), null);
    const d1 = createMockD1({ failReads: true });
    const result = await queryTokenDailySeries({ TOKEN_STATS_DB: d1 }, '2026-08-28');
    assert.ok(result && result.available === false, 'returns error object on failure');
    assert.ok(result.error, 'error message present');
  });

  // ---- Fail-open contract -----------------------------------------------------

  await test('persistTokenUsage with no binding resolves without touching D1', async () => {
    let called = false;
    const _env = {
      TOKEN_STATS_DB: {
        prepare: () => {
          called = true;
        },
      },
    };
    // A non-D1-looking prepare is rejected by tokenStatsD1, so persistence skips.
    const res = await persistTokenUsage({}, { prompt_tokens: 1 });
    assert.equal(res, undefined);
    assert.equal(called, false);
  });

  await test('a D1 write rejection rejects the returned promise (caller swallows it)', async () => {
    const d1 = createMockD1({ failWrites: true });
    await assert.rejects(persistTokenUsage({ TOKEN_STATS_DB: d1 }, { prompt_tokens: 1 }, H0), /mock D1 write failure/);
  });

  await test('a synchronous D1 prepare failure is converted to a classified promise rejection', async () => {
    const d1 = {
      prepare() {
        throw new Error('mock synchronous prepare failure');
      },
    };
    let failure;
    try {
      await persistTokenUsage({ TOKEN_STATS_DB: d1 }, { prompt_tokens: 1 }, H0, 'test-model');
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.scope, 'global');
    assert.match(failure?.message || '', /mock synchronous prepare failure/);
  });

  await test('a D1 read failure makes queryTokenSummary return error object, never throw', async () => {
    const d1 = createMockD1({ failReads: true });
    const s = await queryTokenSummary({ TOKEN_STATS_DB: d1 }, H0);
    assert.ok(s && s.available === false, 'returns error object on failure');
    assert.ok(s.error, 'error message present');
  });

  // ---- queryTokenModelUsage: per-model 7-day rollup for the homepage panel ----

  await test('queryTokenModelUsage fails open on missing binding', async () => {
    const r = await queryTokenModelUsage({}, 7, H0);
    assert.ok(r && r.available === false, 'returns error object on missing binding');
    assert.ok(r.error, 'error message present');
  });

  await test('queryTokenModelUsage aggregates per model and orders by total desc', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    // two writes for ultra (same hour), one for code-max, one for air (missing only)
    await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 20 }, H0, 'ultra');
    await persistTokenUsage(env, { prompt_tokens: 5, completion_tokens: 5 }, H0, 'ultra');
    await persistTokenUsage(env, { prompt_tokens: 100, completion_tokens: 0 }, H0, 'code-max');
    await persistTokenUsage(env, null, H0, 'air');
    const r = await queryTokenModelUsage(env, 7, H0 + HOUR);
    assert.equal(r.available, true);
    assert.equal(r.rows.length, 3, 'three distinct models');
    // code-max (100) > ultra (40) > air (0) — sorted desc
    assert.equal(r.rows[0].model, 'code-max');
    assert.equal(r.rows[0].total, 100);
    assert.equal(r.rows[0].requests, 1);
    assert.equal(r.rows[1].model, 'ultra');
    assert.equal(r.rows[1].total, 40);
    assert.equal(r.rows[1].requests, 2);
    assert.equal(r.rows[2].model, 'air');
    assert.equal(r.rows[2].total, 0);
    assert.equal(r.rows[2].requests, 1);
  });

  await test('queryTokenModelUsage excludes rows outside the requested window', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 0 }, H0, 'ultra');
    await persistTokenUsage(env, { prompt_tokens: 999, completion_tokens: 0 }, H0 - 8 * DAY, 'old-model');
    const r = await queryTokenModelUsage(env, 7, H0 + HOUR);
    assert.equal(r.rows.length, 1, 'only in-window model');
    assert.equal(r.rows[0].model, 'ultra');
  });

  await test('persistTokenUsage without model skips the per-model table write', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    await persistTokenUsage(env, { prompt_tokens: 1, completion_tokens: 1 }, H0);
    assert.equal(d1._modelRows.size, 0, 'no per-model rows when model is omitted');
    assert.equal(d1._rows.size, 1, 'global aggregate still written');
  });

  await test('per-model write failure is classified once and does not roll back global write', async () => {
    const d1 = createMockD1();
    const origPrepare = d1.prepare.bind(d1);
    d1.prepare = (sql) => {
      const stmt = origPrepare(sql);
      const origRun = stmt.run.bind(stmt);
      stmt.run = async (...args) => {
        if (/token_usage_model_hourly/i.test(sql)) throw new Error('mock per-model write failure');
        return origRun(...args);
      };
      return stmt;
    };
    let failure;
    try {
      await persistTokenUsage({ TOKEN_STATS_DB: d1 }, { prompt_tokens: 10, completion_tokens: 20 }, H0, 'test-model');
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.scope, 'per-model');
    assert.equal(failure?.model, 'test-model');
    assert.match(failure?.message || '', /mock per-model write failure/);
    assert.equal(d1._rows.size, 1, 'global aggregate still written despite per-model failure');
    assert.equal(d1._modelRows.size, 0, 'no per-model rows due to write failure');
  });

  await test('global write failure is the single classified rejection when both writes fail', async () => {
    const d1 = createMockD1({ failWrites: true });
    const env = { TOKEN_STATS_DB: d1 };
    // Global write fails -> promise rejects (caller catches and logs)
    await assert.rejects(persistTokenUsage(env, { prompt_tokens: 1 }, H0, 'test-model'), /mock D1 write failure/);
    // Since global write failed, no rows should be written
    assert.equal(d1._rows.size, 0, 'no global rows when write fails');
    assert.equal(d1._modelRows.size, 0, 'no model rows when global write fails');
  });

  await test('cleanupModelStats deletes only per-model rows older than seven days', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    await persistTokenUsage(env, { prompt_tokens: 5 }, H0 - 8 * DAY, 'old-model');
    await persistTokenUsage(env, { prompt_tokens: 7 }, H0 - 6 * DAY, 'current-model');
    const originalNow = Date.now;
    Date.now = () => H0;
    try {
      const result = await cleanupModelStats(env);
      assert.equal(result.deleted, 1);
    } finally {
      Date.now = originalNow;
    }
    assert.equal(d1._modelRows.size, 1, 'only the retained model row remains');
    // Global hourly is now pruned by the unified cleanup (7-day retention).
    // This test only calls cleanupModelStats (legacy per-model cleanup), so
    // global rows remain. The unified cleanupUsageRetention would prune them.
    assert.equal(d1._rows.size, 2, 'global hourly unchanged by legacy cleanup');
  });

  await test('cleanupModelStats skips cleanly without a D1 binding', async () => {
    assert.deepEqual(await cleanupModelStats({}), {
      skipped: true,
      reason: 'TOKEN_STATS_DB binding missing',
    });
  });

  if (!process.exitCode) console.log(`\ntoken-usage-store tests passed (${passed}).`);
  else suiteExit(1);
  console.log('ok - file:token-usage-store');
} catch (error) {
  console.error('not ok - token-usage-store-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// upstream-attempt-usage-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs








  function fakeD1() {
    const writes = [];
    return {
      writes,
      prepare(sql) {
        return {
          bind(...params) {
            return {
              run() {
                writes.push({ sql, params });
                return Promise.resolve({ success: true });
              },
            };
          },
        };
      },
    };
  }

  function sseResponse(parts) {
    const enc = new TextEncoder();
    let i = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (i >= parts.length) return controller.close();
          const part = parts[i++];
          if (part instanceof Error) return controller.error(part);
          controller.enqueue(enc.encode(part));
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }

  async function drain(response) {
    if (!response.body) return;
    const reader = response.body.getReader();
    while (!(await reader.read()).done) {}
  }

  const tests = [];
  const test = (name, fn) => tests.push([name, fn]);

  test('successful delivery updates delivered and upstream views in the same write set', async () => {
    const d1 = fakeD1();
    await persistTokenUsage({ TOKEN_STATS_DB: d1 }, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }, Date.UTC(2026, 8, 15, 12), null);
    assert.equal(d1.writes.length, 2, 'success path must not double D1 write count');
    const global = d1.writes.find((w) => w.sql.includes('token_usage_hourly'));
    assert.ok(global);
    // Legacy prefix: hour + 8 delivered fields. Upstream 8 fields are appended.
    assert.deepEqual(global.params.slice(1, 9), [11, 7, 0, 0, 18, 1, 1, 0]);
    assert.deepEqual(global.params.slice(9, 17), [11, 7, 0, 0, 18, 1, 1, 0]);
  });

  test('failed physical attempt updates only upstream columns and never estimates missing tokens', async () => {
    const d1 = fakeD1();
    await persistUpstreamAttemptUsage({ TOKEN_STATS_DB: d1 }, null, Date.UTC(2026, 8, 15, 12), null);
    assert.equal(d1.writes.length, 2);
    const global = d1.writes.find((w) => w.sql.includes('token_usage_hourly'));
    assert.ok(global);
    assert.ok(!/\brequests\b/.test(global.sql), 'upstream-only write must not touch delivered requests');
    assert.deepEqual(global.params.slice(1), [0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0]);
  });

  test('reported usage extraction accepts only native usage locations', () => {
    assert.deepEqual(reportedUsageFromPayload({ usage: { input_tokens: 3 } }), { input_tokens: 3 });
    assert.deepEqual(reportedUsageFromPayload({ message: { usage: { input_tokens: 4 } } }), { input_tokens: 4 });
    assert.deepEqual(reportedUsageFromPayload({ response: { usage: { input_tokens: 5 } } }), { input_tokens: 5 });
    assert.equal(reportedUsageFromPayload({ estimated_usage: { input_tokens: 999 } }), null);
  });

  test('one physical attempt is settled exactly once even when multiple paths try to finalize it', async () => {
    const d1 = fakeD1();
    const waits = [];
    const c = {
      env: { TOKEN_STATS_DB: d1 },
      ctx: {
        waitUntil(p) {
          waits.push(Promise.resolve(p));
        },
      },
      logger: { info() {}, debug() {}, error() {} },
      requestedModel: 'Code-Max',
      reqDescriptor: { model: 'Code-Max' },
      state: { requestedModel: 'Code-Max' },
    };
    const node = { id: 'n1', provider: 'mock', tier: 'tier-1', models: { 'Code-Max': 'up-max' } };
    observeUpstreamAttemptUsage(c, { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 });
    recordUndeliveredUpstreamAttempt(c, node);
    recordUndeliveredUpstreamAttempt(c, node, { prompt_tokens: 90, completion_tokens: 10, total_tokens: 100 });
    recordTokens(c, node, { prompt_tokens: 90, completion_tokens: 10, total_tokens: 100 });
    await Promise.all(waits);
    assert.equal(d1.writes.length, 3, 'one upstream-only global/totals/model write set, not repeated settlements');
    const global = d1.writes.find((w) => w.sql.includes('token_usage_hourly'));
    assert.deepEqual(global.params.slice(1), [9, 1, 0, 0, 10, 1, 1, 0, 9, 0, 0, 0]);
  });

  test('successful settlement preserves a provider report observed before the terminal callback', async () => {
    const d1 = fakeD1();
    const waits = [];
    const c = {
      env: { TOKEN_STATS_DB: d1 },
      ctx: {
        waitUntil(p) {
          waits.push(Promise.resolve(p));
        },
      },
      logger: { info() {}, debug() {}, error() {} },
      requestedModel: 'Code-Max',
      reqDescriptor: { model: 'Code-Max' },
      state: { requestedModel: 'Code-Max' },
    };
    const node = { id: 'n2', provider: 'mock', tier: 'tier-1', models: { 'Code-Max': 'up-max' } };
    observeUpstreamAttemptUsage(c, { input_tokens: 12, output_tokens: 3 });
    recordTokens(c, node, null);
    await Promise.all(waits);
    const global = d1.writes.find((w) => w.sql.includes('token_usage_hourly'));
    assert.deepEqual(global.params.slice(1, 9), [12, 3, 0, 0, 15, 1, 1, 0]);
    assert.deepEqual(global.params.slice(9, 17), [12, 3, 0, 0, 15, 1, 1, 0]);
  });

  test('Anthropic to OpenAI stream keeps raw provider usage including cache fields', async () => {
    const d1 = fakeD1();
    const waits = [];
    const c = {
      env: { TOKEN_STATS_DB: d1 },
      ctx: {
        waitUntil(p) {
          waits.push(Promise.resolve(p));
        },
      },
      logger: { info() {}, debug() {}, error() {} },
      requestedModel: 'Code-Max',
      reqDescriptor: { model: 'Code-Max' },
      state: { requestedModel: 'Code-Max' },
    };
    const node = { id: 'n3', provider: 'mock', tier: 'tier-1', models: { 'Code-Max': 'up-max' } };
    const source = sseResponse([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"up-max","usage":{"input_tokens":5,"cache_creation_input_tokens":7,"cache_read_input_tokens":11,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    const converted = createOpenAIChatStreamFromAnthropic(source.body, {
      model: 'Code-Max',
      onUpstreamUsage: (usage) => observeUpstreamAttemptUsage(c, usage),
    });
    await drain(new Response(converted));
    recordTokens(c, node, null);
    await Promise.all(waits);

    const global = d1.writes.find((w) => w.sql.includes('token_usage_hourly'));
    assert.ok(global);
    assert.deepEqual(global.params.slice(1, 9), [5, 3, 7, 11, 26, 1, 1, 0]);
    assert.deepEqual(global.params.slice(9, 17), [5, 3, 7, 11, 26, 1, 1, 0]);
  });

  test('interrupted stream exposes reported usage to physical-attempt accounting but not delivered onUsage', async () => {
    const attempts = [];
    const delivered = [];
    const tracked = trackStreamResponse(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n',
        new Error('truncated'),
      ]),
      {
        idleTimeoutMs: 1000,
        completionMarker: /data:\s*\[DONE\]/,
        onSuccess() {},
        onFailure() {},
        onNeutral() {},
        onUsage: (u) => delivered.push(u),
        onAttemptUsage: (u, outcome) => attempts.push({ u, outcome }),
      },
    );
    await drain(tracked);
    assert.equal(delivered.length, 0, 'interrupted stream must not become delivered-success evidence');
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].outcome, 'failure');
    assert.deepEqual(attempts[0].u, { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
  });

  test('clean EOF without completion marker is a failed physical attempt, not a delivered success', async () => {
    const attempts = [];
    const delivered = [];
    let failures = 0;
    const tracked = trackStreamResponse(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":8,"completion_tokens":3,"total_tokens":11}}\n\n',
      ]),
      {
        idleTimeoutMs: 1000,
        completionMarker: /data:\s*\[DONE\]/,
        onSuccess() {
          throw new Error('truncated stream must not be successful');
        },
        onFailure() {
          failures++;
        },
        onNeutral() {},
        onUsage: (u) => delivered.push(u),
        onAttemptUsage: (u, outcome) => attempts.push({ u, outcome }),
      },
    );
    await drain(tracked);
    assert.equal(failures, 1);
    assert.equal(delivered.length, 0);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].outcome, 'failure');
    assert.deepEqual(attempts[0].u, { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 });
  });

  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL - ${name}`);
      console.error(error);
    }
  }
  if (failed) {
    console.error(`upstream-attempt-usage: ${failed}/${tests.length} failed`);
    suiteExit(1);
  }
  console.log(`upstream-attempt-usage tests passed (${tests.length}).`);
  console.log('ok - file:upstream-attempt-usage');
} catch (error) {
  console.error('not ok - upstream-attempt-usage-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// daily-token-overlay-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs
  //
  // Regression contract for the dashboard daily token series. Recent complete
  // UTC+8 calendar days must be rebuilt from retained hourly rows so a stale
  // daily cron snapshot cannot make yesterday's usage drop after midnight.





  let passed = 0;
  async function test(name, fn) {
    try {
      await fn();
      passed++;
      console.log(`ok - ${name}`);
    } catch (error) {
      console.error(`FAIL: ${name}`);
      console.error(error?.stack || error);
      process.exitCode = 1;
    }
  }

  const _HOUR = 3_600_000;

  await test('recent seven full UTC+8 days override stale daily snapshots', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };

    // 2026-09-11 09:30 UTC+8. The hourly truth window is therefore
    // 2026-09-05 .. 2026-09-11 inclusive. 2026-09-04 must stay on daily.
    const now = Date.UTC(2026, 8, 11, 1, 30, 0);

    // Simulate the 09-10 daily snapshot having been materialized at 11:00,
    // before the rest of that day's traffic arrived.
    d1._dailyRows.set('2026-09-10', {
      input: 30,
      output: 0,
      total: 30,
      requests: 1,
      reports: 1,
      missing: 0,
    });
    // Older stable history must not be overwritten by a potentially partial
    // seventh-previous calendar day from rolling hourly retention.
    d1._dailyRows.set('2026-09-04', {
      input: 500,
      output: 0,
      total: 500,
      requests: 5,
      reports: 5,
      missing: 0,
    });

    // 09-10 UTC+8: 01:00, 12:00, 22:00 => full-day total 120.
    await persistTokenUsage(env, { prompt_tokens: 30, completion_tokens: 0 }, Date.UTC(2026, 8, 9, 17, 0, 0));
    await persistTokenUsage(env, { prompt_tokens: 40, completion_tokens: 0 }, Date.UTC(2026, 8, 10, 4, 0, 0));
    await persistTokenUsage(env, { prompt_tokens: 50, completion_tokens: 0 }, Date.UTC(2026, 8, 10, 14, 0, 0));

    // A 09-04 hourly row is deliberately present in the mock. It must not
    // replace the stable daily row because 09-04 is outside the seven FULL
    // calendar-day overlay window at this `now`.
    await persistTokenUsage(env, { prompt_tokens: 50, completion_tokens: 0 }, Date.UTC(2026, 8, 4, 4, 0, 0));

    const series = await queryTokenDailySeries(env, '2026-09-04', now);

    assert.equal(series.get('2026-09-10').total, 120, 'yesterday is rebuilt from all retained hourly rows');
    assert.equal(series.get('2026-09-10').requests, 3);
    assert.equal(series.get('2026-09-04').total, 500, 'older stable daily history is preserved');
  });

  await test('today is also rebuilt from hourly when a stale daily row exists', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    const now = Date.UTC(2026, 8, 11, 1, 30, 0); // 09:30 UTC+8

    d1._dailyRows.set('2026-09-11', {
      input: 1,
      output: 0,
      total: 1,
      requests: 1,
      reports: 1,
      missing: 0,
    });
    await persistTokenUsage(env, { prompt_tokens: 20, completion_tokens: 0 }, Date.UTC(2026, 8, 11, 0, 0, 0));

    const series = await queryTokenDailySeries(env, '2026-09-11', now);
    assert.equal(series.get('2026-09-11').total, 20);
    assert.equal(series.get('2026-09-11').requests, 1);
  });

  await test('hourly remains the fallback when materialized daily history is absent', async () => {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    const now = Date.UTC(2026, 8, 11, 1, 30, 0);
    const hour = Date.UTC(2026, 8, 10, 4, 0, 0); // 09-10 12:00 UTC+8

    await persistTokenUsage(env, { prompt_tokens: 12, completion_tokens: 0 }, hour);
    const series = await queryTokenDailySeries(env, '2026-09-01', now);

    assert.equal(series.get('2026-09-10').total, 12);
    assert.equal(series.get('2026-09-10').requests, 1);
  });

  if (!process.exitCode) console.log(`daily-token-overlay tests passed (${passed}).`);
  else suiteExit(1);
  console.log('ok - file:daily-token-overlay');
} catch (error) {
  console.error('not ok - daily-token-overlay-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// ttft-query-contract-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs
  //
  // TTFT Query Contract.
  //
  // Design facts pinned here: the dashboard's TTFT coverage must not depend on
  // the Usage Top-N slice, and must not issue one D1 query per model (N+1). A
  // single grouped query (GROUP BY model) returns histogram aggregates for all
  // models in the window; percentiles are computed in memory with bucket-upper-
  // bound precision. A previous regression only gave TTFT to the Usage Top 4
  // models via per-model queries.
  //
  //   C01  Every public model gets a TTFT result container (missing rows ->
  //        insufficient/noSamples), never a missing key.
  //   C02  Query count is fixed: 1 grouped TTFT query regardless of model count.
  //   C03  Model keys are canonical (trim + lowercase): Code-Max / code-max /
  //        CODE-MAX aggregate into one stats dimension.
  //   C04  Below the minimum sample threshold: p50 = null, p95 = null,
  //        insufficient = true.
  //   C05  Percentiles are bucket UPPER BOUNDS (no fabricated precision).





  const HOUR = 3_600_000;
  const WEEK_MS = 7 * 24 * 3600_000;
  const now = () => 1_700_000_000_000;
  const h0 = Math.floor((now() - 30 * 60_000) / HOUR) * HOUR; // 30 min ago, in any window
  const P50_MIN = 5;
  const P95_MIN = 20;

  let failures = 0;
  function check(name, ok, detail) {
    if (ok) console.log(`  ok  ${name}`);
    else {
      failures++;
      console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
  }

  // ---- C01: container for every public model ------------------------------------
  {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'air', 400);
    const res = await queryAllModelsTtftPercentiles(env, WEEK_MS, now());
    const publicModels = [
      { id: 'air' },
      { id: 'code-max' },
      { id: 'ultra' },
      { id: 'pro' },
      { id: 'agent' },
      { id: 'max' },
      { id: 'flash' },
      { id: 'vision' },
    ];
    const ttft = ensureModelTtftContainers(res.ttft, publicModels);
    const allPresent = publicModels.every((m) => {
      const e = ttft.get(normalizeModelKey(m.id));
      return e && e.available === true && typeof e.sampleCount === 'number';
    });
    check('C01 all 8 public models have a TTFT container (missing rows -> insufficient)', allPresent, `keys=${JSON.stringify([...ttft.keys()])}`);

    const emptyEntry = fmtModelTtft(ttft.get('vision'));
    check(
      'C01b no-data container renders insufficient/noSamples (-- not --s)',
      emptyEntry.p50Insufficient === true &&
        emptyEntry.p95Insufficient === true &&
        emptyEntry.noSamples === true &&
        emptyEntry.p50 === '--' &&
        emptyEntry.p95 === '--',
    );
  }

  // ---- C02: fixed query count ----------------------------------------------------
  {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    for (let i = 0; i < 20; i++) {
      await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h0, `model-${i}`, 400);
    }
    const before = d1._reads.length;
    await queryAllModelsTtftPercentiles(env, WEEK_MS, now());
    const reads = d1._reads.length - before;
    check('C02 one grouped TTFT query for 20 models (no N+1)', reads === 1, `reads=${reads}`);

    const d1b = createMockD1();
    const envB = { TOKEN_STATS_DB: d1b };
    for (let i = 0; i < 4; i++) {
      await persistTokenUsage(envB, { prompt_tokens: 10, completion_tokens: 5 }, h0, `model-${i}`, 400);
    }
    const beforeB = d1b._reads.length;
    await queryAllModelsTtftPercentiles(envB, WEEK_MS, now());
    check('C02b query count does not scale with model count (4 models -> 1)', d1b._reads.length - beforeB === 1);
  }

  // ---- C03: canonical model key --------------------------------------------------
  {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'Code-Max', 400);
    await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'CODE-MAX', 600);
    const res = await queryAllModelsTtftPercentiles(env, WEEK_MS, now());
    check(
      'C03 case variants aggregate into one canonical key',
      res.ttft.size === 1 && res.ttft.has('code-max') && res.ttft.get('code-max').sampleCount === 2,
      `keys=${JSON.stringify([...res.ttft.keys()])}`,
    );
  }

  // ---- C04: insufficient samples (separate P50/P95 thresholds) ------------------
  {
    // Below P50 threshold (4 samples): p50=null, p95=null, both insufficient.
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    for (let i = 0; i < P50_MIN - 1; i++) {
      await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'rare-model', 400);
    }
    const res = await queryAllModelsTtftPercentiles(env, WEEK_MS, now());
    const e = res.ttft.get('rare-model');
    check(
      'C04 below P50 threshold (4): p50/p95 null, both insufficient',
      e && e.p50 === null && e.p95 === null && e.p50Insufficient === true && e.p95Insufficient === true && e.sampleCount === P50_MIN - 1,
      `entry=${JSON.stringify(e)}`,
    );

    // At P50 threshold (5), below P95 threshold (20): p50 present, p95 null.
    const d1b = createMockD1();
    const envB = { TOKEN_STATS_DB: d1b };
    for (let i = 0; i < P50_MIN; i++) {
      await persistTokenUsage(envB, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'healthy-model', 400);
    }
    const resB = await queryAllModelsTtftPercentiles(envB, WEEK_MS, now());
    const eB = resB.ttft.get('healthy-model');
    check(
      'C04b at P50 threshold (5), below P95 (20): p50 present, p95 null',
      eB && eB.p50 !== null && eB.p95 === null && eB.p50Insufficient === false && eB.p95Insufficient === true && eB.sampleCount === P50_MIN,
      `entry=${JSON.stringify(eB)}`,
    );

    // At both thresholds (20): p50 present, p95 present.
    const d1c = createMockD1();
    const envC = { TOKEN_STATS_DB: d1c };
    for (let i = 0; i < P95_MIN; i++) {
      await persistTokenUsage(envC, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'full-model', 400);
    }
    const resC = await queryAllModelsTtftPercentiles(envC, WEEK_MS, now());
    const eC = resC.ttft.get('full-model');
    check(
      'C04c at P95 threshold (20): both percentiles present, neither insufficient',
      eC && eC.p50 !== null && eC.p95 !== null && eC.p50Insufficient === false && eC.p95Insufficient === false && eC.sampleCount === P95_MIN,
      `entry=${JSON.stringify(eC)}`,
    );
  }

  // ---- C05: bucket upper bound precision ------------------------------------------
  {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    // All P95_MIN (20) samples inside bucket 1 (100..500ms): p50 and p95 must be
    // the bucket upper bound TTFT_BUCKET_BOUNDARIES_MS[1] = 500 (needs P95_MIN
    // for p95 to be present).
    for (let i = 0; i < P95_MIN; i++) {
      await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'bucketed', 100 + i * 20);
    }
    const res = await queryAllModelsTtftPercentiles(env, WEEK_MS, now());
    const e = res.ttft.get('bucketed');
    check(
      'C05 p50/p95 are bucket upper bounds',
      e && e.p50 === TTFT_BUCKET_BOUNDARIES_MS[1] && e.p95 === TTFT_BUCKET_BOUNDARIES_MS[1],
      `p50=${e?.p50} p95=${e?.p95} boundaries=${JSON.stringify(TTFT_BUCKET_BOUNDARIES_MS)}`,
    );

    // Mixed buckets: 12 samples in bucket 0 (<100ms), 8 in bucket 4 (2000..5000ms).
    // p50 (ceil(20*0.5)=10th sample) lands in bucket 0 -> upper bound 100ms;
    // p95 (ceil(20*0.95)=19th sample) lands in bucket 4 -> upper bound 5000ms.
    const d1b = createMockD1();
    const envB = { TOKEN_STATS_DB: d1b };
    for (let i = 0; i < 12; i++) {
      await persistTokenUsage(envB, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'mixed', 50);
    }
    for (let i = 0; i < 8; i++) {
      await persistTokenUsage(envB, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'mixed', 3000);
    }
    const resB = await queryAllModelsTtftPercentiles(envB, WEEK_MS, now());
    const eB = resB.ttft.get('mixed');
    check(
      'C05b percentile lands in the bucket containing the threshold sample',
      eB && eB.p50 === TTFT_BUCKET_BOUNDARIES_MS[0] && eB.p95 === TTFT_BUCKET_BOUNDARIES_MS[4],
      `p50=${eB?.p50} p95=${eB?.p95}`,
    );
  }

  // ---- C06: last-bucket (≥10s) displays as ≥10s, not --s ------------------------
  {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    // P95_MIN samples all ≥10s (bucket 6, upper bound = Infinity).
    for (let i = 0; i < P95_MIN; i++) {
      await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'slow-model', 12000);
    }
    const res = await queryAllModelsTtftPercentiles(env, WEEK_MS, now());
    const e = res.ttft.get('slow-model');
    check('C06 last-bucket percentile is Infinity', e && e.p50 === Infinity && e.p95 === Infinity, `p50=${e?.p50} p95=${e?.p95}`);
    const fmt = fmtModelTtft(e);
    check('C06 last-bucket renders as ≥10s (not --s)', fmt.p50 === '≥10s' && fmt.p95 === '≥10s', `p50=${fmt.p50} p95=${fmt.p95}`);
  }

  // ---- Fail-open -------------------------------------------------------------------
  {
    const res = await queryAllModelsTtftPercentiles({}, WEEK_MS, now());
    check('fail-open: missing binding -> available:false, no throw', res.available === false && typeof res.error === 'string');
  }

  if (failures > 0) {
    console.error(`ttft-query-contract: ${failures} contract(s) FAILED`);
    suiteExit(1);
  }
  console.log('ttft-query-contract: all contracts passed');
  console.log('ok - file:ttft-query-contract');
} catch (error) {
  console.error('not ok - ttft-query-contract-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// model-stats-canonicalization-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs
  //
  // Observability Canonicalization Contract — historical case variants.
  //
  // The writer (persistTokenUsage) canonicalizes every new model key
  // (trim + lowercase), so tests that only go through the writer can never
  // observe the historical-data problem: real D1 still contains rows written
  // before canonicalization (Code-Max / CODE-MAX / padded strings). This
  // contract seeds RAW case-variant rows directly into the simulated table
  // (bypassing the writer) and pins the reader-side merge semantics:
  //
  //   C01  Token Usage: variants merge into ONE canonical row (summed
  //        total / requests), never split dimensions.
  //   C02  TTFT: variant histograms merge BEFORE percentile computation —
  //        no Map overwrite, sampleCount is the true sum, p50/p95 come from
  //        the merged buckets.
  //   C03  Recent Evidence: only the canonical key is returned.
  //   C04  Usage Coverage: requests / reports / missing merge; coverage is
  //        computed from the merged numbers.
  //   C05  Writer/reader double insurance: writer canonical output is
  //        unaffected (persist + read still yields the canonical key).
  //
  // The 24h evidence window and the TTFT precision contracts live in their
  // own suites (model-status-window-contract-test / ttft-query-contract-test).




  const HOUR = 3_600_000;
  const WEEK_MS = 7 * 24 * 3600_000;
  const now = () => 1_700_000_000_000;
  const h0 = Math.floor((now() - 30 * 60_000) / HOUR) * HOUR; // 30 min ago

  let failures = 0;
  function check(name, ok, detail) {
    if (ok) console.log(`  ok  ${name}`);
    else {
      failures++;
      console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
  }

  // ---- C01: Token Usage merges historical case variants -------------------------
  {
    const d1 = createMockD1();
    // Historical rows exactly as they might exist in D1 today: pre-canonical
    // writes with mixed case (and one padded with spaces — TRIM handles it).
    d1.seedModelRow(h0, 'Code-Max', { total: 100, requests: 2 });
    d1.seedModelRow(h0 - HOUR, 'code-max', { total: 50, requests: 1 });
    d1.seedModelRow(h0 - 2 * HOUR, 'CODE-MAX', { total: 25, requests: 1 });
    d1.seedModelRow(h0 - 3 * HOUR, ' Code-Max ', { total: 10, requests: 1 });
    const env = { TOKEN_STATS_DB: d1 };
    const res = await queryTokenModelUsage(env, 7, now());
    check(
      'C01 variants produce exactly ONE canonical stats dimension',
      res.available === true && res.rows.length === 1 && res.rows[0].model === 'code-max',
      `rows=${JSON.stringify(res.rows)}`,
    );
    check(
      'C01 totals and requests are the true sums across variants',
      res.rows.length === 1 && res.rows[0].total === 185 && res.rows[0].requests === 5,
      `rows=${JSON.stringify(res.rows)}`,
    );
  }

  // ---- C02: TTFT histograms merge before percentiles (no Map overwrite) ---------
  {
    const d1 = createMockD1();
    // Three case variants plus a second-hour row of one variant. With the
    // legacy GROUP BY model + JS map.set() the `code-max` entry would be
    // overwritten by whichever raw variant came last; correct behavior merges
    // all four rows: count = 3+3+5+9 = 20 (≥ P95_MIN for both percentiles),
    // buckets b0=3, b1=3, b2=5, b4=9.
    d1.seedModelRow(h0, 'Code-Max', { successful_ttft_count: 3, ttft_b0: 3 });
    d1.seedModelRow(h0, 'code-max', { successful_ttft_count: 3, ttft_b1: 3 });
    d1.seedModelRow(h0 - HOUR, 'CODE-MAX', { successful_ttft_count: 5, ttft_b2: 5 });
    d1.seedModelRow(h0 - HOUR, 'code-max', { successful_ttft_count: 9, ttft_b4: 9 });
    const env = { TOKEN_STATS_DB: d1 };
    const res = await queryAllModelsTtftPercentiles(env, WEEK_MS, now());
    const entry = res.ttft.get('code-max');
    check(
      'C02 variants merge into one TTFT entry with the true sample count',
      res.available === true && res.ttft.size === 1 && entry && entry.sampleCount === 20,
      `keys=${JSON.stringify([...res.ttft.keys()])} entry=${JSON.stringify(entry)}`,
    );
    // p50: ceil(20*0.5)=10th sample -> cumulative b0=3, b1=6, b2=11 -> bucket 2 (1000ms).
    // p95: ceil(20*0.95)=19th sample -> cumulative b3=11, b4=20 -> bucket 4 (5000ms).
    check(
      'C02 percentiles are computed from the MERGED histogram (not the last variant)',
      entry && entry.p50Insufficient === false && entry.p95Insufficient === false && entry.p50 === 1000 && entry.p95 === 5000,
      `p50=${entry?.p50} p95=${entry?.p95}`,
    );
  }

  // ---- C03: Recent Evidence returns only the canonical key ----------------------
  {
    const d1 = createMockD1();
    d1.seedModelRow(h0, 'Code-Max', { requests: 2 });
    d1.seedModelRow(h0 - HOUR, 'CODE-MAX', { requests: 1 });
    d1.seedModelRow(h0 - 2 * HOUR, 'other-model', { requests: 1 });
    const env = { TOKEN_STATS_DB: d1 };
    const evidence = await queryRecentModelEvidence(env, undefined, now());
    check(
      'C03 evidence contains only canonical keys',
      evidence.size === 2 && evidence.has('code-max') && evidence.has('other-model'),
      `evidence=${JSON.stringify([...evidence])}`,
    );
  }

  // ---- C04: Usage Coverage merges requests / reports / missing ------------------
  {
    const d1 = createMockD1();
    d1.seedModelRow(h0, 'Code-Max', { requests: 3, reports: 2, missing: 1 });
    d1.seedModelRow(h0 - HOUR, 'code-max', { requests: 2, reports: 1, missing: 1 });
    d1.seedModelRow(h0 - 2 * HOUR, 'CODE-MAX', { requests: 0, reports: 0, missing: 0 });
    const env = { TOKEN_STATS_DB: d1 };
    const res = await queryModelUsageCoverage(env, 7, now());
    const row = res.rows.find((r) => r.model === 'code-max');
    check(
      'C04 coverage variants merge into one row with summed counts',
      res.rows.length === 1 && row && row.requests === 5 && row.reports === 3 && row.missing === 2,
      `rows=${JSON.stringify(res.rows)}`,
    );
    check(
      'C04 coverage ratio is computed from the merged numbers',
      row && row.usageCoverage !== null && Math.abs(row.usageCoverage - 0.6) < 1e-9,
      `usageCoverage=${row?.usageCoverage}`,
    );
  }

  // ---- C05: writer canonical output keeps working (double insurance) ------------
  {
    const d1 = createMockD1();
    const env = { TOKEN_STATS_DB: d1 };
    await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'Code-Max', 400);
    await persistTokenUsage(env, { prompt_tokens: 1, completion_tokens: 1 }, h0, 'CODE-MAX', 400);
    const [usage, evidence] = await Promise.all([queryTokenModelUsage(env, 7, now()), queryRecentModelEvidence(env, undefined, now())]);
    check(
      'C05 writer-canonicalized rows read back as one canonical dimension',
      usage.rows.length === 1 &&
        usage.rows[0].model === 'code-max' &&
        usage.rows[0].total === 17 &&
        usage.rows[0].requests === 2 &&
        evidence.has('code-max'),
      `rows=${JSON.stringify(usage.rows)} evidence=${JSON.stringify([...evidence])}`,
    );
  }

  if (failures > 0) {
    console.error(`model-stats-canonicalization: ${failures} contract(s) FAILED`);
    suiteExit(1);
  }
  console.log('model-stats-canonicalization: all contracts passed');
  console.log('ok - file:model-stats-canonicalization');
} catch (error) {
  console.error('not ok - model-stats-canonicalization-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}
