import { test, assert } from '../../kit/harness.mjs'
import { targetPath } from '../../kit/target.mjs'
import { existsSync, readFileSync } from 'node:fs'

const migrationPresent = existsSync(targetPath('packages/delta-ui/package.json'))
test('Delta Suite icon keeps the official mark with the dark circular Delta treatment', {
  skip: migrationPresent ? false : 'Delta UI / Delta Suite product migration is not present in this target revision',
}, () => {
  const icon = readFileSync(targetPath('packages/delta-suite/icon.svg'), 'utf8')
  assert.match(icon, /<circle cx="32" cy="32" r="30" fill="url\(#delta-bg\)"\/>/)
  assert.match(icon, /<radialGradient id="delta-bg"/)
  assert.match(icon, /#11151E/)
  assert.match(icon, /fill="#FFFFFF"/)
  assert.match(icon, /mask-type="alpha"/)
  assert.match(icon, /data:image\/png;base64,/)
  assert.doesNotMatch(icon, /<path/)
})
