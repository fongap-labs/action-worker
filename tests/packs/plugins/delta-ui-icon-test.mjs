import { test, assert } from '../../kit/harness.mjs'
import { targetPath } from '../../kit/target.mjs'
import { existsSync, readFileSync } from 'node:fs'

const migrationPresent = existsSync(targetPath('packages/delta-ui/package.json'))
test('Delta UI icon shares the Delta Suite mark with a Delta teal circle', {
  skip: migrationPresent ? false : 'Delta UI / Delta Suite product migration is not present in this target revision',
}, () => {
  const uiIcon = readFileSync(targetPath('packages/delta-ui/icon.svg'), 'utf8')
  const suiteIcon = readFileSync(targetPath('packages/delta-suite/icon.svg'), 'utf8')
  const uiMark = uiIcon.match(/data:image\/png;base64,([^"]+)/)
  const suiteMark = suiteIcon.match(/data:image\/png;base64,([^"]+)/)

  assert.ok(uiMark)
  assert.ok(suiteMark)
  assert.equal(uiMark[1], suiteMark[1])
  assert.match(uiIcon, /<circle cx="32" cy="32" r="30" fill="#286F78"\/>/)
  assert.match(uiIcon, /fill="#FFFFFF"/)
  assert.match(uiIcon, /mask-type="alpha"/)
  assert.doesNotMatch(uiIcon, /clip-path/)
})
