#!/usr/bin/env bash
# Centrally owned, one-time real build of Delta's first Harness source import.
# The PR cannot edit or replace this CI entry point. The sandbox has no write secrets.
set -Eeuo pipefail

target="${1:-}"
if [[ -z "$target" || ! -d "$target/.git" ]]; then
  echo "central-ci: Delta target checkout is missing" >&2
  exit 64
fi
cd "$target"

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 24 || (major === 24 && minor < 9)) process.exit(2)'
if ! command -v corepack >/dev/null 2>&1; then
  echo "central-ci: Corepack is required to run the pinned pnpm toolchain" >&2
  exit 68
fi
echo "central-ci: Delta product contract"
node scripts/delta-verify.mjs
echo "central-ci: pinned package dependencies"
corepack pnpm --version
corepack pnpm install --frozen-lockfile
echo "central-ci: desktop compilation"
corepack pnpm run build:desktop
echo "central-ci: Delta first-import desktop build passed"
