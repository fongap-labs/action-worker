import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertMergedSkillProposalEvidence,
  createAutoSkillAdvanceSpecs,
} from '#target/packages/dsh-delta-code/lib/delta-code-repository/github-skill-auto-advance.js'

const repo = 'fongap-labs/dsh-plugin'
const head = 'a'.repeat(40)
const pr = {
  state: 'closed', merged: true, merged_at: '2026-11-20T08:00:00Z',
  head: { sha: head, repo: { full_name: repo } },
  base: { repo: { full_name: repo } },
}
const success = [
  { context: 'PR Governance', state: 'success' },
  { context: 'CI Evidence', state: 'success' },
  { context: 'validate-merge', state: 'success' },
]
const checks = {
  head, statuses: success,
  checks: [{ name: 'Security', status: 'completed', conclusion: 'success' }],
}

test('promotes only a matching merged proposal with all mandatory successful CI contexts', () => {
  assert.doesNotThrow(() => assertMergedSkillProposalEvidence(pr, checks, repo, head))
  assert.throws(() => assertMergedSkillProposalEvidence({ ...pr, merged: false }, checks, repo, head), /not an exact merged/)
  assert.throws(() => assertMergedSkillProposalEvidence({ ...pr, state: 'open' }, checks, repo, head), /not an exact merged/)
  assert.throws(() => assertMergedSkillProposalEvidence({ ...pr, merged_at: null }, checks, repo, head), /not an exact merged/)
  assert.throws(() => assertMergedSkillProposalEvidence({ ...pr, head: { ...pr.head, sha: 'b'.repeat(40) } }, checks, repo, head), /not an exact merged/)
  assert.throws(() => assertMergedSkillProposalEvidence({ ...pr, head: { ...pr.head, repo: { full_name: 'attacker/repo' } } }, checks, repo, head), /not an exact merged/)
  assert.throws(() => assertMergedSkillProposalEvidence(pr, checks, 'attacker/repo', head), /not an exact merged/)
  assert.throws(() => assertMergedSkillProposalEvidence(pr, { ...checks, head: 'b'.repeat(40) }, repo, head), /not an exact merged/)
  assert.throws(() => assertMergedSkillProposalEvidence(pr, checks, repo, 'main'), /Incomplete/)
})

test('missing, pending, duplicated or failed required CI contexts cannot grant trust', () => {
  for (const statuses of [
    success.filter(row => row.context !== 'CI Evidence'),
    [...success, { context: 'CI Evidence', state: 'success' }],
    success.map(row => row.context === 'CI Evidence' ? { ...row, state: 'failure' } : row),
    success.map(row => row.context === 'CI Evidence' ? { ...row, state: 'pending' } : row),
  ]) {
    assert.throws(() => assertMergedSkillProposalEvidence(pr, { ...checks, statuses }, repo, head),
      /missing successful required CI gate/)
  }
  for (const evidence of [
    { ...checks, statuses: [...success, { context: 'Other', state: 'pending' }] },
    { ...checks, checks: [{ name: 'Security', status: 'in_progress', conclusion: null }] },
    { ...checks, checks: [{ name: 'Security', status: 'completed', conclusion: 'failure' }] },
    { ...checks, checks: [{ name: 'Security', status: 'completed', conclusion: 'cancelled' }] },
    { ...checks, checks: [{ name: 'Security', status: 'completed', conclusion: 'timed_out' }] },
    { ...checks, statuses: Array.from({ length: 101 }, () => success[0]) },
  ]) {
    assert.throws(() => assertMergedSkillProposalEvidence(pr, evidence, repo, head))
  }
})

test('auto-advance denies writes before checking credentials or GitHub and never executes Skills', async () => {
  const calls = []
  const transport = {
    request: async () => { calls.push('credential-request'); throw Error('must not be called') },
    publicRead: async () => { calls.push('public-read'); throw Error('must not be called') },
  }
  const actions = {
    file: { execute: async () => { calls.push('file') } },
    branch: { execute: async () => { calls.push('branch') } },
    commitFile: { execute: async () => { calls.push('commit') } },
    createPr: { execute: async () => { calls.push('pr') } },
  }
  const checksTool = { execute: async () => { calls.push('checks') } }
  const settings = { githubAccounts: [{ owner: 'fongap-labs', tokenEnv: 'GITHUB_TOKEN_FONGAP' }] }
  const denied = createAutoSkillAdvanceSpecs(settings, transport, actions, checksTool, () => false)[0]
  const enabled = createAutoSkillAdvanceSpecs(settings, transport, actions, checksTool, () => true)[0]
  assert.equal(denied.name, 'code_github_skill_auto_advance')
  const args = { targetRepository: repo, proposalPrNumber: 12, expectedProposalHead: head,
    repository: 'example/skill-guides', path: 'skills/example-skill/SKILL.md',
    commit: head, sourceBlobSha: 'b'.repeat(40), licenseBlobSha: 'c'.repeat(40) }
  const execution = { signal: new AbortController().signal, account: 'fongap-labs' }
  await assert.rejects(() => denied.execute(args, execution), /writes are disabled/)
  await assert.rejects(() => enabled.execute({ ...args, proposalPrNumber: 0 }, execution), /Invalid source Skill proposal identity/)
  await assert.rejects(() => enabled.execute({ ...args, targetRepository: 'another-org/repo' }, execution), /no GitHub account|cannot access repositories/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => enabled.execute(args, { signal: controller.signal, account: 'fongap-labs' }))
  assert.deepEqual(calls, [])
})
