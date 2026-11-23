import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildExperienceCandidate,
  createExperienceCandidateTool,
} from '#target/packages/delta-code/lib/delta-code-strategy/experience-candidate.js'

const sha = 'b'.repeat(40)
const base = {
  title: 'Resolve flaky CI run routing',
  problem: 'CI run links were incorrectly resolved to the source repository.',
  rootCause: 'The run owner was inferred from an unrelated pull request.',
  fixPattern: 'Parse the actual GitHub Actions URL and preserve its owning repository.',
  appliesWhen: ['Actions checks use a separate central repository'],
  limitations: ['Not applicable to non-GitHub CI providers'],
  sourceRepository: 'fongap-labs/dsh-plugin',
  sourceCommit: sha,
  evidence: [{
    runUrl: 'https://github.com/fongap-labs/action-worker/actions/runs/123456',
    verifies: 'Central Linux and Windows gates for the exact source revision',
  }],
}

test('candidate preserves provenance but never mistakes a claimed CI URL for verified evidence', () => {
  const candidate = buildExperienceCandidate(base)
  assert.equal(candidate.schemaVersion, 1)
  assert.equal(candidate.id, 'fongap-labs-dsh-plugin-' + sha.slice(0, 12))
  assert.deepEqual(candidate.source, {
    repository: 'fongap-labs/dsh-plugin', commit: sha,
  })
  assert.equal(candidate.stage, 'pending-automated-evidence-check')
  assert.deepEqual(candidate.evidence, base.evidence)
  assert.deepEqual(candidate.appliesWhen, base.appliesWhen)
  assert.deepEqual(candidate.limitations, base.limitations)
  assert.deepEqual(Object.keys(candidate).sort(), [
    'appliesWhen', 'evidence', 'fixPattern', 'id', 'limitations', 'problem',
    'rootCause', 'schemaVersion', 'source', 'stage', 'title',
  ])
  assert.equal('verified' in candidate, false)
  assert.equal('approved' in candidate, false)
  assert.equal('autoEnable' in candidate, false)
})

test('rejects missing, mutable, malformed and sensitive claims before generating a candidate', () => {
  const badCases = [
    null,
    {},
    { ...base, sourceCommit: 'main' },
    { ...base, sourceCommit: 'c'.repeat(39) },
    { ...base, sourceRepository: '../../secret/repo' },
    { ...base, sourceRepository: 'github.com/user/repo' },
    { ...base, title: '' },
    { ...base, problem: 'x'.repeat(1001) },
    { ...base, problem: 'Injected' + String.fromCharCode(0) + 'content' },
    { ...base, rootCause: 'token=secret1234' },
    { ...base, fixPattern: 'ghp_' + 'a'.repeat(30) },
    { ...base, appliesWhen: [] },
    { ...base, appliesWhen: ['same', 'same'] },
    { ...base, appliesWhen: ['x'.repeat(1001)] },
    { ...base, limitations: [] },
    { ...base, limitations: Array.from({ length: 9 }, () => 'case') },
    { ...base, evidence: [] },
    { ...base, evidence: [null] },
    { ...base, evidence: [{
      runUrl: 'https://attacker.example/github.com/fongap-labs/action-worker/actions/runs/123',
      verifies: 'Fake',
    }] },
    { ...base, evidence: [{
      runUrl: 'https://github.com/fongap-labs/action-worker/actions/runs/123?token=abc',
      verifies: 'Not a clean URL',
    }] },
    { ...base, evidence: [{
      runUrl: 'http://github.com/fongap-labs/action-worker/actions/runs/123',
      verifies: 'Insecure scheme',
    }] },
    { ...base, evidence: [{
      runUrl: 'https://github.com/fongap-labs/action-worker/actions/runs/123',
      verifies: '',
    }] },
    { ...base, evidence: Array.from({ length: 6 }, (_unused, index) => ({
      runUrl: 'https://github.com/fongap-labs/action-worker/actions/runs/' + (index + 1),
      verifies: 'Valid looking run',
    })) },
    { ...base, evidence: [base.evidence[0], base.evidence[0]] },
  ]
  for (const input of badCases) assert.throws(() => buildExperienceCandidate(input))
})

test('whitelists fields and makes detached snapshots, without raising authorization', () => {
  const source = {
    ...base,
    unexpected: { command: 'curl arbitrary.url' },
    evidence: [{ ...base.evidence[0], injectedToken: 'secret-untrusted' }],
  }
  const first = buildExperienceCandidate(source)
  assert.equal('unexpected' in first, false)
  assert.equal('injectedToken' in first.evidence[0], false)
  first.appliesWhen.push('visible only in snapshot')
  first.evidence[0].verifies = 'changed output'
  const second = buildExperienceCandidate(source)
  assert.deepEqual(second.appliesWhen, base.appliesWhen)
  assert.equal(second.evidence[0].verifies, base.evidence[0].verifies)
})

test('native experience candidate tool is pure, read-only, and cannot approve or execute Skills', async () => {
  const tool = createExperienceCandidateTool()
  assert.equal(tool.name, 'code_experience_candidate')
  assert.equal('subprocess' in tool, false)
  const candidate = await tool.execute(base)
  assert.equal(candidate.stage, 'pending-automated-evidence-check')
  assert.equal('approved' in candidate, false)
  await assert.rejects(() => tool.execute({ ...base, evidence: [] }))
})
