import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const targetRoot = process.env.CENTRAL_TEST_TARGET_ROOT
if (!targetRoot || !isAbsolute(targetRoot)) {
  throw new Error('CENTRAL_TEST_TARGET_ROOT must identify the target checkout.')
}

export const targetFile = (path) => pathToFileURL(join(targetRoot, path)).href
export const targetRequire = createRequire(join(targetRoot, 'package.json'))
