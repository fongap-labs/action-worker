import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  eligibleAutoSkillCandidates,
  createAutoSkillStageSpecs,
} from '#target/packages/delta-code/lib/delta-code-repository/github-skill-auto-stage.js'

const SHA = 'a'.repeat(40)
const BLOB = 'b'.repeat(40)
const LICENSE = 'c'.repeat(40)
const candidate = {
  repository: 'example/skill-guides',
  path: 'skills/example-skill/SKILL.md',
  suggestedCommit: SHA,
  sourceBlobSha: BLOB,
  status: 'unreviewed', requiresReview: true,
  freeEvidence: { licenseBlobSha: LICENSE, checkedAtCommit: SHA, license: 'MIT' },
}
const envelope = candidates => ({ candidates, isRateLimited: false })

test('automatic stage candidate extraction rejects forged and stale discovery metadata', () => {
  const valid = eligibleAutoSkillCandidates(envelope([candidate]))
  assert.equal(valid.length, 1)
  assert.deepEqual(valid[0], {
    repository: candidate.repository,
    path: candidate.path,
    suggestedCommit: SHA,
    sourceBlobSha: BLOB,
    freeEvidence: { licenseBlobSha: LICENSE, checkedAtCommit: SHA },
  })
  const forged = [
    { ...candidate, path: '../scripts/unsafe.sh' },
    { ...candidate, repository: 'other/../repo' },
    { ...candidate, suggestedCommit: 'main' },
    { ...candidate, sourceBlobSha: 'nope' },
    { ...candidate, freeEvidence: { ...candidate.freeEvidence, checkedAtCommit: 'd'.repeat(40) } },
    { ...candidate, requiresReview: false },
    { ...candidate, status: 'approved' },
  ]
  for (const invalid of forged) {
    assert.deepEqual(eligibleAutoSkillCandidates(envelope([invalid])), [])
  }
  assert.equal(eligibleAutoSkillCandidates(envelope([candidate, candidate])).length, 1)
  assert.throws(() => eligibleAutoSkillCandidates(null), /not an object/)
  assert.throws(() => eligibleAutoSkillCandidates({ candidates: [] }), /Incomplete/)
  assert.throws(() => eligibleAutoSkillCandidates(envelope(Array.from({length: 7}, () => candidate))), /unbounded/)
  assert.equal(eligibleAutoSkillCandidates(envelope(Array.from({length: 4}, (_x, i) => ({
    ...candidate, path: 'skills/example-' + i + '/SKILL.md'
  })))).length, 3)
})

const shaBlob = value => {
  const bytes = Buffer.from(value)
  return createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex')
}
const skillText = '---\nname: example-skill\ndescription: A small review guide\n---\nReview source code for correctness.\n'
const licenseText = 'SPDX-License-Identifier: MIT\n'
const validSource = shaBlob(skillText)
const validLicense = shaBlob(licenseText)
const TREE = 'e'.repeat(40)
const mkBlob = (content, sha) => ({
  encoding: 'base64', size: Buffer.byteLength(content), sha,
  content: Buffer.from(content).toString('base64'),
})

