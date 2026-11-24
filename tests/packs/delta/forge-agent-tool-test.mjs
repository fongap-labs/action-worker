import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { targetFile, targetRoot } from './delta-test-target.mjs'

const [{ applyAgentForgeTool }, zhLocale] = await Promise.all([
  import(targetFile('packages/delta/forge/src/agent-tool.mjs')),
  readFile(join(targetRoot, 'packages/delta/forge/locale/zh.json'), 'utf8').then(JSON.parse),
])

const change = {
  provider: 'github', project: 'owner/repo', number: 12,
  title: 'Update parser', state: 'open', sourceBranch: 'feature/parser',
  targetBranch: 'main', headSha: 'abc123', description: 'Please review the parser changes.',
}

function setup(outcome = 'allowed-once', credentialError = undefined) {
  let tool
  const calls = { approval: [], credentials: [], reads: [] }
  const ctx = {
    tools: { register(value) { tool = value; return () => {} } },
    approval: { async request(request) { calls.approval.push(request); return outcome } },
    credentials: { async resolve(reference) {
      calls.credentials.push(reference)
      if (credentialError !== undefined) throw credentialError
      return { value: 'private-token', source: 'test' }
    } },
  }
  applyAgentForgeTool(ctx, {
    github: { client: { async readChange(...args) { calls.reads.push(args); return change } }, tokenRef: 'DELTA_GITHUB_TOKEN' },
    gitlab: { client: { async readChange(...args) { calls.reads.push(args); return change } } },
  })
  const execute = (args = { provider: 'github', project: 'owner/repo', number: 12 }) => tool.execute(args, {
    callId: 'forge-call', agent: {}, signal: new AbortController().signal,
  })
  return { calls, execute, tool: () => tool }
}

test('requires one-shot approval before reading and localizes the approval face', async () => {
  const fixture = setup()
  const value = await fixture.execute()
  assert.deepEqual(value, { status: 'success', result: change })
  assert.equal(fixture.calls.approval.length, 1)
  assert.equal(fixture.calls.approval[0].reason, 'The agent wants to make one read-only request to a configured Forge service.')
  assert.deepEqual(fixture.calls.approval[0].displayReason, {
    en: 'Allow a read-only request for GitHub pull request owner/repo #12?',
    zh: zhLocale.approval.github.replace('{project}', 'owner/repo').replace('{number}', '12'),
  })
  assert.deepEqual(fixture.calls.credentials, ['DELTA_GITHUB_TOKEN'])
  assert.equal(fixture.calls.reads.length, 1)
  const rendered = fixture.tool().output.render({}, value)
  assert.match(rendered[0].text, /UNTRUSTED EXTERNAL FORGE DATA/u)
  assert.match(rendered[0].text, /Update parser/u)
  assert.doesNotMatch(rendered[0].text, /private-token/u)
})

test('denial, cancellation, and unavailable approval fail closed', async () => {
  for (const [outcome, status] of [['rejected', 'denied'], ['cancelled', 'cancelled'], ['unavailable', 'unavailable']]) {
    const fixture = setup(outcome)
    assert.deepEqual(await fixture.execute(), { status })
    assert.equal(fixture.calls.credentials.length, 0)
    assert.equal(fixture.calls.reads.length, 0)
  }
})

test('rejects malformed repository names before approval', async () => {
  const fixture = setup()
  await assert.rejects(fixture.execute({ provider: 'github', project: '../repo', number: 12 }), /Invalid repository/u)
  assert.equal(fixture.calls.approval.length, 0)
  assert.equal(fixture.calls.credentials.length, 0)
  assert.equal(fixture.calls.reads.length, 0)
})

test('does not disclose credential failures to the model', async () => {
  const fixture = setup('allowed-once', new Error('private-token leaked'))
  const value = await fixture.execute()
  assert.deepEqual(value, { status: 'error' })
  const rendered = fixture.tool().output.render({}, value)
  assert.equal(rendered[0].text, 'Forge request error. Do not retry unless the user approves another request.')
  assert.doesNotMatch(rendered[0].text, /private-token/u)
  assert.equal(fixture.calls.reads.length, 0)
})
