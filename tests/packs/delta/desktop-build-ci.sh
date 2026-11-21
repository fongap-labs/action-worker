#!/usr/bin/env bash
# Trusted central entrypoint for Delta's source-owned desktop build contract.
set -Eeuo pipefail

TARGET_ROOT="${1:-}"
if [[ -z "$TARGET_ROOT" || ! -d "$TARGET_ROOT/.git" ]]; then
  echo "central-ci: verified source root is required" >&2
  exit 64
fi
# The sandbox provisions this pinned runtime before source checkout.
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major !== 24 || minor < 9) process.exit(2)'
test "$(pnpm --version)" = "11.28.5"

cd "$TARGET_ROOT"
node scripts/delta-verify.mjs
pnpm install --frozen-lockfile
# Compile Host declarations and Typert inputs needed for Desktop.
# Full Client aggregate test typechecks are outside this production desktop build gate.
pnpm run build:lib:host

# A newly declared Delta Code bundle must produce a loadable Host entry and
# a Client entry. Older revisions without bundle metadata remain testable.
if [[ -f packages/plugin/shared/tsdown.config.ts ]]; then
  pnpm --filter @fongap-labs/delta-plugin-shared run build
  test -s packages/plugin/shared/lib/index.js
  pnpm --filter @fongap-labs/delta-code run build
  test -s packages/plugin/delta-code/lib/index.js
  test -s packages/plugin/delta-code/lib/client.js
  test -s packages/plugin/delta-code/lib/types/index.d.ts
  node --input-type=module -e '
    import assert from "node:assert/strict"
    import { pathToFileURL } from "node:url"
    import { resolve } from "node:path"
    const plugin = await import(pathToFileURL(resolve("packages/plugin/delta-code/lib/index.js")).href)
    assert.equal(plugin.name, "@fongap-labs/delta-code")
    assert.equal(typeof plugin.apply, "function")
    assert.ok(plugin.inject.includes("tools"))
  '

  # Exercise real Cordis service injection and tool ownership with no network,
  # subprocess, user profile, or privileged execution service attached.
  node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const load = relative => import(pathToFileURL(resolve(relative)).href)
const { Context } = await load('vendor/cordis/lib/index.js')
const { SystemPrompt } = await load('packages/core/system-prompt/lib/index.js')
const { ToolsService } = await load('packages/core/tools/lib/index.js')
const deltaCode = await load('packages/plugin/delta-code/lib/index.js')

const host = new Context()
const prompt = host.plugin(SystemPrompt, { includeHarnessIdentity: false })
await prompt
const tools = host.plugin(ToolsService, {})
await tools
const toolName = 'code_multi_edit'
const config = { github: { enabled: false }, git: { enabled: false }, execution: { allowCommands: false } }
let active
try {
  // The plugin is optional: a disabled instance must contribute nothing.
  const disabled = host.plugin(deltaCode, { ...config, enabled: false })
  await disabled
  assert.equal(host.tools.get(toolName), undefined, 'disabled plugin registered a tool')
  await disabled.dispose()

  // Native host tools service is present, but no subprocess or GitHub access
  // is injected. Command-backed capabilities must remain absent.
  active = host.plugin(deltaCode, { ...config, enabled: true })
  await active
  assert.ok(host.tools.get(toolName), 'enabled plugin failed native tool registration')
  assert.equal(host.tools.get('code_git_worktree'), undefined,
    'command tool mounted despite missing Host subprocess service')
  await active.dispose()
  active = undefined
  assert.equal(host.tools.get(toolName), undefined,
    'disabled plugin retained a model-invocable tool')

  // Re-mounting on the same host verifies ownership and duplicate cleanup.
  active = host.plugin(deltaCode, { ...config, enabled: true })
  await active
  assert.ok(host.tools.get(toolName), 're-enable failed')
  await active.dispose()
  active = undefined
  assert.equal(host.tools.get(toolName), undefined, 're-enable leaked a tool')
} finally {
  if (active) await active.dispose()
  await tools.dispose()
  await prompt.dispose()
}
console.log('Delta Code Cordis lifecycle smoke passed')
NODE

  # Invoke the native registered editing tool against an entirely disposable
  # workspace, including both allowed edits and denied writes. No user files,
  # credentials, Git subprocesses or external network are involved.
  node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const load = relative => import(pathToFileURL(resolve(relative)).href)
