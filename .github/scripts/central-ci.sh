#!/usr/bin/env bash
# Central execution contract: invoked by fongap-labs/action-worker for its own pull requests.
set -Eeuo pipefail

TARGET_ROOT="${1:-}"
if [ -z "$TARGET_ROOT" ] || [ ! -d "$TARGET_ROOT" ]; then
  echo "central-ci: target root is required" >&2
  exit 64
fi

cd "$TARGET_ROOT"

npm ci
# Standard tools run here with fixed arguments, so a pull request cannot weaken them by editing the
# "lint" or "typecheck" scripts in package.json. Their configuration files and the repository-owned
# contract tests below are still part of the change under review.
npx --no-install biome check .
npx --no-install tsc --noEmit
npm test
