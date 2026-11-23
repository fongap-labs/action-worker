import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readTargetText } from '../../kit/contract.mjs'
import {
  decodeGatewayReasoningCatalog,
  toHarnessReasoningEfforts,
  mapGatewayReasoningChoice,
  previewGatewayReasoningSync,
} from '#target/packages/delta-suite/lib/delta-suite-adapter/gateway-reasoning.js'
import { applyApprovedGatewayReasoningSync } from '#target/packages/delta-suite/lib/delta-suite-adapter/gateway-reasoning-apply.js'
import { installHostGatewayEffortSync, DELTA_GATEWAY_EFFORT_PREVIEW_PATH, DELTA_GATEWAY_EFFORT_APPLY_PATH } from '#target/packages/delta-suite/lib/host-gateway-effort.js'

const source = readTargetText('packages', 'delta-suite', 'src', 'delta-suite-adapter', 'gateway-reasoning.ts')

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
    low: 'low', medium: 'medium', high: 'high', max: 'max',
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

test('current llm-pi-ai native Off is not a real Gateway disable request', () => {
  const model = decodeGatewayReasoningCatalog(gateway)[0]
  const native = toHarnessReasoningEfforts(model)
  assert.equal(native.off, undefined,
    'Host llm-pi-ai currently omits reasoning on Off and would trigger Gateway default High')
  assert.equal(model.reasoningEfforts.off, 'none',
    'Gateway metadata must retain its distinct explicit Off intent')
  assert.deepEqual(mapGatewayReasoningChoice(model, 'default', 'openai'), {})
  assert.deepEqual(mapGatewayReasoningChoice(model, 'off', 'openai'), {
    reasoning_effort: 'none',
  })
  assert.deepEqual(mapGatewayReasoningChoice(model, 'off', 'anthropic'), {
    thinking: { type: 'disabled' },
  })
  const physicallyConfirmed = decodeGatewayReasoningCatalog({
    object: 'list',
    data: [{ ...gateway.data[0], reasoning_policy: {
      ...highBestEffort, native_confirmed: true,
    } }],
  })[0]
  assert.equal(physicallyConfirmed.nativeConfirmed, true)
  assert.equal(toHarnessReasoningEfforts(physicallyConfirmed).off, undefined,
    'physical node reasoning support never proves Host Off serialization')
})

test('unsupported response protocol or contradictory reasoning flags never publish a false Off', () => {
  const model = decodeGatewayReasoningCatalog(gateway)[0]
  assert.equal(mapGatewayReasoningChoice(model, 'default', 'gemini'), undefined)
  assert.equal(mapGatewayReasoningChoice(model, 'off', 'gemini'), undefined)
  assert.deepEqual(decodeGatewayReasoningCatalog({
    object: 'list', data: [{ ...gateway.data[0], supports_reasoning: false }],
  }), [])
  assert.deepEqual(decodeGatewayReasoningCatalog({
    object: 'list', data: [{ ...gateway.data[0], reasoningEfforts: {
      ...gateway.data[0].reasoningEfforts, off: '\nHeader: injection',
    } }],
  }), [])
  const rawOff = decodeGatewayReasoningCatalog({
    object: 'list', data: [{ ...gateway.data[0], reasoningEfforts: {
      ...gateway.data[0].reasoningEfforts, off: 'off',
    } }],
  })[0]
  assert.equal(rawOff.reasoningEfforts.off, 'off')
  assert.equal(toHarnessReasoningEfforts(rawOff).off, undefined)
  assert.deepEqual(mapGatewayReasoningChoice(rawOff, 'off', 'openai'), {
    reasoning_effort: 'off',
  })
})

test('per-access-key catalog results are decoded independently with no probes or shared caches', () => {
  const owner = decodeGatewayReasoningCatalog(gateway)[0]
  const limited = decodeGatewayReasoningCatalog({
    object: 'list', data: [{
      id: 'Max', reasoningEfforts: { low: 'low' }, reasoning_efforts: ['low'],
      reasoning_policy: highBestEffort,
    }],
  })[0]
  assert.deepEqual(toHarnessReasoningEfforts(limited), { low: 'low' })
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
  assert.deepEqual(toHarnessReasoningEfforts(parsed), { max: 'xhigh' })
  assert.deepEqual(mapGatewayReasoningChoice(parsed, 'max', 'openai'), {
    reasoning_effort: 'xhigh',
  })
  assert.equal(mapGatewayReasoningChoice(parsed, 'medium', 'openai'), undefined)
})

