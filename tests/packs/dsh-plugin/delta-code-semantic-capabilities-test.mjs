import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readTargetText } from '../../kit/contract.mjs'
import {
  CODING_CAPABILITIES,
  validateCodingCapabilities,
  queryCodingCapabilities,
  createCodingCapabilitiesTool,
} from '#target/packages/delta-code/lib/delta-code-strategy/capability-catalog.js'
import { decideCodingWorkflow } from '#target/packages/delta-code/lib/delta-code-strategy/workflow-route.js'

test('reviewed semantic directory is valid, bounded and registered with known Skills', () => {
  assert.doesNotThrow(() => validateCodingCapabilities())
  const catalog = queryCodingCapabilities({ action: 'list' })
  const ids = catalog.capabilities.map(item => item.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const id of [
    'feature-delivery', 'defect-repair', 'ci-repair', 'quality-review',
    'diagnostic-readiness', 'verified-experience',
  ]) assert.ok(ids.includes(id), 'missing scenario: ' + id)
  assert.deepEqual(catalog.skills, [], 'list must not pre-load or issue Skills')
  assert.ok(catalog.capabilities.every(item =>
    item.intent && item.accepts.length === 0 && item.skills.length === 0),
  'lightweight list exposes intent, not full Skill bodies')
})

test('get/compose only return explicitly selected reviewed skills and optional references', () => {
  const quality = queryCodingCapabilities({ action: 'get', id: 'quality-review' })
  assert.deepEqual(quality.skills, ['code-quality-strength'])
  assert.ok(quality.capabilities[0].accepts.length)
  const combined = queryCodingCapabilities({
    action: 'compose', ids: ['defect-repair', 'quality-review', 'diagnostic-readiness'],
  })
  assert.deepEqual(combined.skills, [
    'code-root-cause-debugging', 'code-quality-strength', 'code-diagnostic-readiness',
  ])
  assert.ok(combined.capabilities[0].uses.includes('diagnostic-readiness'))
  assert.deepEqual(
    queryCodingCapabilities({ action: 'get', id: 'feature-delivery' }).skills,
    ['code-feature-delivery'],
    'uses must never auto-install or auto-load related capabilities')
  assert.throws(() => queryCodingCapabilities({ action: 'get', id: 'other-tool' }), /unknown capability/)
  assert.throws(() => queryCodingCapabilities({ action: 'compose', ids: [] }), /1\.\.8/)
  assert.throws(() => queryCodingCapabilities({
    action: 'compose', ids: ['quality-review', 'quality-review'],
  }), /distinct/)
  assert.throws(() => queryCodingCapabilities({
    action: 'compose', ids: Array.from({ length: 9 }, () => 'quality-review'),
  }), /1\.\.8/)
})

test('unknown skills, unsafe duplicates, missing edges and cycles fail before registration', () => {
  const base = CODING_CAPABILITIES[0]
  assert.throws(() => validateCodingCapabilities([base, { ...base }]), /duplicate capability/)
  assert.throws(() => validateCodingCapabilities([
    { ...base, id: 'invalid-unknown', skills: ['code-unsafe-shell'] },
  ]), /unknown or duplicate capability Skill/)
  assert.throws(() => validateCodingCapabilities([
    { ...base, uses: ['not-present'] },
  ]), /unknown capability reference/)
  assert.throws(() => validateCodingCapabilities([
    { ...base, uses: ['feature-delivery'] },
    { ...CODING_CAPABILITIES[1], uses: ['small-change'] },
  ]), /cyclic capability reference/)
  assert.throws(() => validateCodingCapabilities([
    { ...base, uses: ['small-change', 'small-change'] },
  ]), /duplicate capability reference/)
  assert.throws(() => validateCodingCapabilities([
    { ...base, id: '__proto__' },
  ]), /invalid or duplicate capability/)
})

test('catalog rejects malformed, oversized and control-bearing declarations', () => {
  const base = CODING_CAPABILITIES[0]
  const invalidCatalogs = [
    [],
    Array.from({ length: 65 }, (_unused, index) => ({
      ...base, id: `entry-${index}`,
    })),
  ]
  for (const catalog of invalidCatalogs) {
    assert.throws(() => validateCodingCapabilities(catalog), /invalid capability catalog size/)
  }
  for (const invalid of [
    null,
    { ...base, id: undefined },
    { ...base, id: 'x'.repeat(65) },
    { ...base, title: '' },
    { ...base, title: 'x'.repeat(513) },
    { ...base, intent: `unsafe${String.fromCharCode(0)}metadata` },
    { ...base, accepts: [] },
    { ...base, accepts: [null] },
    { ...base, accepts: ['x'.repeat(513)] },
    { ...base, accepts: Array.from({ length: 17 }, () => 'task') },
    { ...base, produces: 'not-a-list' },
    { ...base, uses: null },
    { ...base, skills: [null] },
    { ...base, skills: [] },
  ]) {
    assert.throws(() => validateCodingCapabilities([invalid]),
      /invalid or duplicate capability|incomplete capability/,
      'must reject unsafe or incomplete capability metadata')
  }
  assert.doesNotThrow(() => validateCodingCapabilities([{ ...base, uses: [] }]),
    'a capability with no optional references remains valid')
})

