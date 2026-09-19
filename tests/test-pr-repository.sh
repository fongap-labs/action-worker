#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VALIDATOR="$ROOT/scripts/validate-pr-repository.sh"

[ -f "$VALIDATOR" ] || {
    echo "ERROR: missing repository validator." >&2
    exit 1
}

GOOD='["fongap/example","other/repository"]'

PR_REPOSITORY_ALLOWLIST="$GOOD"     bash "$VALIDATOR" "fongap/example" >/dev/null

if PR_REPOSITORY_ALLOWLIST="$GOOD"     bash "$VALIDATOR" "fongap/blocked" >/dev/null 2>&1; then
    echo "ERROR: non-allowlisted repository should be rejected." >&2
    exit 1
fi

for bad in     ''     '{}'     '[]'     '["bad"]'     '["fongap/example","fongap/example"]'
do
    if PR_REPOSITORY_ALLOWLIST="$bad"         bash "$VALIDATOR" "fongap/example" >/dev/null 2>&1; then
        echo "ERROR: invalid allowlist accepted: $bad" >&2
        exit 1
    fi
done

if PR_REPOSITORY_ALLOWLIST="$GOOD"     bash "$VALIDATOR" "bad/repo/name" >/dev/null 2>&1; then
    echo "ERROR: invalid repository name should be rejected." >&2
    exit 1
fi

echo "PR repository allowlist tests passed."
