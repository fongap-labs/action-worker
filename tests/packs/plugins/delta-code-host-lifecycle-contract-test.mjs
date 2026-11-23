import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerCodingSkills } from '#target/packages/delta-code/lib/delta-code-adapter/providers/dsh/skills.js'
import { registerDeltaCodePrompt } from '#target/packages/delta-code/lib/delta-code-adapter/providers/dsh/prompt.js'
import { registerAutomaticCodingRouter } from '#target/packages/delta-code/lib/delta-code-adapter/providers/dsh/auto-routing.js'
import { deltaCodeStrategy } from '#target/packages/delta-code/lib/delta-code-strategy/index.js'
import { mountDeltaCodeFeatures } from '#target/packages/delta-code/lib/delta-code-kernel/feature.js'

function createDeferredHost() {
  const injected = new Map()
  const warnings = []
  return {
    ctx: {
      inject(services, callback) {
        const key = services.join(',')
        const list = injected.get(key) ?? []
        list.push(callback)
        injected.set(key, list)
      },
      logger: { warn(message) { warnings.push(message) } },
    },
    emit(services, child) {
      for (const callback of injected.get(services) ?? []) callback(child)
    },
    warnings,
  }
}

test('Host Skill provider is lazy, uses reviewed metadata, and unloads after disposal', async () => {
  const host = createDeferredHost()
  let installs = 0
  let uninstalls = 0
  const controller = new AbortController()
  let provider
  const registry = {
    registerProvider(create) {
      installs++
      provider = create({
        signal: controller.signal,
        invalidate() { controller.abort() },
      })
      return () => { uninstalls++; controller.abort() }
    },
  }
  const dispose = registerCodingSkills(host.ctx)
  host.emit('skills', { skills: registry })
  host.emit('skills', { skills: registry })
  assert.equal(installs, 1, 'same Host registry must be registered only once')
  const summaries = await provider.list()
  assert.ok(summaries.some(entry => entry.name === 'code-quality-strength'))
  assert.ok(summaries.some(entry => entry.name === 'code-diagnostic-readiness'))
  assert.ok(summaries.every(entry => !('content' in entry)),
    'discovery must not load Skill bodies into a prompt')
  const candidate = summaries.find(entry => entry.name === 'code-quality-strength')
  assert.equal(candidate.provider, 'delta-code-coding')
  assert.ok((await provider.get(candidate)).content.includes('test'))
  assert.equal(await provider.get({ ...candidate, provider: 'untrusted' }), undefined)
  assert.equal(await provider.get({ ...candidate, locator: 'different' }), undefined)
  const rejected = new AbortController()
  rejected.abort()
  await assert.rejects(() => provider.get(candidate, { signal: rejected.signal }), /abort/i)
  dispose()
  dispose()
  assert.equal(uninstalls, 1, 'teardown is idempotent')
  assert.deepEqual(await provider.list(), [], 'released provider is never discoverable')
  assert.equal(await provider.get(candidate), undefined, 'released Skill bodies are not callable')
  host.emit('skills', { skills: { registerProvider() { installs++ } } })
  assert.equal(installs, 1, 'late injection cannot reactivate a released plugin')
})

test('Host without disposable native Skill registration fails closed', async () => {
  const host = createDeferredHost()
  let invalidates = 0
  let provider
  const release = registerCodingSkills(host.ctx)
  host.emit('skills', { skills: {
    registerProvider(create) {
      provider = create({ signal: new AbortController().signal, invalidate() { invalidates++ } })
      return undefined
    },
  } })
  assert.equal(invalidates, 1)
  assert.deepEqual(await provider.list(), [])
  assert.equal(await provider.get({
    name: 'code-quality-strength', locator: 'code-quality-strength', provider: 'delta-code-coding',
  }), undefined)
  assert.match(host.warnings.join('\n'), /no disposer/)
  release()
})

test('native Prompt section is released and never installed after teardown', () => {
  const host = createDeferredHost()
  const registered = []
  let released = 0
  const stop = registerDeltaCodePrompt(host.ctx, { systemPromptText: '' })
  host.emit('systemPrompt', { systemPrompt: {
    getSectionOrder() { return 1300 },
    section(value) {
      registered.push(value)
      return () => { released++ }
    },
  } })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'delta-code:guidance')
  assert.match(registered[0].text, /code_capabilities/)
  stop()
  stop()
  assert.equal(released, 1)
  host.emit('systemPrompt', { systemPrompt: {
    section() { throw new Error('must not register after stop') },
  } })
})

