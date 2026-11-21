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
fi

pnpm run build:desktop
