#!/usr/bin/env bash
# Trusted central entrypoint for Delta's source-owned desktop build contract.
set -Eeuo pipefail

TARGET_ROOT="${1:-}"
if [[ -z "$TARGET_ROOT" || ! -d "$TARGET_ROOT/.git" ]]; then
  echo "central-ci: verified source root is required" >&2
  exit 64
fi
cd "$TARGET_ROOT"

node scripts/delta-verify.mjs
node -e 'const v = Number(process.versions.node.split(".")[0]); if (v < 24) process.exit(2)'
if ! command -v pnpm >/dev/null 2>&1; then
  echo "central-ci: pnpm 11.28.5 is required on the trusted runner" >&2
  exit 68
fi
pnpm install --frozen-lockfile
pnpm run build:desktop