test('tool snapshots exclude unexpected fields and cannot mutate the reviewed catalog', () => {
  const base = CODING_CAPABILITIES[0]
  const custom = {
    ...base, injectedInternalConfig: { privileged: true },
  }
  const originalAccepts = [...base.accepts]
  const view = queryCodingCapabilities({ action: 'get', id: base.id }, [custom])
  const list = queryCodingCapabilities({ action: 'list' }, [custom])
  for (const returned of [view.capabilities[0], list.capabilities[0]]) {
    assert.deepEqual(Object.keys(returned).sort(), [
      'accepts', 'id', 'intent', 'produces', 'skills', 'title', 'uses',
    ], 'only declared public fields may appear in tool results')
    assert.equal('injectedInternalConfig' in returned, false)
  }
  assert.deepEqual(list.capabilities[0].skills, [],
    'listing must not expose procedure bodies or load selected Skills')
  view.capabilities[0].accepts.push('output-only-change')
  view.capabilities[0].uses.push('output-only-dependency')
  view.capabilities[0].skills.push('output-only-skill')
  assert.deepEqual(base.accepts, originalAccepts)
  assert.deepEqual(queryCodingCapabilities({ action: 'get', id: base.id }, [custom])
    .capabilities[0].accepts, originalAccepts,
  'tool output array mutations must not modify the reviewed source catalog')
})

test('native tool is read-only and rejects malformed capability operations', async () => {
  const tool = createCodingCapabilitiesTool()
  assert.equal(tool.name, 'code_capabilities')
  const listed = await tool.execute({ action: 'list' })
  assert.equal(listed.action, 'list')
  const chosen = await tool.execute({ action: 'get', id: 'ci-repair' })
  assert.deepEqual(chosen.skills, ['code-ci-repair'])
  const combined = await tool.execute({
    action: 'compose', ids: ['ci-repair', 'diagnostic-readiness'],
  })
  assert.deepEqual(combined.skills, ['code-ci-repair', 'code-diagnostic-readiness'])
  await assert.rejects(() => tool.execute({ action: 'get', id: 'arbitrary-exec' }), /unknown capability/)
  await assert.rejects(() => tool.execute({ action: 'compose', ids: [] }), /1\.\.8/)
  assert.equal('subprocess' in tool, false)
  assert.equal('run' in combined, false)
})

test('high-impact workflow selects quality and diagnostics while small changes remain lightweight', () => {
  const highFeature = decideCodingWorkflow({ taskKind: 'feature', scope: 'large', risk: 'high' })
  assert.ok(highFeature.skills.includes('code-quality-strength'))
  assert.ok(highFeature.skills.includes('code-diagnostic-readiness'))
  assert.ok(highFeature.skills.indexOf('code-quality-strength') <
    highFeature.skills.indexOf('code-verification-gate'))
  const highFix = decideCodingWorkflow({ taskKind: 'bugfix', scope: 'large', risk: 'high' })
  assert.ok(highFix.skills.includes('code-quality-strength'))
  assert.ok(highFix.skills.includes('code-diagnostic-readiness'))
  const small = decideCodingWorkflow({ taskKind: 'feature', scope: 'small', risk: 'low' })
  assert.equal(small.mode, 'fast')
  assert.equal(small.skills.includes('code-quality-strength'), false)
  assert.equal(small.skills.includes('code-diagnostic-readiness'), false)
})

test('semantic selection stays native, optional and no less secure than legacy routing', () => {
  const routing = readTargetText('packages', 'delta-code', 'src',
    'delta-code-adapter', 'providers', 'dsh', 'auto-routing.ts')
  const guidance = readTargetText('packages', 'delta-code', 'src', 'runtime.ts')
  const architecture = readTargetText('packages', 'delta-code', 'ARCHITECTURE.md')
  assert.match(routing, /keyword-based hint, not authority/)
  assert.match(guidance, /not just keyword route hints/)
  assert.match(architecture, /No second runtime/)
  const quality = queryCodingCapabilities({ action: 'get', id: 'verified-experience' })
  assert.deepEqual(quality.skills, ['code-experience-review'])
  assert.ok(quality.capabilities[0].intent.includes('verified') ||
    quality.capabilities[0].intent.includes('proven') ||
    quality.capabilities[0].intent.includes('real'))
})
