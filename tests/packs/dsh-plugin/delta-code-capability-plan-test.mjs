import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CODING_CAPABILITIES,
  validateCodingCapabilities,
  queryCodingCapabilities,
  createCodingCapabilitiesTool,
} from '#target/packages/delta-code/lib/delta-code-strategy/capability-catalog.js'
import { planDeclaredCapabilities } from '#target/packages/delta-code/lib/delta-code-strategy/capability-plan.js'

const by = id => CODING_CAPABILITIES.find(item => item.id === id)
const graph = [
  { ...by('quality-review'), id: 'source-review', uses: [], requires: [] },
  { ...by('diagnostic-readiness'), id: 'diagnose', uses: ['source-review'], requires: [] },
  { ...by('feature-delivery'), id: 'implement', uses: ['diagnose'], requires: ['source-review'] },
  { ...by('verified-experience'), id: 'verify', uses: [], requires: ['implement'] },
  { ...by('small-change'), id: 'publish', uses: [], requires: ['verify'] },
]

test('read-only dependency plan orders required edges but does not execute optional references', () => {
  assert.doesNotThrow(() => validateCodingCapabilities(graph))
  const output = queryCodingCapabilities({ action: 'plan', ids: ['publish'] }, graph)
  assert.equal(output.action, 'plan')
  assert.deepEqual(output.plan.required, ['source-review', 'implement', 'verify', 'publish'])
  assert.deepEqual(output.plan.ready, ['source-review'])
  assert.deepEqual(output.plan.waves, [
    ['source-review'], ['implement'], ['verify'], ['publish'],
  ])
  assert.deepEqual(output.plan.suggested, [])
  assert.deepEqual(output.skills, ['code-quality-strength'])
  assert.ok(output.plan.blocked.length === 0)
  assert.deepEqual(queryCodingCapabilities({ action: 'get', id: 'implement' }, graph).skills,
    ['code-feature-delivery'], 'legacy get must not load optional or required Skill dependencies')
  assert.equal('plan' in queryCodingCapabilities({ action: 'compose', ids: ['implement'] }, graph), false)
})

test('Host-verified active and completed checkpoints prevent duplicate ready work', () => {
  const completed = queryCodingCapabilities({
    action: 'plan', ids: ['publish'], completed: ['source-review'],
  }, graph)
  assert.deepEqual(completed.plan.ready, ['implement'])
  assert.deepEqual(completed.skills, ['code-feature-delivery'])
  const active = queryCodingCapabilities({
    action: 'plan', ids: ['publish'], completed: ['source-review'], active: ['implement'],
  }, graph)
  assert.deepEqual(active.plan.ready, [])
  assert.deepEqual(active.plan.active, ['implement'])
  assert.deepEqual(active.plan.blocked, ['verify', 'publish'])
  assert.deepEqual(active.plan.waves, [])
  assert.deepEqual(active.skills, [])
  const resumed = queryCodingCapabilities({
    action: 'plan', ids: ['publish'], completed: ['source-review', 'implement'],
  }, graph)
  assert.deepEqual(resumed.plan.ready, ['verify'])
  assert.deepEqual(resumed.plan.waves, [['verify'], ['publish']])
})

test('optional links remain suggestions when no strong dependency exists', () => {
  const plan = queryCodingCapabilities({ action: 'plan', ids: ['diagnose'] }, graph).plan
  assert.deepEqual(plan.required, ['diagnose'])
  assert.deepEqual(plan.suggested, ['source-review'])
  assert.deepEqual(plan.ready, ['diagnose'])
  assert.deepEqual(plan.waves, [['diagnose']])
  assert.deepEqual(plan.skills, ['code-diagnostic-readiness'])
})

test('cycles, duplicate, missing and contradictory Host checkpoint reports reject planning', () => {
  for (const catalog of [
    [ { ...graph[0], requires: ['source-review'] }, ...graph.slice(1) ],
    [ { ...graph[0], requires: ['implement'] }, ...graph.slice(1) ],
    [ { ...graph[0], requires: ['unregistered'] }, ...graph.slice(1) ],
    [ { ...graph[0], requires: ['diagnose', 'diagnose'] }, ...graph.slice(1) ],
  ]) {
    assert.throws(() => validateCodingCapabilities(catalog))
  }
  for (const query of [
    { action: 'plan', ids: [] },
    { action: 'plan', ids: ['publish', 'publish'] },
    { action: 'plan', ids: ['publish'], completed: ['unknown'] },
    { action: 'plan', ids: ['publish'], completed: ['diagnose'] },
    { action: 'plan', ids: ['publish'], completed: ['implement'] },
    { action: 'plan', ids: ['publish'], active: ['publish'] },
    { action: 'plan', ids: ['publish'], active: ['diagnose'] },
    { action: 'plan', ids: ['publish'], completed: ['implement'], active: ['implement'] },
    { action: 'plan', ids: ['publish'], completed: ['source-review', 'source-review'] },
    { action: 'plan', ids: ['publish'], active: Array.from({length: 65}, () => 'implement') },
  ]) {
    assert.throws(() => queryCodingCapabilities(query, graph))
  }
  assert.throws(() => planDeclaredCapabilities(graph, ['publish'], ['source-review'], ['source-review']),
    /cannot be both/)
})

test('native capability tool exposes plan but has no execution, scheduler or write side effects', async () => {
  const tool = createCodingCapabilitiesTool()
  const planned = await tool.execute({
    action: 'plan', ids: ['feature-delivery', 'ci-repair'], active: ['feature-delivery'],
  })
  assert.equal(planned.plan.active[0], 'feature-delivery')
  assert.deepEqual(planned.plan.ready, ['ci-repair'])
  assert.deepEqual(planned.skills, ['code-ci-repair'])
  assert.equal('run' in planned, false)
  assert.equal('launch' in planned, false)
  assert.equal('subprocess' in tool, false)
})
