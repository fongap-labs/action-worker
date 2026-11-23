import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test, { afterEach, describe } from 'node:test'

const targetRoot = process.env.CENTRAL_TEST_TARGET_ROOT
if (!targetRoot || !isAbsolute(targetRoot)) {
  throw new Error('CENTRAL_TEST_TARGET_ROOT must identify the target checkout.')
}

const targetRequire = createRequire(join(targetRoot, 'packages/delta/liveshare/package.json'))
const WebSocket = targetRequire('ws')
const targetFile = (path) => pathToFileURL(join(targetRoot, path)).href
const [{ createRelayRegistry, DEFAULT_SHARE_TTL_MS, MAX_SHARE_TTL_MS, MIN_SHARE_TTL_MS }, { startRelay }, { projectPublicSessionMessage }] = await Promise.all([
  import(targetFile('packages/delta/liveshare/src/registry.mjs')),
  import(targetFile('packages/delta/liveshare/src/relay.mjs')),
  import(targetFile('packages/delta/liveshare/src/session-public-projection.ts')),
])

const directories = new Set()
const relays = new Set()
const fixtureDirectory = new URL('.', import.meta.url)
const ownerToken = () => randomBytes(32).toString('base64url')

async function registryFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'delta-liveshare-registry-'))
  directories.add(directory)
  const statePath = join(directory, 'relay-state.json')
  let time = 1_800_000_000_000
  const token = ownerToken()
  const now = () => time
  const registry = await createRelayRegistry({ ownerToken: token, statePath, now })
  return { directory, statePath, ownerToken: token, now, registry, setTime(value) { time = value } }
}

function receive(socket) {
  return new Promise((resolveMessage, reject) => {
    const onError = (error) => { socket.off('message', onMessage); reject(error) }
    const onMessage = (data) => {
      socket.off('error', onError)
      try { resolveMessage(JSON.parse(data.toString())) }
      catch (error) { reject(error) }
    }
    socket.once('message', onMessage)
    socket.once('error', onError)
  })
}

function open(socket) {
  return new Promise((resolveOpen, reject) => {
    socket.once('open', resolveOpen)
    socket.once('error', reject)
  })
}

function close(socket) {
  return new Promise((resolveClose) => {
    if (socket.readyState === WebSocket.CLOSED) { resolveClose(socket.readyState); return }
    socket.once('close', resolveClose)
  })
}

function requestJson(port, path, method, token, body) {
  return new Promise((resolveResponse, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const request = httpsRequest({
      hostname: 'localhost', port, path, method, rejectUnauthorized: false,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': payload.byteLength }),
      },
    }, (response) => {
      const chunks = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolveResponse({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.once('error', reject)
    if (payload !== undefined) request.write(payload)
    request.end()
  })
}

async function relayFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'delta-liveshare-https-'))
  directories.add(directory)
  const token = ownerToken()
  const relay = await startRelay({
    ownerToken: token,
    statePath: join(directory, 'state.json'),
    key: await readFile(new URL('liveshare-test-key.pem', fixtureDirectory)),
    cert: await readFile(new URL('liveshare-test-cert.pem', fixtureDirectory)),
    publicOrigin: 'https://localhost:8443',
    host: '127.0.0.1',
    port: 0,
  })
  relays.add(relay)
  if (relay.address === null || typeof relay.address === 'string') throw new Error('Relay did not bind a TCP address')
  return { relay, ownerToken: token, statePath: join(directory, 'state.json'), port: relay.address.port }
}

afterEach(async () => {
  await Promise.all([...relays].map(relay => relay.close()))
  relays.clear()
  await Promise.all([...directories].map(directory => rm(directory, { recursive: true, force: true })))
  directories.clear()
})