test('sync review proposes only exact-model native levels and leaves other Host fields untouched', () => {
  const models = [
    { id: 'Max', name: 'Max', api: 'openai-completions',
      apiKeyEnv: 'PRIVATE_REF', reasoningEfforts: { low: 'low', off: 'none' } },
    { id: 'General', name: 'General', reasoningEfforts: false },
  ]
  const before = JSON.stringify(models)
  const preview = previewGatewayReasoningSync(gateway, models, 'Max', 'low')
  assert.equal(preview.status, 'review')
  assert.equal(preview.modelId, 'Max')
  assert.deepEqual(preview.previous, { low: 'low', off: 'none' })
  assert.deepEqual(preview.proposed, { low: 'low', medium: 'medium', high: 'high', max: 'max' })
  assert.deepEqual(preview.added, ['medium', 'high', 'max'])
  assert.deepEqual(preview.removed, ['off'])
  assert.deepEqual(preview.remapped, [])
  assert.equal(JSON.stringify(models), before, 'review never mutates Host settings')
  assert.equal(JSON.stringify(preview).includes('PRIVATE_REF'), false, 'review never copies provider secret refs')
  assert.ok(Object.isFrozen(preview) && Object.isFrozen(preview.added) &&
    Object.isFrozen(preview.proposed))
  assert.equal(models[1].reasoningEfforts, false, 'other models remain untouched')
})

test('sync review is idempotent for matching models and refuses to reparent or create models', () => {
  const same = [{
    id: 'Max', reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', max: 'max' },
  }]
  const result = previewGatewayReasoningSync(gateway, same, 'Max', 'high')
  assert.equal(result.status, 'unchanged')
  assert.deepEqual(result.added, [])
  assert.deepEqual(result.remapped, [])
  assert.deepEqual(result.removed, [])
  assert.deepEqual(previewGatewayReasoningSync(gateway, same, 'max', 'high'),
    { status: 'blocked', modelId: 'max', reason: 'missing-host-model' })
  assert.equal(previewGatewayReasoningSync(gateway, [], 'Max', 'default').reason, 'missing-host-model')
  assert.equal(previewGatewayReasoningSync(gateway, null, 'Max', 'default').reason, 'missing-host-directory')
  assert.equal(previewGatewayReasoningSync(gateway, [same[0], same[0]], 'Max', 'high').reason,
    'duplicate-host-model')
})

test('sync review never silently switches dropped user levels to Gateway Default High', () => {
  const models = [{ id: 'Max', reasoningEfforts: { low: 'low', high: 'high' } }]
  const limited = { object: 'list', data: [{
    id: 'Max', reasoningEfforts: { low: 'low' }, reasoning_efforts: ['low'],
    reasoning_policy: highBestEffort,
  }] }
  assert.equal(previewGatewayReasoningSync(limited, models, 'Max', 'high').reason,
    'unsupported-selected-effort')
  assert.equal(previewGatewayReasoningSync(limited, models, 'Max', 'off').reason, 'native-off-unsafe')
  const defaultReview = previewGatewayReasoningSync(limited, models, 'Max', 'default')
  assert.equal(defaultReview.status, 'review')
  assert.deepEqual(defaultReview.removed, ['high'])
  assert.deepEqual(defaultReview.proposed, { low: 'low' })
  assert.equal(previewGatewayReasoningSync({ object: 'list', data: [] }, models, 'Max', 'high').reason,
    'unavailable-gateway-model')
  assert.equal(previewGatewayReasoningSync(limited, models, 'Max', 'invalid').reason,
    'invalid-selection')
  // Re-decoding a new access-key-scoped snapshot must not retain prior privileges.
  assert.equal(previewGatewayReasoningSync(gateway, models, 'Max', 'high').status, 'review')
  assert.equal(previewGatewayReasoningSync(limited, models, 'Max', 'high').status, 'blocked')
})

test('sync review refuses malformed or intentionally disabled native reasoning config', () => {
  for (const reasoningEfforts of [
    false, null, ['low'], { custom: 'custom' }, { low: null },
    { high: 'bad\nvalue' },
  ]) {
    const result = previewGatewayReasoningSync(
      gateway, [{ id: 'Max', reasoningEfforts }], 'Max', 'default',
    )
    assert.equal(result.status, 'blocked')
    assert.equal(result.reason, 'invalid-host-efforts')
  }
  const remap = previewGatewayReasoningSync({ object: 'list', data: [{
    id: 'Max', reasoningEfforts: { low: 'custom-low' },
  }] }, [{ id: 'Max', reasoningEfforts: { low: 'low' } }], 'Max', 'low')
  assert.equal(remap.status, 'review')
  assert.deepEqual(remap.remapped, ['low'])
  assert.deepEqual(remap.added, [])
  assert.deepEqual(remap.removed, [])
})

