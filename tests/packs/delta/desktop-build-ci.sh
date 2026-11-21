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
if node -e "const p=require('./packages/plugin/delta-code/package.json'); process.exit(p.dsh?.bundle?.patch === './cordis.patch.yml' ? 0 : 1)"; then
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
fi

pnpm run build:desktop