function fixtures(isPaid = false) {
  const sourceText = isPaid
    ? skillText + 'This skill requires a paid API service for usage.\n'
    : skillText
  const sourceSha = shaBlob(sourceText)
  const repo = 'example/skill-guides'
  const tree = {
    sha: TREE, truncated: false, tree: [
      { path: 'LICENSE', type: 'blob', mode: '100644', sha: validLicense },
      { path: 'skills/example-skill/SKILL.md', type: 'blob', mode: '100644', sha: sourceSha },
    ],
  }
  const lookup = path => {
    if (path.startsWith('/search/repositories?')) return {
      total_count: 1,
      items: [{
        full_name: repo, private: false, archived: false, disabled: false,
        license: { spdx_id: 'MIT' }, default_branch: 'main',
        stargazers_count: 500, forks_count: 20,
        created_at: '2023-01-01T00:00:00Z', pushed_at: '2026-01-01T00:00:00Z',
        description: 'example-skill review guide',
      }],
    }
    if (path === '/repos/example/skill-guides/commits/main' ||
        path === '/repos/example/skill-guides/commits/' + SHA) {
      return { sha: SHA, commit: { tree: { sha: TREE } } }
    }
    if (path === '/repos/example/skill-guides/git/trees/' + TREE + '?recursive=1') return tree
    if (path === '/repos/example/skill-guides/git/blobs/' + validLicense) {
      return mkBlob(licenseText, validLicense)
    }
    if (path === '/repos/example/skill-guides/git/blobs/' + sourceSha) {
      return mkBlob(sourceText, sourceSha)
    }
    if (path === '/users/example') return { login: 'example', created_at: '2022-01-01T00:00:00Z' }
    throw new Error('Unexpected public path: ' + path)
  }
  const publicCalls = []
  const writes = []
  const target = 'fongap-labs/dsh-plugin'
  const branchSha = 'f'.repeat(40)
  const existingSha = '9'.repeat(40)
  const success = obj => ({ repository: target, account: 'fongap-labs', result: JSON.stringify(obj) })
  const actions = {
    file: { execute: async args => {
      assert.equal(args.repository, target)
      assert.equal(args.path, 'CHANGELOG.md')
      return success({ path: 'CHANGELOG.md', sha: existingSha, type: 'file',
        content: '# 更新日志\n\n## [Unreleased]\n\n' })
    } },
    branch: { execute: async args => {
      writes.push(['branch', args.branch])
      return success({ branch: args.branch, sha: branchSha })
    } },
    commitFile: { execute: async args => {
      writes.push(['commit', args.path])
      return success({ path: args.path, commit: writes.length === 2 ? '1'.repeat(40) : '2'.repeat(40) })
    } },
    createPr: { execute: async () => {
      writes.push(['pr'])
      return success({ number: 777, url: 'https://github.com/fongap-labs/dsh-plugin/pull/777', reused: false })
    } },
  }
  const transport = {
    publicRead: async (path, signal) => {
      assert.equal(signal.aborted, false)
      publicCalls.push(path)
      return lookup(path)
    },
    request: async () => { throw new Error('Public Skill search must never use a credential-bearing transport') },
  }
  return { transport, actions, writes, publicCalls }
}

test('automated Skill stage audits free pinned source and creates exactly one inert PR', async () => {
  const state = fixtures()
  const spec = createAutoSkillStageSpecs(state.transport, state.actions, () => true)[0]
  const outcome = await spec.execute({
    query: 'example-skill', targetRepository: 'fongap-labs/dsh-plugin',
  }, { signal: new AbortController().signal, account: 'fongap-labs' })
  const value = JSON.parse(outcome.result)
  assert.equal(value.state, 'pending-ci-review')
  assert.equal(value.staged, true)
  assert.equal(value.reviewed, 1)
  assert.deepEqual(value.proposal.pr, {
    number: 777, url: 'https://github.com/fongap-labs/dsh-plugin/pull/777', reused: false,
  })
  assert.equal(value.proposal.autoEnabled, false)
  assert.deepEqual(state.writes.map(entry => entry[0]), ['branch', 'commit', 'commit', 'pr'])
  assert.ok(state.publicCalls.every(path => path.startsWith('/')))
  assert.equal('approved' in value, false)
})

test('paid candidate is excluded; no PR, token fallback or implicit install', async () => {
  const state = fixtures(true)
  const spec = createAutoSkillStageSpecs(state.transport, state.actions, () => true)[0]
  const outcome = await spec.execute({
    query: 'example-skill', targetRepository: 'fongap-labs/dsh-plugin',
  }, { signal: new AbortController().signal, account: 'fongap-labs' })
  assert.equal(JSON.parse(outcome.result).staged, false)
  assert.deepEqual(state.writes, [])
})

test('disabled writes, explicit opt-out and cancellation stop before network or side effects', async () => {
  const state = fixtures()
  const args = { query: 'example-skill', targetRepository: 'fongap-labs/dsh-plugin' }
  const ctx = { signal: new AbortController().signal, account: 'fongap-labs' }
  await assert.rejects(() => createAutoSkillStageSpecs(state.transport, state.actions, () => false)[0]
    .execute(args, ctx), /GitHub writes are disabled/)
  await assert.rejects(() => createAutoSkillStageSpecs(state.transport, state.actions, () => true)[0]
    .execute({ ...args, query: 'do not use external skills' }, ctx), /disabled/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => createAutoSkillStageSpecs(state.transport, state.actions, () => true)[0]
    .execute(args, { signal: controller.signal, account: 'fongap-labs' }))
  assert.deepEqual(state.writes, [])
  assert.equal(state.publicCalls.length, 0)
})
