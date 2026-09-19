#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export RUNNER_TEMP="$TMP"
export GITHUB_ENV="$TMP/github-env"
export REPOSITORY_VARS_JSON='{"ALPHA":"one","EMPTY":"","MULTI":"line1\nline2"}'

bash "$ROOT/scripts/export-repository-variables.sh"

SNAPSHOT="$TMP/action-worker-repository-vars.json"
[ -s "$SNAPSHOT" ]
jq -e '.ALPHA == "one" and .EMPTY == "" and .MULTI == "line1\nline2"' "$SNAPSHOT" >/dev/null
grep -q '^ALPHA<<' "$GITHUB_ENV"
grep -q '^MULTI<<' "$GITHUB_ENV"

export ALPHA="one"
export EMPTY=""
export MULTI=$'line1\nline2'
bash "$ROOT/scripts/validate-repository-variables.sh"

export ALPHA="overridden"
if bash "$ROOT/scripts/validate-repository-variables.sh" >/dev/null 2>&1; then
    echo "ERROR: collision check should fail when a runtime value overrides a repository variable." >&2
    exit 1
fi

echo "Repository Variables transport tests passed."