describe('Delta LiveShare Relay registry', () => {
  test('rejects weak owner credentials and relative metadata paths', async () => {
    await assert.rejects(createRelayRegistry({ ownerToken: 'short', statePath: join(tmpdir(), 'state.json') }))
    await assert.rejects(createRelayRegistry({ ownerToken: ownerToken(), statePath: 'relative.json' }))
  })

  test('creates one-time credentials and persists only their digests', async () => {
    const fixture = await registryFixture()
    const share = await fixture.registry.createShare()
    assert.match(share.viewerToken, /^[A-Za-z0-9_-]{43}$/u)
    assert.match(share.hostToken, /^[A-Za-z0-9_-]{43}$/u)
    assert.equal(share.expiresAt, fixture.now() + DEFAULT_SHARE_TTL_MS)
    assert.equal(fixture.registry.authenticateViewer(share.viewerToken).id, share.id)
    assert.equal(fixture.registry.authenticateHost(share.id, share.hostToken), true)
    assert.equal(fixture.registry.authenticateOwner(fixture.ownerToken), true)
    assert.equal(fixture.registry.authenticateOwner('z'.repeat(43)), false)

    const saved = await readFile(fixture.statePath, 'utf8')
    assert.ok(!saved.includes(share.viewerToken))
    assert.ok(!saved.includes(share.hostToken))
    assert.ok(!saved.includes(fixture.ownerToken))
    assert.match(saved, /"viewerDigest":"[a-f0-9]{64}"/u)
    assert.match(saved, /"hostDigest":"[a-f0-9]{64}"/u)
  })

  test('serializes concurrent share creation without losing persisted links', async () => {
    const fixture = await registryFixture()
    const [first, second] = await Promise.all([
      fixture.registry.createShare(),
      fixture.registry.createShare(),
    ])
    assert.notEqual(first.id, second.id)
    assert.equal(fixture.registry.listMetadata().length, 2)
    const restarted = await createRelayRegistry({ ownerToken: fixture.ownerToken, statePath: fixture.statePath, now: fixture.now })
    assert.equal(restarted.listMetadata().length, 2)
    assert.ok(restarted.authenticateViewer(first.viewerToken))
    assert.ok(restarted.authenticateViewer(second.viewerToken))
  })

  test('rejects TTL values outside one minute through 24 hours', async () => {
    const fixture = await registryFixture()
    await assert.rejects(fixture.registry.createShare({ expiresInMs: MIN_SHARE_TTL_MS - 1 }), RangeError)
    await assert.rejects(fixture.registry.createShare({ expiresInMs: MAX_SHARE_TTL_MS + 1 }), RangeError)
    await assert.rejects(fixture.registry.createShare({ expiresInMs: 1.5 }), RangeError)
  })

  test('revokes and expires viewer credentials before new connections', async () => {
    const fixture = await registryFixture()
    const revocable = await fixture.registry.createShare({ expiresInMs: MIN_SHARE_TTL_MS })
    assert.ok(fixture.registry.authenticateViewer(revocable.viewerToken))
    await fixture.registry.revoke(revocable.id)
    assert.equal(fixture.registry.authenticateViewer(revocable.viewerToken), undefined)
    assert.equal(fixture.registry.authenticateHost(revocable.id, revocable.hostToken), false)

    const expiring = await fixture.registry.createShare({ expiresInMs: MIN_SHARE_TTL_MS })
    fixture.setTime(expiring.expiresAt)
    assert.deepEqual(await fixture.registry.expire(), [expiring.id])
    assert.equal(fixture.registry.authenticateViewer(expiring.viewerToken), undefined)
  })

  test('reloads hashed metadata without restoring revoked access', async () => {
    const fixture = await registryFixture()
    const share = await fixture.registry.createShare({ expiresInMs: MIN_SHARE_TTL_MS })
    await fixture.registry.revoke(share.id)
    const restarted = await createRelayRegistry({ ownerToken: fixture.ownerToken, statePath: fixture.statePath, now: fixture.now })
    assert.equal(restarted.getShare(share.id).revoked, true)
    assert.equal(restarted.authenticateViewer(share.viewerToken), undefined)
  })
})