const { Context } = await load('vendor/cordis/lib/index.js')
const { SystemPrompt } = await load('packages/core/system-prompt/lib/index.js')
const { ToolsService } = await load('packages/core/tools/lib/index.js')
const deltaCode = await load('packages/plugin/delta-code/lib/index.js')

const scratch = await mkdtemp(join(tmpdir(), 'delta-code-edit-sandbox-'))
const workspace = join(scratch, 'workspace')
const editable = join(workspace, 'src', 'app.txt')
const outside = join(scratch, 'private.txt')
const host = new Context()
let prompt, tools, plugin
try {
  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(editable, 'before\n')
  await writeFile(outside, 'private-original\n')
  prompt = host.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await prompt
  tools = host.plugin(ToolsService, {})
  await tools
  plugin = host.plugin(deltaCode, {
    enabled: true, workspaceRoot: workspace,
    git: { enabled: false }, github: { enabled: false },
    execution: { allowCommands: false, allowWorktreeWrites: false },
  })
  await plugin
  const definition = host.tools.get('code_multi_edit')
  assert.ok(definition, 'native Delta Code editor was not registered')
  const edit = (edits, options = {}) => definition.execute(
    { edits, ...options }, { signal: new AbortController().signal },
  )
  const current = () => readFile(editable, 'utf8')
  const external = () => readFile(outside, 'utf8')

  // A dry run must validate but never make a filesystem change.
  const planned = await edit([{ path: 'src/app.txt', find: 'before', replace: 'after' }],
    { dryRun: true })
  assert.equal(planned.dryRun, true)
  assert.equal(planned.applied, 1)
  assert.equal(await current(), 'before\n')

  // Invalid late inputs cannot leave earlier batch edits applied.
  await assert.rejects(
    edit([{ path: 'src/app.txt', content: 'overwritten\n' },
      { path: '../private.txt', content: 'unsafe\n' }]),
    /MultiEdit did not complete successfully/,
  )
  assert.equal(await current(), 'before\n', 'failed preflight changed a valid earlier target')
  assert.equal(await external(), 'private-original\n', 'path traversal changed an external file')

  // Even an otherwise valid inside-workspace path may resolve through an
  // existing symlink to data outside the workspace. It must be refused.
  await symlink(outside, join(workspace, 'link.txt'))
  await assert.rejects(
    edit([{ path: 'link.txt', content: 'unsafe\n' }], { preflight: true }),
    /MultiEdit did not complete successfully/,
  )
  assert.equal(await external(), 'private-original\n', 'symlink escaped the workspace')

  // Stale optimistic edit evidence must fail before the write.
  await assert.rejects(
    edit([{ path: 'src/app.txt', content: 'stale\n',
      expectedSha256: '0'.repeat(64) }], { preflight: true }),
    /MultiEdit did not complete successfully/,
  )
  assert.equal(await current(), 'before\n', 'stale digest wrote a file')

  // A correct digest and ordinary replacement must still work for authorized
  // workspace-local files, demonstrating this is not an always-failing test.
  const sha256 = createHash('sha256').update('before\n').digest('hex')
  const applied = await edit([{ path: 'src/app.txt', content: 'after\n',
    expectedSha256: sha256 }], { preflight: true })
  assert.equal(applied.applied, 1)
  assert.equal(applied.results[0]?.ok, true)
  assert.equal(await current(), 'after\n')
} finally {
  if (plugin) await plugin.dispose()
  if (tools) await tools.dispose()
  if (prompt) await prompt.dispose()
  await rm(scratch, { recursive: true, force: true })
}
console.log('Delta Code native multi-edit workspace confinement smoke passed')
NODE

  # Execute native Git status/diff tools through a strict Host subprocess
  # provider against one disposable repository, not Node fallback in Delta.
  # The provider only permits git status/diff inside the isolated workspace.
  node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const load = relative => import(pathToFileURL(resolve(relative)).href)