const makeAuthorizedSync = (overrides = {}) => {
  const model = { id: 'Max', name: 'Max', reasoningEfforts: { low: 'low' },
    input: ['text'], tokenLimit: 2048 }
  const profile = { apiKeyEnv: 'MY_GATEWAY_API_KEY', baseURL: 'https://gateway.example/v1',
    models: [model, { id: 'Unrelated', reasoningEfforts: false }] }
  const initial = { providers: { 'my-gateway': profile } }
  const approvedPreview = previewGatewayReasoningSync(gateway, profile.models, 'Max', 'low')
  assert.equal(approvedPreview.status, 'review')
  let calls = []
  let current = structuredClone(initial)
  const remote = {
    describe: async () => ({ ok: true, value: { writable: true, namespaces: [{
      ns: 'llm-pi-ai', revision: 7, value: current,
    }] } }),
    mutate: async (ns, ops, expectedRevision) => {
      calls.push({ ns, ops, expectedRevision })
      const saved = structuredClone(current)
      saved.providers['my-gateway'].models[0].reasoningEfforts = structuredClone(ops[0].value)
      return { ok: true, value: { ns, revision: expectedRevision + 1, value: saved } }
    },
  }
  const request = {
    approved: true,
    namespace: 'llm-pi-ai',
    providerId: 'my-gateway',
    credentialRef: 'MY_GATEWAY_API_KEY',
    reviewedRevision: 7,
    authenticatedCatalog: gateway,
    modelId: 'Max',
    selectedEffort: 'low',
    approvedPreview,
    settings: remote,
    ...overrides,
  }
  return { request, initial, remote, get calls() { return calls }, setCurrent: v => { current = v } }
}

test('approved Gateway effort sync writes ONLY one model field using official Host CAS', async () => {
  const f = makeAuthorizedSync()
  const baseline = JSON.stringify(f.initial)
  const result = await applyApprovedGatewayReasoningSync(f.request)
  assert.deepEqual(result, { status: 'applied', revision: 8 })
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.calls[0], {
    ns: 'llm-pi-ai', expectedRevision: 7,
    ops: [{
      op: 'set',
      path: ['providers', 'my-gateway', 'models', '0', 'reasoningEfforts'],
      value: { low: 'low', medium: 'medium', high: 'high', max: 'max' },
    }],
  })
  assert.equal(JSON.stringify(f.initial), baseline)
  assert.equal(JSON.stringify(f.calls).includes('MY_GATEWAY_API_KEY'), false,
    'write operations must not copy credentials or provider metadata')
  assert.equal(JSON.stringify(f.calls).includes('gateway.example'), false)
})

test('unapproved, invalid or stale Gateway sync never invokes Host mutation', async () => {
  for (const overrides of [
    { approved: false },
    { namespace: '' }, { providerId: '__proto__' },
    { credentialRef: '' }, { reviewedRevision: -1 },
    { modelId: 'Other' },
    { selectedEffort: 'off' },
    { reviewedRevision: 6 },
    { approvedPreview: { status: 'blocked', modelId: 'Max', reason: 'native-off-unsafe' } },
    { authenticatedCatalog: { object: 'list', data: [] } },
  ]) {
    const f = makeAuthorizedSync(overrides)
    const result = await applyApprovedGatewayReasoningSync(f.request)
    assert.equal(result.status, 'blocked', JSON.stringify(overrides))
    assert.deepEqual(f.calls, [])
  }
})

test('Gateway settings writer requires current writable Host profile and exact credential reference', async () => {
  for (const alter of [
    value => { value.providers['my-gateway'].apiKeyEnv = 'ROTATED_KEY' },
    value => { value.providers['my-gateway'].models[0].id = 'Different' },
    value => { value.providers['my-gateway'].models.push({
      id: 'Max', reasoningEfforts: { low: 'low' },
    }) },
    value => { value.providers['my-gateway'].models[0].reasoningEfforts.high = 'high' },
  ]) {
    const f = makeAuthorizedSync()
    const next = structuredClone(f.initial)
    alter(next)
    f.setCurrent(next)
    const result = await applyApprovedGatewayReasoningSync(f.request)
    assert.equal(result.status, 'blocked')
    assert.equal(f.calls.length, 0, 'stale route, key or model inventory never writes')
  }
  const f = makeAuthorizedSync()
  f.request.settings.describe = async () => ({
    ok: true, value: { writable: false, namespaces: [{
      ns: 'llm-pi-ai', revision: 7, value: f.initial,
    }] },
  })
  assert.deepEqual(await applyApprovedGatewayReasoningSync(f.request),
    { status: 'blocked', reason: 'host-readonly' })
  assert.deepEqual(f.calls, [])
})