describe('Delta LiveShare HTTPS Relay', () => {
  test('requires HTTPS origin and TLS material', async () => {
    await assert.rejects(startRelay({ ownerToken: ownerToken(), statePath: join(tmpdir(), 'unused-state.json'), publicOrigin: 'http://localhost' }), /HTTPS origin/u)
    await assert.rejects(startRelay({ ownerToken: ownerToken(), statePath: join(tmpdir(), 'unused-state.json'), publicOrigin: 'https://localhost' }), /TLS key and certificate/u)
  })

  test('keeps viewer credentials out of URLs and forwards only bounded read requests in memory', async () => {
    const fixture = await relayFixture()
    const response = await requestJson(fixture.port, '/v1/shares', 'POST', fixture.ownerToken, { expiresInMs: 60_000 })
    assert.equal(response.status, 201)
    const share = JSON.parse(response.body)
    const viewerUrl = new URL(share.viewerUrl)
    assert.equal(viewerUrl.search, '')
    assert.match(viewerUrl.hash, /^#[A-Za-z0-9_-]{43}$/u)
    const persisted = await readFile(fixture.statePath, 'utf8')
    assert.ok(!persisted.includes(viewerUrl.hash.slice(1)))

    const host = new WebSocket(`wss://localhost:${fixture.port}/v1/host/${share.id}`, {
      headers: { authorization: `Bearer ${share.hostToken}` }, rejectUnauthorized: false,
    })
    await open(host)
    const listing = await requestJson(fixture.port, '/v1/shares', 'GET', fixture.ownerToken)
    assert.deepEqual(JSON.parse(listing.body), { shares: [{ id: share.id, expiresAt: share.expiresAt, connected: true }] })
    assert.ok(!listing.body.includes(share.hostToken))
    assert.ok(!listing.body.includes(viewerUrl.hash.slice(1)))

    const viewer = new WebSocket(`wss://localhost:${fixture.port}/v1/viewer`, {
      headers: { origin: 'https://localhost:8443' }, rejectUnauthorized: false,
    })
    await open(viewer)
    viewer.send(JSON.stringify({ type: 'authenticate', token: viewerUrl.hash.slice(1) }))
    assert.equal((await receive(viewer)).type, 'ready')
    viewer.send(JSON.stringify({ type: 'request', id: 'follow', op: 'follow' }))
    const call = await receive(host)
    assert.deepEqual({ type: call.type, id: call.id, op: call.op }, { type: 'request', id: 'follow', op: 'follow' })
    assert.equal(typeof call.viewerId, 'string')
    host.send(JSON.stringify({
      type: 'response', viewerId: call.viewerId, id: call.id, ok: true,
      data: { messages: [{ role: 'assistant', text: '<script>not markup</script>' }] },
    }))
    assert.deepEqual(await receive(viewer), {
      type: 'response', id: 'follow', ok: true,
      data: { messages: [{ role: 'assistant', text: '<script>not markup</script>' }] },
    })

    viewer.send(JSON.stringify({ type: 'request', id: 'blocked', op: 'execute-tool' }))
    assert.equal(await close(viewer), 1008)
    const closeHost = close(host)
    assert.equal((await requestJson(fixture.port, `/v1/shares/${share.id}`, 'DELETE', fixture.ownerToken)).status, 204)
    assert.deepEqual(JSON.parse((await requestJson(fixture.port, '/v1/shares', 'GET', fixture.ownerToken)).body), { shares: [] })
    assert.equal(await closeHost, 4001)
    await fixture.relay.close()
    relays.delete(fixture.relay)
  })

  test('rejects bad owner credentials and serves a self-contained viewer page', async () => {
    const fixture = await relayFixture()
    assert.equal((await requestJson(fixture.port, '/v1/shares', 'POST', ownerToken(), {})).status, 401)
    const page = await new Promise((resolveResponse, reject) => {
      const request = httpsRequest({ hostname: 'localhost', port: fixture.port, path: '/share/', rejectUnauthorized: false }, (response) => {
        const chunks = []
        response.on('data', chunk => chunks.push(Buffer.from(chunk)))
        response.on('end', () => resolveResponse({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }))
      })
      request.once('error', reject)
      request.end()
    })
    assert.equal(page.status, 200)
    assert.equal(page.headers['referrer-policy'], 'no-referrer')
    assert.equal(page.headers['cache-control'], 'no-store')
    assert.doesNotMatch(page.body, /https?:\/\//u)
    await fixture.relay.close()
    relays.delete(fixture.relay)
  })
})

function record(type, data, surfaceOp = 'append') {
  return { type: 'event', event: { type, seq: 1, time: 1, data, surfaceOp } }
}

describe('LiveShare public session projection', () => {
  test('includes only user-authored appended user text', () => {
    const user = record('user/message', {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'question' }, { type: 'image', url: 'file:///private/image.png' }],
    })
    const retry = record('user/message', { source: { kind: 'retry' }, content: [{ type: 'text', text: 'private retry' }] })
    assert.deepEqual(projectPublicSessionMessage(user, 128), { role: 'user', text: 'question' })
    assert.equal(projectPublicSessionMessage(retry, 128), undefined)
  })

  test('includes only final assistant text and excludes tool, system, and replacement records', () => {
    const assistant = record('assistant/message', {
      message: { content: [{ type: 'text', text: 'answer' }, { type: 'image', source: 'private' }] },
      stream: [{ type: 'tool-call-chunks', args: ['secret-tool-arguments'] }],
    })
    assert.deepEqual(projectPublicSessionMessage(assistant, 128), { role: 'assistant', text: 'answer' })
    assert.equal(projectPublicSessionMessage(record('system/message', { content: [{ type: 'text', text: 'hidden' }] }), 128), undefined)
    assert.equal(projectPublicSessionMessage(record('tool/result', { result: 'hidden' }), 128), undefined)
    assert.equal(projectPublicSessionMessage(record('assistant/message', { message: { content: [{ type: 'text', text: 'replaced' }] } }, {
      op: 'replace', startSeq: 1, endSeq: 1,
    }), 128), undefined)
  })

  test('enforces encoded byte limits and drops malformed or empty content', () => {
    const unicode = record('assistant/message', { message: { content: [{ type: 'text', text: '雪雪' }] } })
    const empty = record('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '' }] })
    const malformed = record('assistant/message', { message: { content: 'not blocks' } })
    assert.equal(projectPublicSessionMessage(unicode, 5), undefined)
    assert.equal(projectPublicSessionMessage(empty, 128), undefined)
    assert.equal(projectPublicSessionMessage(malformed, 128), undefined)
  })
})
