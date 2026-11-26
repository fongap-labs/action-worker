import { test, assert } from '../../kit/harness.mjs'
import { targetPath } from '../../kit/target.mjs'
import { existsSync, readFileSync } from 'node:fs'

const migrationPresent = existsSync(targetPath('packages/delta-ui/package.json'))
const read = path => readFileSync(targetPath('packages/delta-suite', path), 'utf8')

test('Delta Suite ships a native beginner settings surface', {
  skip: migrationPresent ? false : 'Delta UI / Delta Suite product migration is not present in this target revision',
}, () => {
  const pkg = JSON.parse(read('package.json'))
  const client = read('src/client.ts')
  const tsconfig = JSON.parse(read('tsconfig.json'))

  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, false)
  assert.equal(tsconfig.compilerOptions.moduleDetection, 'legacy')
  assert.match(client, /name: 'settings\.section', id: 'delta-suite'/)
  assert.match(client, /ctx\.configForms\.get\('delta-suite'\)/)
  assert.match(client, /__ModuleLoader__\.load\(/)
  assert.ok(client.includes('添加服务商'))
  assert.ok(client.includes('保存配置'))
  assert.ok(client.includes('测试连接 / 刷新模型'))
  assert.ok(client.includes('高级设置（默认无需修改）'))
  assert.ok(client.includes('模型行为增强（推荐）'))
  assert.ok(client.includes('启用指令遵循与证据边界提示'))
  assert.match(client, /h\('details'/)
})

test('Delta Suite settings keep secrets out of ConfigForm and use Host credentials', {
  skip: migrationPresent ? false : 'Delta UI / Delta Suite product migration is not present in this target revision',
}, () => {
  const client = read('src/client.ts')
  assert.match(client, /type: isSecret \? 'password' : 'text'/)
  assert.match(client, /props\.credentials!\.set!\(update\.ref, update\.value\)/)
  assert.match(client, /credentialValidation/)
  assert.ok(client.includes('API Key（只在本次输入中暂存）'))
  assert.ok(client.includes('凭据引用（默认自动生成）'))
  assert.doesNotMatch(client, /set\(\['providers'.*credentialInputs/)
  assert.doesNotMatch(client, /document\.createElement|document\.querySelector|innerHTML/)
})

test('Delta Suite build emits a loader script rather than an ESM client export', {
  skip: migrationPresent ? false : 'Delta UI / Delta Suite product migration is not present in this target revision',
}, () => {
  const clientPath = targetPath('packages/delta-suite/lib/client.js')
  assert.ok(existsSync(clientPath), 'build must emit the DSH client script')
  const client = readFileSync(clientPath, 'utf8')
  assert.match(client, /__ModuleLoader__\.load\(/)
  assert.doesNotMatch(client, /\bexport\s*\{/)
})
