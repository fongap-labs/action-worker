#!/usr/bin/env bash
# Trusted central entrypoint for Delta's source-owned desktop build contract.
set -Eeuo pipefail

TARGET_ROOT="${1:-}"
if [[ -z "$TARGET_ROOT" || ! -d "$TARGET_ROOT/.git" ]]; then
  echo "central-ci: verified source root is required" >&2
  exit 64
fi
# The common sandbox runs Node 22 for other repositories. Bootstrap only
# this job's pinned Node/pnpm toolchain in a throwaway, credential-free directory.
runtime_root="$(mktemp -d "${RUNNER_TEMP:-/tmp}/delta-desktop-runtime.XXXXXX")"
trap 'rm -rf "$runtime_root"' EXIT
npm install --prefix "$runtime_root" --no-audit --no-fund --no-save --package-lock=false \
  node@24.11.1 pnpm@11.28.5
export PATH="$runtime_root/node_modules/.bin:$PATH"
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major !== 24 || minor < 9) process.exit(2)'
test "$(pnpm --version)" = "11.28.5"

cd "$TARGET_ROOT"
node scripts/delta-verify.mjs
pnpm install --frozen-lockfile
pnpm run build:desktop
