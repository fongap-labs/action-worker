import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readTargetText } from '../../kit/contract.mjs'
import {
  decodeGatewayReasoningCatalog,
  toHarnessReasoningEfforts,
  mapGatewayReasoningChoice,
  previewGatewayReasoningSync,
} from '#target/packages/dsh-delta-suite/lib/delta-suite-adapter/gateway-reasoning.js'
import { applyApprovedGatewayReasoningSync } from '#target/packages/dsh-delta-suite/lib/delta-suite-adapter/gateway-reasoning-apply.js'
import { installHostGatewayEffortSync, DELTA_GATEWAY_EFFORT_PREVIEW_PATH, DELTA_GATEWAY_EFFORT_APPLY_PATH } from '#target/packages/dsh-delta-suite/lib/host-gateway-effort.js'

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

function hostGatewayFixture(options = {}) {
  const routes = new Map()
  const calls = []
  const network = []
  let credential = 'INTERNAL_TEST_KEY_NEVER_EXPOSE'
  let revision = 4
  let value = { providers: { 'my-gateway': {
    baseURL: 'https://gateway.example/v1',
    api: 'openai-completions',
    apiKeyEnv: 'MY_GATEWAY_API_KEY',
    models: [{ id: 'Max', name: 'Keep name', reasoningEfforts: { low: 'low' } },
      { id: 'General', input: ['text'] }],
  } } }
  const services = {
    settings: {
      writable: true,
      describe: () => [{ ns: 'llm-pi-ai', revision, value: structuredClone(value) }],
      mutate: async (ns, ops, expected) => {
        calls.push({ ns, ops, expected })
        assert.equal(ns, 'llm-pi-ai')
        if (expected !== revision) throw Object.assign(Error('stale'), { code: 'SETTINGS_CONFLICT' })
        assert.equal(ops.length, 1)
        const [provider, index] = [ops[0].path[1], Number(ops[0].path[3])]
        value.providers[provider].models[index].reasoningEfforts = structuredClone(ops[0].value)
        revision++
      },
    },
    credentials: {
      resolve: async ref => ref === 'MY_GATEWAY_API_KEY' ? { value: credential } : undefined,
    },
    llm: {
      listConfigurableProviders: () => [{
        provider: 'my-gateway', settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'my-gateway'],
      }],
    },
    connection: {
      fetch: { register(spec) { routes.set(spec.path, spec); return () => routes.delete(spec.path) } },
    },
  }
  const fetcher = options.fetch ?? (async (url, init) => {
    network.push({ url, redirect: init.redirect, cache: init.cache, method: init.method,
      auth: init.headers.authorization })
    return new Response(JSON.stringify(gateway), { status: 200, headers: {
      'content-type': 'application/json',
    } })
  })
  const stop = installHostGatewayEffortSync({
    inject(deps, callback) {
      assert.deepEqual(deps, ['settings', 'credentials', 'llm', 'connection'])
      return callback(services)
    },
  }, { fetch: fetcher, ...options })
  const send = async (path, body, headers = {}) => {
    const route = routes.get(path)
    assert.ok(route, 'the declared Host fetch route must exist')
    assert.deepEqual(route.methods, ['POST'])
    const request = new Request('http://127.0.0.1' + path, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    const response = await route.fetch(request)
    return { code: response.status, data: await response.json() }
  }
  const preview = () => send(DELTA_GATEWAY_EFFORT_PREVIEW_PATH, {
    namespace: 'llm-pi-ai', providerId: 'my-gateway', modelId: 'Max',
    selectedEffort: 'low',
  })
  const apply = previewId => send(DELTA_GATEWAY_EFFORT_APPLY_PATH, {
    previewId, approved: true,
  })
  return {
    routes, calls, network, services, stop, send, preview, apply,
    setCredential: next => { credential = next },
    setRevision: next => { revision = next },
    setProvider: change => { const next = structuredClone(value); change(next.providers['my-gateway']); value = next },
    get value() { return value },
  }
}

