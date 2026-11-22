/** Trusted, short Delta performance smoke. Workloads use synthetic data only. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const load = relative => import(pathToFileURL(resolve(relative)).href)
const samples = []
const sample = (name, begun, counters) => {
  const elapsedMs = Math.round((performance.now() - begun) * 100) / 100
  assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 0, name + ': invalid elapsed time')
  samples.push({ name, elapsedMs, ...counters })
}
const memory = () => process.memoryUsage().heapUsed
const MIB = 1024 * 1024

// Real bounded-output helper for long command/tool output; this is not a full
// model compaction or terminal GUI benchmark.
const { TextRetainer, ItemRetainer } = await load('packages/util/output-retention/lib/index.js')
{
  const beforeHeap = memory()
  const begun = performance.now()
  const retainer = new TextRetainer({ kind: 'headTail', headBytes: 64 * 1024, tailBytes: 64 * 1024 })
  const chunk = 'x'.repeat(1024)
  for (let i = 0; i < 8 * 1024; i += 1) retainer.push(chunk)
  const result = retainer.finish()
  assert.equal(Buffer.byteLength(result.text), 128 * 1024)
  assert.equal(result.omittedBytes.kind, 'exact')
  assert.equal(result.omittedBytes.count, 8 * MIB - 128 * 1024)
  sample('tool-output-retention-8MiB', begun, {
    retainedBytes: Buffer.byteLength(result.text),
    heapDeltaBytes: memory() - beforeHeap,
  })
}
// Synthetic Session list metadata bounding: measures the actual collection
// helper, not UI rendering, SQLite or Session file IO.
{
  const begun = performance.now()
  const beforeHeap = memory()
  const retainer = new ItemRetainer({ kind: 'head', maxItems: 80 })
  for (let i = 0; i < 12_000; i += 1) retainer.push({ id: i, title: 'synthetic-' + i })
  const result = retainer.finish()
  assert.equal(result.seen, 12_000)
  assert.equal(result.kept, 80)
  assert.equal(result.omitted.kind, 'exact')
  assert.equal(result.omitted.count, 11_920)
  sample('session-list-metadata-bounding-12000', begun, {
    retainedItems: result.kept,
    heapDeltaBytes: memory() - beforeHeap,
  })
}
// Cold startup measures an actual Delta Code Host module import in an isolated
// child process, not a cached dynamic import in this process.
{
  const source = [
    'import assert from "node:assert/strict"',
    'import { performance } from "node:perf_hooks"',
    'import { pathToFileURL } from "node:url"',
    'import { resolve } from "node:path"',
    'const started = performance.now()',
    'const plugin = await import(pathToFileURL(resolve("packages/plugin/delta-code/lib/index.js")).href)',
    'assert.equal(plugin.name, "@fongap-labs/delta-code")',
    'assert.equal(typeof plugin.apply, "function")',
    'process.stdout.write(JSON.stringify({ importMs: Math.round((performance.now()-started)*100)/100 }))',
  ].join('\n')
  const begun = performance.now()
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 15000, maxBuffer: 8192,
    env: { ...process.env, DELTA_CODE_PERF_SMOKE: '1' },
  })
  assert.equal(child.status, 0, 'Delta Code cold-import smoke failed')
  const report = JSON.parse(child.stdout)
  assert.ok(Number.isFinite(report.importMs) && report.importMs >= 0)
  sample('delta-code-cold-module-load', begun, { importMs: report.importMs })
}
// The new local diagnostics module is optional until Delta's restore PR merges.
// When present, assert its bounded files and metadata-only persistence.
if (existsSync(resolve('apps/desktop/src/local-diagnostics.ts'))) {
  const { LocalDiagnosticJournal } = await load('apps/desktop/src/local-diagnostics.ts')
  const scratch = await mkdtemp(join(tmpdir(), 'delta-private-diagnostics-smoke-'))
  try {
    const journal = new LocalDiagnosticJournal(scratch)
    const begun = performance.now()
    const failure = new Error('synthetic private error detail')
    await Promise.all(Array.from({ length: 1_200 }, () => journal.recordFatal('main', failure)))
    const directory = join(scratch, 'diagnostics')
    const names = (await readdir(directory)).filter(name => name.startsWith('errors.jsonl'))
    assert.ok(names.length >= 1 && names.length <= 3)
    let count = 0
    let totalBytes = 0
    for (const name of names) {
      const file = join(directory, name)
      const size = (await stat(file)).size
      assert.ok(size <= 128 * 1024, 'Local journal exceeded its 128 KiB file cap')
      totalBytes += size
      const content = await readFile(file, 'utf8')
      assert.equal(content.includes('synthetic private error detail'), false)
      for (const line of content.split('\n').filter(Boolean)) {
        const event = JSON.parse(line)
        assert.deepEqual(Object.keys(event).sort(),
          ['errorClass', 'kind', 'source', 'stackFingerprint', 'time'])
        assert.equal(event.kind, 'fatal')
        count++
      }
    }
    assert.ok(count > 0)
    sample('private-diagnostic-journal-bounded', begun, { records: count, retainedBytes: totalBytes })
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
console.log(JSON.stringify({
  suite: 'delta-performance-smoke', version: 1, node: process.version,
  scope: 'measurement-only except integrity and boundedness assertions',
  cases: samples,
}))
