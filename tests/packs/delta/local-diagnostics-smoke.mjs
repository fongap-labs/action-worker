/** Trusted synthetic file-system regression for Delta's private diagnostic journal. */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { LocalDiagnosticJournal } = await import(pathToFileURL(
  resolve('apps/desktop/src/local-diagnostics.ts')).href)
const scratch = await mkdtemp(join(tmpdir(), 'delta-diagnostics-smoke-'))
const marker = 'excluded-payload-marker-123'
const error = new Error('not-for-journal-' + marker)
error.stack = 'Error: ' + marker + '\n at file:///private/' + marker
error.code = 'E_CONTROLLED'
const readLines = async path => (await readFile(path, 'utf8')).trim()
  .split('\n').filter(Boolean).map(line => JSON.parse(line))

try {
  const profileA = join(scratch, 'profile-a')
  const profileB = join(scratch, 'profile-b')
  const journal = new LocalDiagnosticJournal(profileA)
  const current = join(profileA, 'diagnostics', 'errors.jsonl')
  const archive1 = current + '.1'
  const archive2 = current + '.2'

  await journal.recordFatal('main', error)
  let entries = await readLines(current)
  assert.equal(entries.length, 1)
  const entry = entries[0]
  assert.deepEqual(Object.keys(entry).sort(),
    ['time', 'kind', 'source', 'errorClass', 'errorCode', 'stackFingerprint'].sort(),
    'journal must allow only minimal metadata fields')
  assert.equal(entry.kind, 'fatal')
  assert.equal(entry.source, 'main')
  assert.equal(entry.errorCode, 'E_CONTROLLED')
  assert.match(entry.stackFingerprint, /^[a-f0-9]{16}$/)
  assert.doesNotMatch(await readFile(current, 'utf8'), new RegExp(marker),
    'raw exception message, stack or local path leaked into the journal')
  if (process.platform !== 'win32') {
    assert.equal((await stat(current)).mode & 0o077, 0,
      'diagnostic records must not be group/world readable')
  }

  // A new write must expire both archived generations independently.
  await writeFile(archive1, 'expired-one\n')
  await writeFile(archive2, 'expired-two\n')
  const expired = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000)
  await utimes(archive1, expired, expired)
  await utimes(archive2, expired, expired)
  await journal.recordFatal('main', error)
  assert.equal(existsSync(archive1), false, 'first stale archive was retained')
  assert.equal(existsSync(archive2), false, 'second stale archive was retained')

  // Recent archives must survive a write, including across an active-log expiry.
  await writeFile(archive1, 'recent-one\n')
  await writeFile(archive2, 'recent-two\n')
  await journal.recordFatal('main', error)
  assert.equal(existsSync(archive1), true)
  assert.equal(existsSync(archive2), true)
  await utimes(current, expired, expired)
  await journal.recordFatal('main', error)
  assert.equal((await readLines(current)).length, 1,
    'stale active journal was not replaced on the next write')

  // The active file remains bounded and rotates the two latest generations.
  await writeFile(current, 'x'.repeat(128 * 1024 - 8))
  await journal.recordFatal('main', error)
  assert.ok((await stat(current)).size <= 128 * 1024, 'active journal grew past limit')
  assert.equal((await readLines(current)).length, 1)
  assert.ok((await stat(archive1)).size >= 128 * 1024 - 8,
    'oversized active journal was not rotated')
  assert.match(await readFile(archive2, 'utf8'), /recent-one/,
    'rotation failed to preserve the newer archived generation')

  // Separate portable userData roots must never share a diagnostic file.
  const other = new LocalDiagnosticJournal(profileB)
  await other.recordFatal('host', new Error('synthetic second profile'))
  assert.equal((await readLines(join(profileB, 'diagnostics', 'errors.jsonl')))[0].source,
    'host')
  assert.equal((await readLines(current))[0].source, 'main')

  // Storage failures must not affect the caller's crash-recovery path.
  const occupiedPath = join(scratch, 'occupied-file')
  await writeFile(occupiedPath, 'not a directory')
  await new LocalDiagnosticJournal(occupiedPath).recordFatal('main', error)
  console.log('Delta local diagnostics privacy, retention, rotation and isolation smoke passed')
} finally {
  await rm(scratch, { recursive: true, force: true })
}