test('Gateway Host preview discovers ONLY on user action and commits via official Settings CAS', async () => {
  const f = hostGatewayFixture()
  assert.equal(f.network.length, 0, 'mounting a plugin must not probe an endpoint')
  const p = await f.preview()
  assert.equal(p.code, 200)
  assert.equal(p.data.status, 'review')
  assert.equal(p.data.preview.modelId, 'Max')
  assert.deepEqual(p.data.preview.added, ['medium', 'high', 'max'])
  assert.deepEqual(p.data.preview.removed, [])
  assert.equal(p.data.previewId.length, 48)
  assert.deepEqual(f.network.map(({ url, redirect, cache, method }) =>
    ({ url, redirect, cache, method })), [{
      url: 'https://gateway.example/v1/models', redirect: 'error',
      cache: 'no-store', method: 'GET',
    }])
  assert.equal(f.network[0].auth, 'Bearer INTERNAL_TEST_KEY_NEVER_EXPOSE')
  assert.equal(JSON.stringify(p.data).includes('INTERNAL_TEST_KEY_NEVER_EXPOSE'), false)
  assert.equal(JSON.stringify(p.data).includes('MY_GATEWAY_API_KEY'), false)
  const written = await f.apply(p.data.previewId)
  assert.equal(written.code, 200)
  assert.deepEqual(written.data, { ok: true, status: 'applied', revision: 5 })
  assert.deepEqual(f.calls, [{
    ns: 'llm-pi-ai', expected: 4, ops: [{
      op: 'set', path: ['providers', 'my-gateway', 'models', '0', 'reasoningEfforts'],
      value: { low: 'low', medium: 'medium', high: 'high', max: 'max' },
    }],
  }])
  assert.equal(f.value.providers['my-gateway'].models[0].name, 'Keep name')
  assert.deepEqual(f.value.providers['my-gateway'].models[1], { id: 'General', input: ['text'] })
  assert.equal(f.network.length, 1, 'approval never repeats a Gateway network request')
  const replay = await f.apply(p.data.previewId)
  assert.equal(replay.code, 409)
  assert.equal(replay.data.reason, 'expired-preview')
  assert.equal(f.calls.length, 1)
  f.stop()
  assert.equal(f.routes.size, 0)
})

test('Gateway Host prevents stale, rotated and unapproved writes', async () => {
  for (const mutate of [
    f => f.setCredential('ROTATED_KEY'),
    f => f.setRevision(5),
    f => f.setProvider(p => { p.models[0].id = 'Different' }),
    f => f.setProvider(p => { p.apiKeyEnv = 'OTHER_REFERENCE' }),
  ]) {
    const f = hostGatewayFixture()
    const p = await f.preview()
    assert.equal(p.code, 200)
    mutate(f)
    const result = await f.apply(p.data.previewId)
    assert.equal(result.code, 409)
    assert.equal(f.calls.length, 0)
    f.stop()
  }
  const f = hostGatewayFixture()
  const p = await f.preview()
  const notApproved = await f.send(DELTA_GATEWAY_EFFORT_APPLY_PATH, {
    previewId: p.data.previewId, approved: false,
  })
  assert.equal(notApproved.code, 400)
  assert.equal(f.calls.length, 0)
  f.stop()
})

test('Gateway Host refuses unsafe routes, unknown models, cross-site calls and Off', async () => {
  const f = hostGatewayFixture()
  const foreign = await f.send(DELTA_GATEWAY_EFFORT_PREVIEW_PATH, {
    namespace: 'llm-pi-ai', providerId: 'my-gateway', modelId: 'Max',
    selectedEffort: 'low',
  }, { origin: 'https://foreign.example' })
  assert.equal(foreign.code, 400)
  assert.equal(f.network.length, 0)
  const off = await f.send(DELTA_GATEWAY_EFFORT_PREVIEW_PATH, {
    namespace: 'llm-pi-ai', providerId: 'my-gateway', modelId: 'Max',
    selectedEffort: 'off',
  })
  assert.equal(off.code, 409)
  assert.equal(off.data.reason, 'native-off-unsafe')
  const wrong = await f.send(DELTA_GATEWAY_EFFORT_PREVIEW_PATH, {
    namespace: 'llm-pi-ai', providerId: '__proto__', modelId: 'Max',
    selectedEffort: 'low',
  })
  assert.equal(wrong.code, 400)
  for (const baseURL of [
    'http://gateway.example/v1', 'https://127.0.0.1/v1',
    'https://localhost/v1', 'https://user:pass' + String.fromCharCode(64) + 'gateway.example/v1',
    'https://gateway.example:8443/v1',
  ]) {
    f.setProvider(p => { p.baseURL = baseURL })
    const result = await f.preview()
    assert.equal(result.code, 400)
    assert.equal(result.data.reason, 'unsafe-endpoint')
  }
  assert.equal(f.calls.length, 0)
  f.stop()
})

test('Gateway Host detects credential replacement during discovery and never stores secret tokens', async () => {
  let fixture
  fixture = hostGatewayFixture({ fetch: async () => {
    fixture.setCredential('NEW_KEY_AFTER_FETCH')
    return new Response(JSON.stringify(gateway), { status: 200 })
  } })
  const p = await fixture.preview()
  assert.equal(p.code, 409)
  assert.equal(p.data.reason, 'credential-changed')
  assert.equal(fixture.calls.length, 0)
  fixture.stop()

  let currentTime = 1_000
  const expiring = hostGatewayFixture({ now: () => currentTime })
  const allowed = await expiring.preview()
  currentTime += 120_001
  const denied = await expiring.apply(allowed.data.previewId)
  assert.equal(denied.code, 409)
  assert.equal(denied.data.reason, 'expired-preview')
  assert.equal(expiring.calls.length, 0)
  expiring.stop()
})