const { Context } = await load('vendor/cordis/lib/index.js')
const { SystemPrompt } = await load('packages/core/system-prompt/lib/index.js')
const { ToolsService } = await load('packages/core/tools/lib/index.js')
const deltaCode = await load('packages/plugin/delta-code/lib/index.js')

const scratch = await mkdtemp(join(tmpdir(), 'delta-code-native-git-'))
const workspace = join(scratch, 'workspace')
const textFile = join(workspace, 'src', 'app.txt')
let prompt, tools, plugin, releaseSubprocess
const host = new Context()
const cli = (args) => {
  const result = spawnSync('git', args, {
    cwd: workspace, encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024,
    env: { PATH: process.env.PATH ?? '', HOME: scratch,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0, 'fixture git failed: ' + result.stderr)
  return result.stdout
}
try {
  await mkdir(join(workspace, 'src'), { recursive: true })
  cli(['init', '--quiet', '--initial-branch=main'])
  cli(['config', 'user.name', 'Delta Test'])
  cli(['config', 'user.email', 'delta-test@example.invalid'])
  await writeFile(textFile, 'baseline\n')
  cli(['add', '--', 'src/app.txt'])
  cli(['commit', '--quiet', '-m', 'baseline'])
  await writeFile(textFile, 'changed\n')
  await writeFile(join(workspace, 'note.txt'), 'untracked\n')

  const observed = []
  releaseSubprocess = host.provide('subprocess', {
    spawn(spec) {
      assert.equal(spec.argv[0], 'git', 'Host may only run Git')
      assert.ok(['status', 'diff'].includes(spec.argv[1]),
        'unexpected Git command requested by native tool')
      assert.equal(spec.cwd, workspace, 'Git command escaped the test workspace')
      assert.equal(spec.stdio.stdin, 'ignore', 'Host subprocess requested stdin')
      assert.equal(spec.signal?.aborted, false, 'cancelled subprocess executed')
      observed.push([...spec.argv])
      const result = spawnSync('git', spec.argv.slice(1), {
        cwd: workspace, encoding: 'utf8', timeout: 10000, maxBuffer: 512 * 1024,
        env: { PATH: process.env.PATH ?? '', HOME: scratch,
          GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      })
      if (result.error) throw result.error
      const reader = text => ({ readFrom(offset) {
        return { text: text.slice(offset), lossy: false }
      } })
      return {
        done: Promise.resolve({ exitCode: result.status, signal: result.signal }),
        collected: { stdout: reader(result.stdout ?? ''), stderr: reader(result.stderr ?? '') },
      }
    },
  })
  prompt = host.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await prompt
  tools = host.plugin(ToolsService, {})
  await tools
  plugin = host.plugin(deltaCode, {
    enabled: true, workspaceRoot: workspace, git: { enabled: true },
    github: { enabled: false },
    execution: { allowCommands: false, allowWorktreeWrites: false },
  })
  await plugin
  const invoke = (name, args = {}) => {
    const def = host.tools.get(name)
    assert.ok(def, 'native tool not registered: ' + name)
    return def.execute(args, { signal: new AbortController().signal })
  }
  const status = await invoke('code_git_status')
  assert.equal(status.clean, false, 'working tree incorrectly marked clean')
  assert.ok(status.unstaged.includes('M src/app.txt'), 'missing real unstaged modification')
  assert.ok(status.untracked.includes('note.txt'), 'missing untracked file')
  const diff = await invoke('code_git_diff', { path: 'src/app.txt' })
  assert.equal(diff.truncated, false, 'small Git diff was truncated')
  assert.match(diff.diff, /-baseline/)
  assert.match(diff.diff, /\+changed/)
  assert.ok(observed.some(x => x[1] === 'status'), 'Host did not run git status')
  assert.ok(observed.some(x => x[1] === 'diff'), 'Host did not run git diff')

  const count = observed.length
  await assert.rejects(
    invoke('code_git_diff', { path: '../outside.txt' }),
    /workspace|safe|escapes/,
    'diff path traversal must be rejected',
  )
  assert.equal(observed.length, count, 'invalid path reached Host subprocess')
  assert.equal(await readFile(textFile, 'utf8'), 'changed\n',
    'read-only Git tools modified the workspace')
} finally {
  if (plugin) await plugin.dispose()
  if (tools) await tools.dispose()
  if (prompt) await prompt.dispose()
  if (releaseSubprocess) await releaseSubprocess()
  await rm(scratch, { recursive: true, force: true })
}
console.log('Delta Code native Host Git status/diff regression passed')
NODE

  # The real Profile composition and enable/disable APIs must agree with the
  # published Delta Code bundle. Operate on a disposable fixture only; this
  # does not claim that pnpm's installation/removal flow has been exercised.
  node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const load = relative => import(pathToFileURL(resolve(relative)).href)
const { initProfile, loadProfileDirectory, composeEntries } =
  await load('packages/boot/app-boot/lib/index.js')
const { writePluginEnabled } =
  await load('packages/boot/plugin-manager/lib/types/patch.js')

const packageName = '@fongap-labs/delta-code'
const scratch = await mkdtemp(join(tmpdir(), 'delta-profile-selection-'))
const dir = join(scratch, 'profile')
const patchPath = join(dir, 'cordis.patch.yml')
const installAnchor = resolve('apps/cli/package.json')
try {
  initProfile(dir, [packageName])
  // Emulate a package already resolved by pnpm; do not run package installs.
  const scope = join(dir, 'node_modules', '@fongap-labs')
  await mkdir(scope, { recursive: true })
  await symlink(resolve('packages/plugin/delta-code'), join(scope, 'delta-code'), 'dir')
  const context = { dir, patchPath, installAnchor, home: scratch, overlayPaths: [] }
  const read = () => {
    const profile = loadProfileDirectory('dsh', dir, installAnchor)
    assert.deepEqual(profile.skippedBundles, [], 'Delta Code bundle skipped')
    const entries = composeEntries([
      profile.layers.flatMap(layer => layer.patches),
      profile.patches,
    ])
    return { profile, entries, row: entries.find(entry => entry.id === 'delta-code') }
  }

  let state = read()
  assert.equal(state.profile.layers.length, 1, 'selected bundle missing')
  assert.equal(state.row?.name, packageName)
  assert.equal(state.row?.disabled ?? false, false, 'initial entry is disabled')
  assert.equal(state.entries.filter(entry => entry.id === 'delta-code').length, 1,
    'bundle inserted more than one Delta Code entry')

  assert.equal(await writePluginEnabled(context, 'delta-code', packageName, false), true)
  state = read()
  assert.equal(state.row?.disabled, true, 'manager did not disable bundle entry')
  const disabledPatch = await readFile(patchPath, 'utf8')
  assert.equal(await writePluginEnabled(context, 'delta-code', packageName, false), false,
    'repeating disable rewrote the profile')
  assert.equal(await readFile(patchPath, 'utf8'), disabledPatch,
    'idempotent disable changed profile content')

  assert.equal(await writePluginEnabled(context, 'delta-code', packageName, true), true)
  state = read()
  assert.equal(state.row?.disabled ?? false, false, 'manager did not re-enable entry')
  assert.equal(state.entries.filter(entry => entry.id === 'delta-code').length, 1,
    're-enable produced a duplicate registration')
  assert.equal(await writePluginEnabled(context, 'delta-code', packageName, true), false,
    'repeating enable rewrote the profile')

  // Profile deselection is verified independently of package uninstallation.
  const manifestPath = join(dir, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.dsh.profile.bundles = []
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  state = read()
  assert.equal(state.profile.layers.length, 0)
  assert.equal(state.row, undefined, 'deselected bundle still contributes a tool entry')
} finally {
  await rm(scratch, { recursive: true, force: true })
}
console.log('Delta Code isolated Profile selection smoke passed')
NODE

  # Exercise the actual shared package-manager entrypoint, offline and inside
  # an isolated profile. The link: spec uses the private local workspace package
  # without publishing it, fetching registry packages or running scripts.
  node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const load = relative => import(pathToFileURL(resolve(relative)).href)
const { initProfile, loadProfileDirectory, composeEntries } =
  await load('packages/boot/app-boot/lib/index.js')
const { runPluginCommand } =
  await load('packages/boot/plugin-manager/lib/types/operations.js')
const scratch = await mkdtemp(join(tmpdir(), 'delta-pnpm-install-'))
const dir = join(scratch, 'profile')
const packageName = '@fongap-labs/delta-code'
const source = resolve('packages/plugin/delta-code')
const context = {
  profile: 'delta-ci-install',
  dir,
  home: scratch,
  cwd: resolve(),
  installAnchor: resolve('apps/cli/package.json'),
}
const options = {
  command: 'pnpm',
  execution: 'service',
  outputBytes: 8192,
  lockWaitMs: 30000,
  idleTimeoutMs: 90000,
  lookupTimeoutMs: 10000,
  env: { CI: 'true', npm_config_offline: 'true', npm_config_ignore_scripts: 'true' },
}
const manifest = async () => JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
const entries = () => {
  const profile = loadProfileDirectory('dsh', dir, context.installAnchor)
  assert.deepEqual(profile.skippedBundles, [], 'Profile skipped the installed Delta Code')
  return composeEntries([
    profile.layers.flatMap(layer => layer.patches),
    profile.patches,
  ])
}
const verify = (result, action) => assert.equal(result.exitCode, 0,
  action + ' rejected: ' + (result.output ?? '').slice(-1500))
try {
  initProfile(dir, [])
  assert.deepEqual((await manifest()).dsh.profile.bundles, [])
  const added = await runPluginCommand(
    context, ['add', 'link:' + source, '--offline', '--ignore-scripts'],
    { ...options, expected: { name: packageName, version: '0.1.0' } },
  )
  verify(added, 'local pnpm add')
  const afterAdd = await manifest()
  assert.ok(Object.hasOwn(afterAdd.dependencies, packageName), 'pnpm did not add dependency')
  assert.deepEqual(afterAdd.dsh.profile.bundles, [packageName],
    'package manager did not select the installed bundle')
  const registered = entries().filter(entry => entry.id === 'delta-code')
  assert.equal(registered.length, 1, 'installed Delta Code bundle did not compose uniquely')
  assert.equal(registered[0].name, packageName)

  const removed = await runPluginCommand(
    context, ['remove', packageName, '--offline', '--ignore-scripts'], options,
  )
  verify(removed, 'local pnpm remove')
  const afterRemove = await manifest()
  assert.equal(Object.hasOwn(afterRemove.dependencies ?? {}, packageName), false,
    'pnpm remove left the Delta Code dependency')
  assert.equal(afterRemove.dsh.profile.bundles.includes(packageName), false,
    'pnpm remove left the bundle selected')
  assert.equal(entries().some(entry => entry.id === 'delta-code'), false,
    'removed bundle still contributes a Cordis entry')
} finally {
  await rm(scratch, { recursive: true, force: true })
}
console.log('Delta Code isolated pnpm link installation and removal smoke passed')
NODE

  # Verify the actual distributable tarball, not only workspace import paths.
  # This is a local, offline, script-free pack; it never publishes the private
  # package or reads a user's profile.
  node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

const scratch = await mkdtemp(join(tmpdir(), 'delta-code-offline-pack-'))
const run = (binary, args) => {
  const result = spawnSync(binary, args, {
    cwd: resolve(), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, CI: 'true', npm_config_offline: 'true',
      npm_config_ignore_scripts: 'true' },
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0,
    binary + ' ' + args[0] + ' failed: ' + (result.stderr || result.stdout).slice(-1600))
  return result.stdout
}
try {
  run('pnpm', [
    '--filter', '@fongap-labs/delta-code', 'pack',
    '--pack-destination', scratch, '--ignore-scripts', '--offline',
  ])
  const archives = (await readdir(scratch)).filter(name => name.endsWith('.tgz'))
  assert.equal(archives.length, 1, 'expected one private Delta Code package archive')
  const tarball = join(scratch, archives[0])
  const entries = new Set(run('tar', ['-tzf', tarball]).trim().split('\n'))
  for (const name of [
    'package/package.json',
    'package/lib/index.js',
    'package/lib/client.js',
    'package/lib/types/index.d.ts',
    'package/cordis.patch.yml',
    'package/locale/zh.json',
    'package/locale/en.json',
    'package/icon.svg',
  ]) assert.ok(entries.has(name), 'packed Delta Code missing ' + name)
  assert.ok([...entries].every(name =>
    name.startsWith('package/') && !name.includes('/node_modules/') &&
    !name.includes('/.env') && !name.includes('/.git/')),
    'packed Delta Code contains unexpected project/private files')
  const packed = JSON.parse(run('tar', ['-xOzf', tarball, 'package/package.json']))
  const source = JSON.parse(await readFile(resolve('packages/plugin/delta-code/package.json'), 'utf8'))
  assert.equal(source.private, true, 'Delta Code remains an unpublished optional plugin')
  assert.equal(packed.name, '@fongap-labs/delta-code')
  assert.equal(packed.version, source.version, 'pack must preserve the current plugin version')
  assert.equal(packed.dsh?.manifestVersion, 1)
  assert.equal(packed.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(packed.main, './lib/index.js')
  assert.equal(packed.exports?.['./client'], './lib/client.js')
  assert.ok(packed.dependencies?.['@fongap-labs/delta-plugin-shared'])
  for (const group of ['dependencies', 'peerDependencies']) {
    for (const version of Object.values(packed[group] ?? {}))
      assert.equal(String(version).startsWith('workspace:'), false,
        'publishable metadata cannot depend on unresolved workspace protocol')
  }

  // A standalone Delta Code tarball depends on this first-party shared module.
  // Audit its actual archive and the package-manager-rewritten version link.
  // This is package-closure metadata verification, not a cross-machine install.
  run('pnpm', [
    '--filter', '@fongap-labs/delta-plugin-shared', 'pack',
    '--pack-destination', scratch, '--ignore-scripts', '--offline',
  ])
  const allArchives = (await readdir(scratch)).filter(name => name.endsWith('.tgz'))
  assert.equal(allArchives.length, 2, 'expected only Delta Code and shared package archives')
  const sharedArchive = allArchives.find(name => name !== archives[0])
  assert.ok(sharedArchive, 'missing private shared-module archive')
  const sharedTarball = join(scratch, sharedArchive)
  const sharedEntries = new Set(run('tar', ['-tzf', sharedTarball]).trim().split('\n'))
  for (const name of [
    'package/package.json',
    'package/lib/index.js',
    'package/lib/types/index.d.ts',
  ]) assert.ok(sharedEntries.has(name), 'packed shared module missing ' + name)
  assert.ok([...sharedEntries].every(name =>
    name.startsWith('package/') && !name.includes('/node_modules/') &&
    !name.includes('/.env') && !name.includes('/.git/')),
    'packed shared module contains unexpected project/private files')
  const sharedManifest = JSON.parse(
    run('tar', ['-xOzf', sharedTarball, 'package/package.json']))
  const sharedSource = JSON.parse(
    await readFile(resolve('packages/plugin/shared/package.json'), 'utf8'))
  assert.equal(sharedSource.private, true, 'shared module must remain private')
  assert.equal(sharedManifest.name, '@fongap-labs/delta-plugin-shared')
  assert.equal(sharedManifest.version, sharedSource.version)
  assert.equal(sharedManifest.main, './lib/index.js')
  assert.equal(sharedManifest.exports?.['.']?.default, './lib/index.js')
  assert.equal(sharedManifest.exports?.['.']?.types, './lib/types/index.d.ts')
  assert.equal(packed.dependencies['@fongap-labs/delta-plugin-shared'],
    sharedManifest.version, 'Delta Code tarball must pin the matching shared-module version')
  for (const group of ['dependencies', 'peerDependencies']) {
    for (const version of Object.values(sharedManifest[group] ?? {}))
      assert.equal(String(version).startsWith('workspace:'), false,
        'packed shared module dependency retains workspace protocol')
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}
console.log('Delta Code offline packed artifact contract passed')
NODE

  # Guard the two supported UI resources and enforce privileged capability
  # defaults through compiled runtime code. No credentials, commands or
  # network requests are executed by this test.
  node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const localeDir = resolve('packages/plugin/delta-code/locale')
const locales = (await readdir(localeDir)).filter(file => file.endsWith('.json')).sort()
assert.deepEqual(locales, ['en.json', 'zh.json'],
  'Delta Code UI must support only English and Chinese locale resources')
for (const name of locales) {
  const value = JSON.parse(await readFile(resolve(localeDir, name), 'utf8'))
  assert.equal(value?.meta?.title, 'Delta Code', 'missing Delta Code locale title: ' + name)
  assert.ok(typeof value?.meta?.description === 'string' &&
    value.meta.description.trim().length > 30,
  'missing meaningful locale description: ' + name)
}
const load = relative => import(pathToFileURL(resolve(relative)).href)
const { normalizeConfig, validateGitHubAccounts } =
  await load('packages/plugin/delta-code/lib/types/runtime.js')
const { runCommand, isSubprocessAvailable } =
  await load('packages/plugin/shared/lib/index.js')

const defaults = normalizeConfig(undefined)
assert.equal(defaults.allowCommands, false, 'command execution must be opt-in')
assert.equal(defaults.allowWorktreeWrites, false, 'worktree writes must be opt-in')
assert.equal(defaults.githubAllowWrites, false, 'GitHub writes must be opt-in')
assert.deepEqual(defaults.githubAccounts, [], 'default GitHub accounts must be empty')
assert.equal(isSubprocessAvailable({}), false, 'unprivileged Host exposed subprocess')
await assert.rejects(
  runCommand({}, { command: 'node', args: ['--version'] }),
  /host subprocess service unavailable/,
  'missing Host subprocess must not fall back to local Node execution',
)
assert.deepEqual(
  validateGitHubAccounts([{
    owner: 'ExampleOrg',
    tokenEnv: 'DELTA_CODE_GITHUB_EXAMPLEORG_TOKEN',
    repositories: ['exampleorg/repository'],
  }]),
  [{
    owner: 'exampleorg',
    tokenEnv: 'DELTA_CODE_GITHUB_EXAMPLEORG_TOKEN',
    repositories: ['exampleorg/repository'],
  }],
)
assert.throws(
  () => validateGitHubAccounts([{
    owner: 'example', tokenEnv: 'DELTA_CODE_GITHUB_EXAMPLE_TOKEN', token: 'secret',
  }]),
  /token is not supported/,
  'raw credentials must never be accepted in plugin config',
)
assert.throws(
  () => validateGitHubAccounts([
    { owner: 'example', tokenEnv: 'DELTA_CODE_GITHUB_SHARED_TOKEN' },
    { owner: 'another', tokenEnv: 'DELTA_CODE_GITHUB_SHARED_TOKEN' },
  ]),
  /only one account/,
  'credential references must not be shared across owners',
)
assert.throws(
  () => validateGitHubAccounts([{
    owner: 'example',
    tokenEnv: 'DELTA_CODE_GITHUB_EXAMPLE_TOKEN',
    repositories: ['other/repository'],
  }]),
  /must match its account owner/,
  'GitHub credential must never route across owners',
)
console.log('Delta Code privacy, privilege, and English/Chinese locale smoke passed')
NODE
fi

pnpm run build:desktop
