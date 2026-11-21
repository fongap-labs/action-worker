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
pnpm run build:desktop