test('official CAS conflict and invalid Host acknowledgement fail without retry', async () => {
  const conflict = makeAuthorizedSync()
  conflict.request.settings.mutate = async (ns, ops, revision) => {
    conflict.calls.push({ ns, ops, revision })
    return { ok: false, error: { code: 'settings/conflict', message: 'stale' } }
  }
  assert.deepEqual(await applyApprovedGatewayReasoningSync(conflict.request),
    { status: 'blocked', reason: 'host-conflict' })
  assert.equal(conflict.calls.length, 1)

  const unconfirmed = makeAuthorizedSync()
  unconfirmed.request.settings.mutate = async (ns, ops, revision) => {
    unconfirmed.calls.push({ ns, ops, revision })
    return { ok: true, value: { ns, revision: revision + 1, value: unconfirmed.initial } }
  }
  assert.deepEqual(await applyApprovedGatewayReasoningSync(unconfirmed.request),
    { status: 'blocked', reason: 'unverified-write' })
  assert.equal(unconfirmed.calls.length, 1)
  const missingRemote = makeAuthorizedSync()
  missingRemote.request.settings.describe = async () => { throw Error('offline') }
  assert.deepEqual(await applyApprovedGatewayReasoningSync(missingRemote.request),
    { status: 'blocked', reason: 'host-unavailable' })
  assert.deepEqual(missingRemote.calls, [])
})

// P0-2: Host Gateway discovery is deliberately inert until a documented
// credential-free Host request proxy exists. Pure mapping and CAS functions
// above remain tested independently; no HTTP, credential or route is allowed.
function hostGatewayFixture(options = {}) {
  const effects = { injected: 0, credentials: 0, settings: 0, routes: 0, network: 0 }
  const settings = { writable: true, describe: () => [],
    mutate: async () => { effects.settings++ },
  }
  const services = {
    settings,
    credentials: { resolve: async () => {
      effects.credentials++
      return { value: 'UNSAFE_INTERNAL_TEST_KEY' }
    } },
    llm: { listConfigurableProviders: () => [] },
    connection: { fetch: { register: () => {
      effects.routes++
      return () => {}
    } } },
  }
  const context = { inject: (_deps, callback) => {
    effects.injected++
    callback(services)
    return () => {}
  } }
  const stop = installHostGatewayEffortSync(context, {
    fetch: async () => {
      effects.network++
      throw Error('no Host Gateway request allowed')
    }, ...options,
  })
  return { effects, settings, services, context, stop }
}
function assertFailClosed(f) {
  assert.equal(typeof f.stop, 'function')
  assert.deepEqual(f.effects, {
    injected: 0, credentials: 0, settings: 0, routes: 0, network: 0,
  }, 'unverified Host integration must have no side effects')
}

test('Gateway Host does not register preview or apply routes without a public request proxy', () => {
  const f = hostGatewayFixture()
  assert.equal(DELTA_GATEWAY_EFFORT_PREVIEW_PATH, '/api/delta-suite/gateway-effort/preview')
  assert.equal(DELTA_GATEWAY_EFFORT_APPLY_PATH, '/api/delta-suite/gateway-effort/apply')
  assertFailClosed(f)
  f.stop()
  assertFailClosed(f)
})

test('Gateway Host cannot resolve bearer credentials or mutate settings while disabled', () => {
  const f = hostGatewayFixture()
  assertFailClosed(f)
  f.stop()
  assert.equal(f.effects.credentials, 0)
  assert.equal(f.effects.settings, 0)
})

test('Gateway Host declines unavailable contexts rather than inventing a route', () => {
  for (const context of [null, undefined, {}, { inject() {
    throw Error('unverified injection')
  } }]) {
    const stop = installHostGatewayEffortSync(context)
    assert.equal(typeof stop, 'function')
    assert.doesNotThrow(() => { stop(); stop() })
  }
})

test('Gateway Host never performs HTTP discovery even when transport is supplied', () => {
  let calls = 0
  const f = hostGatewayFixture({ fetch: async () => { calls++; throw Error('unexpected HTTP') } })
  assertFailClosed(f)
  assert.equal(calls, 0)
  f.stop()
})

test('Gateway Host cannot manufacture preview grants for unsafe models or Off', () => {
  const f = hostGatewayFixture()
  assertFailClosed(f)
  const hostSource = readTargetText('packages', 'delta-suite', 'src', 'host-gateway-effort.ts')
  assert.equal(hostSource.includes('registry.register('), false)
  assert.equal(hostSource.includes('drafts.set('), false)
  assert.equal(hostSource.includes('authorization: '), false)
  f.stop()
})

test('Gateway Host unmount and repeated mounts never restore an unapproved service', () => {
  const first = hostGatewayFixture()
  assert.doesNotThrow(() => { first.stop(); first.stop() })
  assertFailClosed(first)
  const second = hostGatewayFixture()
  assertFailClosed(second)
  second.stop()
})

test('Gateway Host leaves native settings and service capabilities unchanged', () => {
  const f = hostGatewayFixture()
  const settings = f.services.settings
  const credentials = f.services.credentials
  assertFailClosed(f)
  assert.strictEqual(f.services.settings, settings)
  assert.strictEqual(f.services.credentials, credentials)
  f.stop()
  assertFailClosed(f)
})