test('native inbox route hints and Host subscriptions are disposed without extra Agent', () => {
  const host = createDeferredHost()
  const listeners = new Map()
  const registrations = []
  let promptEntry
  const ctx = {
    ...host.ctx,
    on(name, listener) {
      listeners.set(name, listener)
      return () => { if (listeners.get(name) === listener) listeners.delete(name) }
    },
    inject(services, callback) {
      registrations.push(services.join(','))
      if (services.join(',') === 'systemPrompt') callback({
        systemPrompt: {
          context(entry) {
            promptEntry = entry
            return () => { promptEntry = undefined }
          },
        },
      })
    },
  }
  const stop = registerAutomaticCodingRouter(ctx, () => ({
    enabled: true, autoRoutingEnabled: true,
  }))
  assert.equal(registrations.filter(x => x === 'systemPrompt').length, 1)
  assert.equal(typeof listeners.get('agent/inbox/claimed'), 'function')
  assert.equal(typeof listeners.get('agent/disposed'), 'function')
  const agent = {}
  listeners.get('agent/inbox/claimed')({
    agent, message: { source: { kind: 'user' },
      content: [{ type: 'text', text: 'fix GitHub Actions CI failure' }] },
  })
  const prompt = promptEntry.text({ agent })
  assert.match(prompt, /Code Worker/)
  assert.doesNotMatch(prompt, /GitHub Actions CI failure/,
    'never copy untrusted user text into a persistent system prompt')
  stop()
  stop()
  assert.equal(promptEntry, undefined)
  assert.equal(listeners.size, 0, 'all event subscriptions must be released')
})

test('Strategy mounts declared readonly tools and disposes in reverse order', async () => {
  const events = []
  const strategy = deltaCodeStrategy({
    taskContext: { read() { return undefined } },
    registerSkills() { events.push('skills:on'); return () => events.push('skills:off') },
    registerRouter() { events.push('router:on'); return () => events.push('router:off') },
    registerPrompt() { events.push('prompt:on'); return () => events.push('prompt:off') },
  })
  const mounted = []
  const stop = mountDeltaCodeFeatures([strategy], {
    register(tool) {
      mounted.push(tool)
      events.push(tool.name + ':on')
      return () => events.push(tool.name + ':off')
    },
  })
  const toolNames = strategy.tools.map(tool => tool.name)
  assert.deepEqual(mounted.map(tool => tool.name), toolNames)
  assert.equal(new Set(toolNames).size, toolNames.length)
  assert.ok(toolNames.includes('code_workflow_route'))
  assert.ok(toolNames.includes('code_capabilities'))
  const catalog = await mounted.find(t => t.name === 'code_capabilities').execute({ action: 'list' })
  assert.ok(catalog.capabilities.length > 0)
  assert.deepEqual(catalog.skills, [])
  stop()
  stop()
  assert.deepEqual(events, [
    ...toolNames.map(name => name + ':on'),
    'skills:on', 'router:on', 'prompt:on',
    'prompt:off', 'router:off', 'skills:off',
    ...[...toolNames].reverse().map(name => name + ':off'),
  ])
})

test('Strategy activation failure rolls back tools and all earlier Host effects', () => {
  const events = []
  const strategy = deltaCodeStrategy({
    taskContext: { read() { return undefined } },
    registerSkills() { events.push('skills:on'); return () => events.push('skills:off') },
    registerRouter() { events.push('router:on'); return () => events.push('router:off') },
    registerPrompt() { throw new Error('Host prompt registration refused') },
  })
  const toolNames = strategy.tools.map(tool => tool.name)
  assert.throws(() => mountDeltaCodeFeatures([strategy], {
    register(tool) {
      events.push(tool.name + ':on')
      return () => events.push(tool.name + ':off')
    },
  }), /Host prompt registration refused/)
  assert.deepEqual(events, [
    ...toolNames.map(name => name + ':on'),
    'skills:on', 'router:on', 'router:off', 'skills:off',
    ...[...toolNames].reverse().map(name => name + ':off'),
  ])
})
