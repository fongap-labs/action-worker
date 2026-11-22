/** Trusted Playwright MCP integration smoke: synthetic loopback site, no user data. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const deadlineMs = 40_000
const packageRequire = createRequire(pathToFileURL(resolve(
  'packages/experimental/browser-use-playwright-mcp/package.json',
)))
const cliPath = join(dirname(packageRequire.resolve('@playwright/mcp/package.json')), 'cli.js')
assert.ok(existsSync(cliPath), 'Pinned Playwright MCP CLI is missing')
const browserExecutable = [
  '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
  '/opt/google/chrome/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(existsSync)
assert.ok(browserExecutable, 'Central Linux Runner requires an installed Chromium/Chrome executable')

const website = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end('<!doctype html><html><head><title>Delta MCP synthetic smoke</title></head>' +
    '<body><label for="name">Name</label><input id="name">' +
    '<button onclick="document.querySelector(\'#output\').textContent=' +
    '\'Saved: \'+document.querySelector(\'#name\').value">Save</button>' +
    '<output id="output"></output></body></html>')
})
website.listen(0, '127.0.0.1')
await once(website, 'listening')
const bound = website.address()
assert.ok(bound && typeof bound !== 'string')
const url = `http://127.0.0.1:${bound.port}/`

/** MCP stdio framing is newline-delimited JSON-RPC, never shell commands. */
async function connectClient(home) {
  const args = [cliPath, '--browser', 'chromium', '--isolated', '--headless',
    '--executable-path', browserExecutable]
  const proc = spawn(process.execPath, args, {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TMPDIR: home,
      LANG: 'C.UTF-8',
      ...process.env.PLAYWRIGHT_BROWSERS_PATH === undefined ? {} :
        { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH },
    },
  })
  const pending = new Map()
  let nextId = 0
  let buffer = ''
  let stderr = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', chunk => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const raw = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!raw) continue
      let message
      try { message = JSON.parse(raw) } catch { continue }
      if (typeof message.id !== 'number') continue
      const task = pending.get(message.id)
      if (!task) continue
      pending.delete(message.id)
      clearTimeout(task.timer)
      if (message.error) task.reject(new Error('MCP request failed: ' + message.error.message))
      else task.resolve(message.result)
    }
  })
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096) })
  const rejectPending = error => {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error) }
    pending.clear()
  }
  proc.once('error', rejectPending)
  proc.once('exit', (code, signal) => {
    rejectPending(new Error('Playwright MCP server exited: ' + String(code ?? signal) +
      '; stderr tail: ' + stderr))
  })
  const request = (method, params = {}) => new Promise((resolveRequest, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Playwright MCP request timed out: ' + method))
    }, deadlineMs)
    pending.set(id, { resolve: resolveRequest, reject, timer })
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const notice = (method, params = {}) => {
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }
  const initialization = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'delta-trusted-ci', version: '1.0.0' },
  })
  assert.ok(initialization.serverInfo?.name)
  notice('notifications/initialized')
  const tools = (await request('tools/list')).tools
  for (const name of ['browser_navigate', 'browser_snapshot', 'browser_type',
    'browser_click', 'browser_evaluate']) {
    assert.ok(tools.some(tool => tool.name === name), 'Missing browser tool: ' + name)
  }
  const call = async (name, args = {}) => {
    const result = await request('tools/call', { name, arguments: args })
    assert.equal(result.isError ?? false, false,
      name + ': ' + JSON.stringify(result.content ?? []).slice(0, 650))
    return (result.content ?? []).filter(item => item.type === 'text')
      .map(item => item.text).join('\n')
  }
  const close = async () => {
    rejectPending(new Error('MCP client closed'))
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM')
      await Promise.race([once(proc, 'exit'), new Promise(done => setTimeout(done, 3_000))])
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
    }
  }
  return { call, tools, close }
}

const firstHome = await mkdtemp(join(tmpdir(), 'delta-mcp-one-'))
const secondHome = await mkdtemp(join(tmpdir(), 'delta-mcp-two-'))
let first, second
try {
  first = await connectClient(firstHome)
  const initial = await first.call('browser_navigate', { url })
  assert.match(initial, /Delta MCP synthetic smoke/)
  const snapshot = await first.call('browser_snapshot')
  const field = /textbox "Name"[^\n]*?ref=([\w-]+)/.exec(snapshot)?.[1]
  const save = /button "Save"[^\n]*?ref=([\w-]+)/.exec(snapshot)?.[1]
  assert.ok(field && save, 'Playwright MCP did not expose accessible refs')
  await first.call('browser_type', { element: 'Name', ref: field, text: 'Delta' })
  await first.call('browser_click', { element: 'Save', ref: save })
  assert.match(await first.call('browser_snapshot'), /Saved: Delta/)
  await first.call('browser_evaluate',
    { function: "() => localStorage.setItem('ci-marker', 'first-session')" })

  second = await connectClient(secondHome)
  await second.call('browser_navigate', { url })
  const secondMarker = await second.call('browser_evaluate',
    { function: "() => localStorage.getItem('ci-marker')" })
  assert.match(secondMarker, /null/, 'Distinct Session inherited previous browser storage')
  assert.doesNotMatch(await second.call('browser_snapshot'), /Saved: Delta/,
    'Distinct Session inherited DOM state')

  await first.close()
  first = undefined
  assert.match(await second.call('browser_snapshot'), /Delta MCP synthetic smoke/,
    'Disposing one browser Session broke the other')
  console.log('Delta Playwright MCP loopback navigation, type, click, Session isolation and disposal smoke passed')
} finally {
  if (first) await first.close()
  if (second) await second.close()
  await rm(firstHome, { recursive: true, force: true })
  await rm(secondHome, { recursive: true, force: true })
  website.close()
}
