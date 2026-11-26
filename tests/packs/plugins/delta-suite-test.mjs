import { test, assert } from '../../kit/harness.mjs'
import { targetPath } from '../../kit/target.mjs'
import { existsSync } from 'node:fs'

const migrationPresent = existsSync(targetPath('packages/delta-ui/package.json'))

function response(body, status = 200, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function runtime(bridge, config = {}) {
  return bridge.createRuntime(config, {
    fetch: async () => response({ data: [] }),
    credentials: { resolve: async () => 'secret' },
  })
}

test('Delta Suite normalizes independent modules and refuses unauthenticated external exposure', {
  skip: migrationPresent ? false : 'Delta UI / Delta Suite product migration is not present in this target revision',
}, async () => {
  const bridge = await import('#target/packages/delta-suite/lib/index.js')
  const config = bridge.normalizeConfig({ modules: { capabilityProbe: true } })
  assert.equal(config.modules.capabilityProbe, true)
  assert.equal(config.modules.behaviorEnhancement, true)
  assert.equal(config.behavior.enabled, true)
  assert.equal(config.permissions.localApi, true)
  assert.equal(config.api.exposeExternally, false)
  assert.throws(() => bridge.normalizeConfig({ api: { exposeExternally: true } }), /authenticated public route contract/)
  assert.throws(() => bridge.normalizeConfig({ providers: [{ id: 'bad', kind: 'custom-api', enabled: true }] }), /endpoint is required/)
})

test('Core pipeline composes provider-independent capabilities and exposes runtime status', {
  skip: migrationPresent ? false : 'Delta UI / Delta Suite product migration is not present in this target revision',
}, async () => {
  const bridge = await import('#target/packages/delta-suite/lib/index.js')
  const r = runtime(bridge)
  const applied = []
  r.capabilities.register({
    id: 'test-transform', version: '1', description: 'test', inputModalities: ['text'], priority: 20,
    canHandle() { return true },
    async invoke({ messages }) {
      applied.push('test-transform')
      return { messages: [{ role: 'system', content: 'extra rule' }, ...messages], metadata: { test: true } }
    },
  })
  const result = await r.pipeline.prepare({
    model: { id: 'custom/text', upstreamId: 'text', providerId: 'custom', providerKind: 'custom-api', status: 'available', service: 'unknown', protocols: [], capabilities: {}, source: 'metadata', updatedAt: 1 },
    request: { model: 'text', messages: [{ role: 'user', content: 'hello' }] },
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.deepEqual(applied, ['test-transform'])
  assert.equal(result.messages[0].role, 'system')
  assert.equal(result.metadata.test, true)

  const session = await bridge.start({ modules: { modelDiscovery: false, apiService: false }, discovery: { refreshOnStart: false } })
  const status = session.runtime.status.snapshot()
  assert.equal(status.modules.find(item => item.id === 'core').state, 'running')
  assert.ok(status.capabilities.some(item => item.id === 'model-instructions'))
  assert.ok(status.capabilities.some(item => item.id === 'vision-evidence'))
  const instructed = await session.runtime.pipeline.prepare({
    model: { id: 'custom/text', upstreamId: 'text', providerId: 'custom', providerKind: 'custom-api', status: 'available', service: 'unknown', protocols: [], capabilities: {}, source: 'metadata', updatedAt: 2 },
    request: { model: 'text', messages: [{ role: 'user', content: 'follow this' }] },
    messages: [{ role: 'user', content: 'follow this' }],
  })
  assert.match(instructed.messages[0].content, /delta-suite-instructions/)
  session.dispose()
})

test('OpenAI-compatible discovery preserves metadata and never guesses capabilities from model names', {
  skip: migrationPresent ? false : 'Delta UI / Delta Suite product migration is not present in this target revision',
}, async () => {
  const { OpenAICompatibleProvider } = await import('#target/packages/delta-suite/lib/providers/openai-compatible.js')
  const { toModelRecord } = await import('#target/packages/delta-suite/lib/discovery/model-discovery.js')
  const calls = []
  const provider = new OpenAICompatibleProvider({
    id: 'custom', kind: 'custom-api', endpoint: 'https://example.invalid/v1',
    auth: { mode: 'host-secret', credentialRef: 'key' },
  }, {
    credentials: { resolve: async ref => ref === 'key' ? 'secret' : undefined },
    fetch: async (url, init) => {
      calls.push({ url, init })
      return response({ data: [
        { id: 'vision', input_modalities: ['text', 'image'], context_length: 32000 },
        { id: 'reasoning-text' },
      ] })
    },
  })
  const models = await provider.listModels()
  assert.equal(models.length, 2)
  assert.equal(models[0].capabilities.input.image, true)
  assert.equal(toModelRecord(provider, models[1]).capabilities.input.image, 'unknown')
  assert.equal(calls[0].url, 'https://example.invalid/v1/models')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret')
})

test('OpenAI-compatible chat is non-retrying for POST and supports bounded SSE streams', {
  skip: migrationPresent ? false : 'Delta UI / Delta Suite product migration is not present in this target revision',
}, async () => {
  const { OpenAICompatibleProvider } = await import('#target/packages/delta-suite/lib/providers/openai-compatible.js')
  let posts = 0
  const provider = new OpenAICompatibleProvider({
    id: 'custom', kind: 'custom-api', endpoint: 'https://example.invalid/v1',
  }, {
    credentials: { resolve: async () => undefined },
    fetch: async (_url, init) => {
      if (init.method === 'POST') {
        posts += 1
        return response({ id: 'chat-1', model: 'm', choices: [{ message: { role: 'assistant', content: 'ok' } }] })
      }
      return response({ data: [] })
    },
  })
  const result = await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(result.choices[0].message.content, 'ok')
  assert.equal(posts, 1)

  const streamProvider = new OpenAICompatibleProvider({ id: 'stream', kind: 'custom-api', endpoint: 'https://example.invalid/v1' }, {
    credentials: { resolve: async () => undefined },
    fetch: async () => new Response(
      'data: {"id":"s","model":"m","choices":[{"delta":{"content":"a"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  })
  const chunks = []
  for await (const chunk of streamProvider.streamChat({ model: 'm', messages: [] })) chunks.push(chunk)
  assert.equal(chunks[0].choices[0].delta.content, 'a')
})

test('vision bridge intervenes for unknown capabilities and preserves explicitly native multimodal models', {
  skip: migrationPresent ? false : 'Delta UI / Delta Suite product migration is not present in this target revision',
}, async () => {
  const { VisionBridge } = await import('#target/packages/delta-suite/lib/vision/vision-bridge.js')
  const bridge = await import('#target/packages/delta-suite/lib/index.js')
  const r = runtime(bridge)
  const calls = []
  const provider = {
    id: 'vision-provider', kind: 'custom-api',
    async listModels() { return [] },
    async chat(request) {
      calls.push(request)
      return { id: 'v', model: request.model, choices: [{ message: { role: 'assistant', content: JSON.stringify({ observations: { ocr: ['hello'] }, inferences: [], uncertainties: [] }) } }] }
    },
    async *streamChat() {},
  }
  r.providers.set(provider.id, provider)
  r.models.registerModel({
    id: 'vision-provider/vision', upstreamId: 'vision', providerId: provider.id, providerKind: 'custom-api',
    status: 'available', service: 'free', protocols: ['openai-compatible'],
    capabilities: { input: { image: true } }, source: 'metadata', updatedAt: 1,
  })
  const vision = new VisionBridge(r)
  const unknownTarget = { id: 'custom/text', upstreamId: 'text', providerId: 'custom', providerKind: 'custom-api', status: 'available', service: 'unknown', protocols: [], capabilities: {}, source: 'metadata', updatedAt: 2 }
  const prepared = await vision.prepareMessages(unknownTarget, [{ role: 'user', content: [
    { type: 'text', text: 'Read this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
  ] }])
  assert.match(prepared[0].content, /delta-suite-vision-evidence/)
  assert.equal(calls.length, 1)
  const nativeTarget = { ...unknownTarget, capabilities: { input: { image: true } } }
  const native = await vision.prepareMessages(nativeTarget, [{ role: 'user', content: [
    { type: 'text', text: 'Keep native' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,def' } },
  ] }])
  assert.equal(native[0].content[1].image_url.url, 'data:image/png;base64,def')
  assert.equal(calls.length, 1)
})

test('module lifecycle isolates failures and disposes resources in reverse order', {
  skip: migrationPresent ? false : 'Delta UI / Delta Suite product migration is not present in this target revision',
}, async () => {
  const { ModuleManager } = await import('#target/packages/delta-suite/lib/core/lifecycle.js')
  const bridge = await import('#target/packages/delta-suite/lib/index.js')
  const manager = new ModuleManager()
  const disposed = []
  manager.register({ id: 'one', version: '1', capabilities: [], start() { return () => disposed.push('one') } })
  manager.register({ id: 'broken', version: '1', dependencies: ['one'], capabilities: [], start() { throw new Error('boom') } })
  manager.register({ id: 'two', version: '1', dependencies: ['one'], capabilities: [], start() { return () => disposed.push('two') } })
  await manager.startAll(runtime(bridge))
  assert.equal(manager.snapshots().find(item => item.id === 'broken').state, 'failed')
  assert.equal(manager.snapshots().find(item => item.id === 'two').state, 'running')
  manager.stopAll(runtime(bridge))
  assert.deepEqual(disposed, ['two', 'one'])
})

test('in-process API exposes discovered model routes and Host route registration is disposable', {
  skip: migrationPresent ? false : 'Delta UI / Delta Suite product migration is not present in this target revision',
}, async () => {
  const bridge = await import('#target/packages/delta-suite/lib/index.js')
  const r = runtime(bridge)
  const provider = {
    id: 'custom', kind: 'custom-api',
    async listModels() { return [] },
    async chat(request) { return { id: 'c', model: request.model, choices: [{ message: { role: 'assistant', content: 'answer' } }] } },
    async *streamChat() {},
  }
  r.providers.set(provider.id, provider)
  r.models.registerModel({
    id: 'custom/model', upstreamId: 'model', providerId: 'custom', providerKind: 'custom-api',
    status: 'available', service: 'unknown', protocols: ['openai-compatible'],
    capabilities: { input: { image: false } }, source: 'metadata', updatedAt: 3,
  })
  const api = new bridge.OpenAICompatibleApi(r)
  const models = await api.dispatch('/delta-suite/v1/models', 'GET')
  assert.equal(models.json.data[0].id, 'custom/model')
  const completion = await api.dispatch('/delta-suite/v1/chat/completions', 'POST', {
    model: 'custom/model', messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(completion.json.choices[0].message.content, 'answer')
  const status = await api.dispatch('/delta-suite/v1/status', 'GET')
  assert.equal(status.json.object, 'delta-suite-status')
  assert.equal(status.json.providers[0].id, 'custom')

  const routes = []
  const cleanups = []
  const dispose = bridge.apply({
    inject(_dependencies, callback) {
      return callback({ webServer: { register(route) { routes.push(route); return () => routes.splice(routes.indexOf(route), 1) } } })
    },
    effect(effect) { cleanups.push(effect()) },
    fetch: async () => response({ data: [] }),
  }, { discovery: { refreshOnStart: false } })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(routes.map(route => route.path), ['/delta-suite/v1/models', '/delta-suite/v1/status', '/delta-suite/v1/chat/completions'])
  dispose()
  assert.equal(routes.length, 0)
})
