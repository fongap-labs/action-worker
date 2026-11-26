import { test, assert } from '../../kit/harness.mjs'
import { targetPath } from '../../kit/target.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
const migrationPresent = existsSync(targetPath('packages/delta-ui/package.json'))
const sourcePath = targetPath('packages/delta-ui/src/client-account-summary.ts')
const readiness = migrationPresent
  ? JSON.parse(readFileSync(targetPath('projects/delta-ui/feature-readiness.json'), 'utf8'))
  : {}
const client = migrationPresent
  ? readFileSync(targetPath('packages/delta-ui/src/client.ts'), 'utf8')
  : ''
// During the coordinated rollout, older revisions have neither the feature nor its declaration.
// A partial rollout must fail; after the product PR merges, remove this transitional condition.
const isFeatureAbsent = !migrationPresent || (!existsSync(sourcePath) &&
  !Object.hasOwn(readiness, 'p1_native_account_summary') &&
  !client.includes('createClientAccountSummary'))
const source = isFeatureAbsent ? '' : readFileSync(sourcePath, 'utf8')
function fixture() {
  const summary = runInNewContext(stripTypeScriptTypes(source + '\ncreateClientAccountSummary()'),
    { URL, currentHostLocale: 'zh-CN', language: () => 'zh' })
  const events = new Map(), requests = [], permissions = new Map()
  let state = { view: { status: 'credential-stored', links: { usageUrl: 'https://platform.deepseek.com/usage' } }, failed: false }
  const scope = {
    accountUi: { getSnapshot: () => state, clientMetadata: locale => ({ version: 'test', locale, timezoneOffsetSeconds: 0 }) },
    remote: { account: { getBalance: metadata => new Promise(resolve => requests.push({ metadata, resolve })) } },
    remoteAccess: { whenAccess(action, install) {
      let stop
      const toggle = allowed => {
        if (allowed && !stop) stop = install()
        else if (!allowed && stop) { const release = stop; stop = undefined; release() }
      }
      permissions.set(action, toggle)
      return () => { toggle(false); permissions.delete(action) }
    } },
    on(event, callback) { events.set(event, callback); return () => events.delete(event) },
  }
  const dispose = summary.bind(scope)
  return { summary, scope, dispose, requests, events, permissions,
    allow() { permissions.get('account/watch')(true); permissions.get('account/getBalance')(true) },
    change(next) { state = next; events.get('account-ui/change')?.() } }
}
const result = { ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '12.3456' }],
  bonusWallets: [{ currency: 'USD', balance: '0.01' }] } }
test('account summary requires both grants, uses an explicit read and preserves server decimals', { skip: isFeatureAbsent ? 'Native account summary not introduced in this target revision' : false }, async () => {
  const f = fixture()
  assert.equal(f.summary.getSnapshot().status, 'hidden')
  f.permissions.get('account/watch')(true)
  assert.equal(f.summary.getSnapshot().status, 'hidden')
  f.permissions.get('account/getBalance')(true)
  assert.equal(f.summary.getSnapshot().status, 'ready')
  assert.equal(f.requests.length, 0)
  const pending = f.summary.refresh()
  assert.equal(f.summary.getSnapshot().status, 'loading')
  assert.equal(f.requests[0].metadata.locale, 'zh-CN')
  f.requests[0].resolve(result)
  await pending
  assert.equal(f.summary.getSnapshot().wallets[0].balance, '12.3456')
  assert.equal(f.summary.getSnapshot().bonusWallets[0].currency, 'USD')
  f.events.get('account-ui/refresh')()
  assert.equal(f.summary.getSnapshot().status, 'ready')
  assert.equal(f.summary.getSnapshot().wallets.length, 0)
  assert.equal(f.requests.length, 1)
  f.dispose()
  assert.equal(f.events.size, 0)
})
test('permission revocation, account changes and disposal discard late balances', { skip: isFeatureAbsent ? 'Native account summary not introduced in this target revision' : false }, async () => {
  for (const change of ['permission', 'logout', 'dispose']) {
    const f = fixture(); f.allow()
    const pending = f.summary.refresh()
    if (change === 'permission') f.permissions.get('account/getBalance')(false)
    else if (change === 'logout') f.change({ view: { status: 'signed-out' } })
    else f.summary.dispose()
    f.requests[0].resolve(result); await pending
    assert.equal(f.summary.getSnapshot().wallets.length, 0)
    assert.equal(f.summary.getSnapshot().status, change === 'logout' ? 'signed-out' : 'hidden')
    f.dispose()
  }
})
test('bad results never appear as zero and unsafe platform destinations are omitted', { skip: isFeatureAbsent ? 'Native account summary not introduced in this target revision' : false }, async () => {
  const f = fixture(); f.allow()
  f.change({ view: { status: 'credential-stored', links: { usageUrl: 'https://example.com/usage?secret=x' } } })
  assert.equal(f.summary.getSnapshot().usageUrl, undefined)
  const pending = f.summary.refresh()
  f.requests[0].resolve({ ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: 'NaN' }], bonusWallets: [] } })
  await pending
  assert.equal(f.summary.getSnapshot().status, 'unavailable')
  assert.equal(f.summary.getSnapshot().wallets.length, 0)
  f.dispose()
})
