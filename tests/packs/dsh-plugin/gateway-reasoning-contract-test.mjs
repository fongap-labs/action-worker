import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readTargetText } from '../../kit/contract.mjs'
import {
  decodeGatewayReasoningCatalog,
  toHarnessReasoningEfforts,
  mapGatewayReasoningChoice,
} from '#target/packages/dsh-delta-suite/src/delta-suite-adapter/gateway-reasoning.ts'

const source = readTargetText('packages', 'dsh-delta-suite', 'src', 'delta-suite-adapter', 'gateway-reasoning.ts')

const highBestEffort = {
  default: 'high', mode: 'best_effort',
  native_confirmed: false, fallback: 'native_without_unknown_parameter',
}
const gateway = {
  object: 'list',
  data: [{
    id: 'Max', object: 'model', supports_reasoning: true,
    reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', max: 'max' },
    reasoning_efforts: ['low', 'medium', 'high', 'max'],
    reasoning_policy: highBestEffort,
  }, {
    id: 'General', object: 'model', supports_reasoning: false,
    reasoningEfforts: {}, reasoning_efforts: [], reasoning_policy: highBestEffort,
  }],
}

test('authenticated Gateway metadata maps to exact, opt-in native model levels', () => {
  const parsed = decodeGatewayReasoningCatalog(gateway)
  assert.equal(parsed.length, 1, 'a policy alone cannot fabricate a reasoning model menu')
  assert.equal(parsed[0].modelId, 'Max')
  assert.equal(parsed[0].defaultPolicy, 'high-best-effort')
  assert.equal(parsed[0].nativeConfirmed, false,
    'best-effort levels must not claim that each physical node supports them')
  assert.deepEqual(toHarnessReasoningEfforts(parsed[0]), {
    low: 'low', medium: 'medium', high: 'high', max: 'max', off: 'none',
  })
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed[0].reasoningEfforts))
  assert.equal('apiKey' in parsed[0], false)
})

test('Gateway default differs on the wire from explicit Off for both supported request styles', () => {
  const model = decodeGatewayReasoningCatalog(gateway)[0]
  assert.deepEqual(mapGatewayReasoningChoice(model, 'default', 'openai'), {},
    'Gateway default remains a soft High intent with no explicit field')
  assert.deepEqual(mapGatewayReasoningChoice(model, 'default', 'anthropic'), {})
  assert.deepEqual(mapGatewayReasoningChoice(model, 'off', 'openai'), { reasoning_effort: 'none' })
  assert.deepEqual(mapGatewayReasoningChoice(model, 'off', 'anthropic'), {
    thinking: { type: 'disabled' },
  })
  assert.deepEqual(mapGatewayReasoningChoice(model, 'high', 'openai'), {
    reasoning_effort: 'high',
  })
  assert.equal(mapGatewayReasoningChoice(model, 'high', 'anthropic'), undefined,
    'the catalog does not authorize inventing adaptive thinking or token budgets')
  assert.equal(mapGatewayReasoningChoice(model, 'not-offered', 'openai'), undefined)
})

test('per-access-key catalog results are decoded independently with no probes or shared caches', () => {
  const owner = decodeGatewayReasoningCatalog(gateway)[0]
  const limited = decodeGatewayReasoningCatalog({
    object: 'list', data: [{
      id: 'Max', reasoningEfforts: { low: 'low' }, reasoning_efforts: ['low'],
      reasoning_policy: highBestEffort,
    }],
  })[0]
  assert.deepEqual(toHarnessReasoningEfforts(limited), { low: 'low', off: 'none' })
  assert.equal(mapGatewayReasoningChoice(limited, 'high', 'openai'), undefined,
    'a level from another key cannot be reused')
  assert.deepEqual(mapGatewayReasoningChoice(owner, 'high', 'openai'), {
    reasoning_effort: 'high',
  })
  assert.equal(source.includes('fetch('), false, 'the adapter must never probe /v1/models')
  assert.equal(source.includes('localStorage'), false)
  assert.equal(source.includes('window.'), false)
})

test('no manifest and contradictory or malformed values fail without modifying native choices', () => {
  for (const value of [null, [], {}, { data: gateway.data },
    { object: 'list', data: null }, { object: 'error', data: gateway.data }]) {
    assert.deepEqual(decodeGatewayReasoningCatalog(value), [])
  }
  for (const item of [
    { id: 'Max', reasoningEfforts: { high: 'high' }, reasoning_efforts: ['low'],
      reasoning_policy: highBestEffort },
    { id: 'Max', reasoningEfforts: { high: 'high\nx-request: bad' },
      reasoning_efforts: ['high'], reasoning_policy: highBestEffort },
    { id: 'Max', reasoningEfforts: { high: null }, reasoning_efforts: ['high'],
      reasoning_policy: highBestEffort },
    { id: '', reasoningEfforts: { high: 'high' }, reasoning_policy: highBestEffort },
    { id: 'Max', reasoningEfforts: { high: 'high' }, reasoning_efforts: [],
      reasoning_policy: highBestEffort },
  ]) assert.deepEqual(decodeGatewayReasoningCatalog({ object: 'list', data: [item] }), [])
})

test('duplicate model identities fail closed rather than choosing an arbitrary key-scoped record', () => {
  const valid = gateway.data[0]
  const duplicate = { ...valid, reasoningEfforts: { high: 'high' },
    reasoning_efforts: ['high'] }
  assert.deepEqual(decodeGatewayReasoningCatalog({
    object: 'list', data: [valid, duplicate],
  }), [], 'conflicting metadata cannot grant levels to an ambiguous model id')
  assert.deepEqual(decodeGatewayReasoningCatalog({
    object: 'list', data: [valid, { id: 'Max', reasoningEfforts: null }],
  }), [], 'a malformed duplicate must also revoke the first seemingly valid record')
})

test('snake-case-only catalogs preserve offered levels but never invent an Off guarantee', () => {
  const parsed = decodeGatewayReasoningCatalog({
    object: 'list', data: [{ id: 'Legacy', reasoning_efforts: ['low', 'high'] }],
  })
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].defaultPolicy, 'unspecified')
  assert.deepEqual(toHarnessReasoningEfforts(parsed[0]), { low: 'low', high: 'high' })
  assert.equal(mapGatewayReasoningChoice(parsed[0], 'off', 'openai'), undefined)
  assert.deepEqual(mapGatewayReasoningChoice(parsed[0], 'default', 'openai'), {})
})

test('native-adapter wire values preserve declared spellings and never reinterpret missing levels', () => {
  const parsed = decodeGatewayReasoningCatalog({
    object: 'list',
    data: [{ id: 'Advanced', reasoningEfforts: { max: 'xhigh', off: 'none' } }],
  })[0]
  assert.deepEqual(toHarnessReasoningEfforts(parsed), { max: 'xhigh', off: 'none' })
  assert.deepEqual(mapGatewayReasoningChoice(parsed, 'max', 'openai'), {
    reasoning_effort: 'xhigh',
  })
  assert.equal(mapGatewayReasoningChoice(parsed, 'medium', 'openai'), undefined)
})
