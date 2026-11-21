import test from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { readTargetJson, readTargetText } from '../../kit/contract.mjs'

const base = ['packages', 'dsh-delta-desktop']
const source = readTargetText(...base, 'src', 'client.js')

function loadClient() {
  const loaded = []
  const errors = []
  runInNewContext(source, {
    globalThis: { __ModuleLoader__: { load(entry) { loaded.push(entry) } } },
    console: { error(...args) { errors.push(args) } },
  }, { timeout: 1500, filename: 'dsh-delta-desktop/src/client.js' })
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, '@fongap-labs/dsh-delta-desktop')
  return { entry: loaded[0], errors }
}

function reactStub(state = []) {
  let cursor = 0
  return {
    reset() { cursor = 0 },
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useState(initial) {
      const index = cursor++
      if (index >= state.length) state[index] = initial
      return [state[index], next => {
        state[index] = typeof next === 'function' ? next(state[index]) : next
      }]
    },
    useEffect() {},
    useSyncExternalStore(_subscribe, get) { return get() },
  }
}
function find(node, predicate, result = []) {
  if (Array.isArray(node)) { for (const item of node) find(item, predicate, result); return result }
  if (!node || typeof node !== 'object') return result
  if (predicate(node)) result.push(node)
  if (node.children) find(node.children, predicate, result)
  return result
}

test('Desktop is an independent published Cordis plugin and default patch preserves native UI', () => {
  const pkg = readTargetJson(...base, 'package.json')
  assert.equal(pkg.name, '@fongap-labs/dsh-delta-desktop')
  assert.equal(pkg.version, '0.0.0')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  for (const name of ['@fongap-labs/dsh-delta-suite', '@fongap-labs/dsh-delta-code']) {
    assert.equal(pkg.dependencies?.[name], undefined)
    assert.equal(pkg.peerDependencies?.[name], undefined)
    assert.ok(!(pkg.bundleDependencies ?? []).includes(name))
  }
  assert.equal(pkg.exports['.'].default, './src/index.js')
  assert.equal(pkg.exports['./client'], './src/client.js')
  assert.ok(pkg.files.includes('src/**/*.js'))
  assert.match(readTargetText(...base, 'src', 'index.js'), /export function apply\(/)
  const patch = readTargetText(...base, 'cordis.patch.yml')
  assert.match(patch, /dsh-delta-desktop/)
  assert.doesNotMatch(patch, /disabled:\s*true/)
})

test('Harness Client registers one disposable Root and reuses one Session service', async () => {
  const { entry, errors } = loadClient()
  const react = reactStub()
  const plugin = entry.factory(name => { assert.equal(name, 'react'); return react })
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'sessions'])
  let refreshed = 0
  let unregistered = 0
  const registered = []
  let dispose
  plugin.apply({
    sessions: {
      list: { subscribe() { return () => {} }, getSnapshot() { return { ids: [], byId: {} } } },
      refresh() { refreshed++; return Promise.resolve() },
    },
    slots: { register(options, component) {
      registered.push({ options, component })
      return () => { unregistered++ }
    } },
    effect(mount) { dispose = mount() },
  })
  await Promise.resolve()
  assert.equal(refreshed, 1)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.name, 'root')
  const element = registered[0].component()
  assert.equal(typeof element.type, 'function')
  const view = element.type(element.props)
  assert.equal(view.type, 'main')
  assert.equal(view.props['data-delta-desktop-root'], '1')
  assert.equal(typeof dispose, 'function')
  dispose()
  assert.equal(unregistered, 1)
  assert.deepEqual(errors, [])
})

test('Committed reply renders, transient chunks and tool metadata do not; prompt uses Harness Session', async () => {
  const { entry } = loadClient()
  const sent = []
  const binding = {
    sessionId: 'session-1',
    eventSource: {
      subscribe() { return () => {} },
      getSnapshot() { return { entries: [
        { type: 'event', event: { seq: 1, type: 'user/message', data: {
          content: [{ type: 'text', text: 'hello' }],
        } } },
        { type: 'event', event: { seq: 2, type: 'assistant/message', data: {
          message: { content: [{ type: 'text', text: 'PASS' }] }, stream: 'RAW_STREAM_SECRET',
        } } },
        { type: 'event', event: { seq: 3, type: 'tool/call', data: {
          metadata: { secret: 'DO_NOT_LEAK' },
        } } },
        { type: 'transient', event: { seq: 4, type: 'assistant/message',
          data: { message: { content: 'UNCOMMITTED' } } } },
      ] } },
    },
    session: {
      subscribe() { return () => {} },
      getSnapshot() { return { running: false } },
      prompt(content, mode) { sent.push({ content, mode }); return Promise.resolve({ ok: true }) },
    },
  }
  const react = reactStub(['session-1', binding, 'prompt', false, ''])
  const plugin = entry.factory(() => react)
  let render
  let created = 0
  plugin.apply({
    sessions: {
      list: {
        subscribe() { return () => {} },
        getSnapshot() { return { ids: ['session-1'],
          byId: { 'session-1': { displayTitle: 'Test Session' } } } },
      },
      refresh() { return Promise.resolve() },
      create() { created++; return Promise.resolve('session-2') },
    },
    slots: { register(_options, component) { render = component; return () => {} } },
    effect(fn) { fn() },
  })
  react.reset()
  const element = render()
  const view = element.type(element.props)
  const log = find(view, node => node.props?.role === 'log')
  assert.equal(log.length, 1)
  const text = JSON.stringify(log[0])
  assert.match(text, /hello/)
  assert.match(text, /PASS/)
  assert.doesNotMatch(text, /RAW_STREAM_SECRET|DO_NOT_LEAK|UNCOMMITTED/)
  const send = find(view, node => node.type === 'button' && node.children?.includes('Send'))[0]
  assert.equal(typeof send?.props?.onClick, 'function')
  send.props.onClick()
  await Promise.resolve()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].mode, 'queue')
  assert.equal(sent[0].content[0].text, 'prompt')
  const create = find(view, node => node.type === 'button'
    && node.children?.includes('+ New session'))[0]
  create.props.onClick()
  await Promise.resolve()
  assert.equal(created, 1)
})
