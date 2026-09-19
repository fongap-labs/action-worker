#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VALIDATOR="$ROOT/scripts/validate-review-result.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass() {
    local name="$1"
    local json="$2"
    local file="$TMP/$name.json"
    printf '%s\n' "$json" > "$file"
    bash "$VALIDATOR" "$file"
}

fail() {
    local name="$1"
    local json="$2"
    local file="$TMP/$name.json"
    printf '%s\n' "$json" > "$file"
    if bash "$VALIDATOR" "$file" >/dev/null 2>&1; then
        echo "ERROR: expected review result rejection: $name" >&2
        exit 1
    fi
}

pass manifest-complete '{"status":"complete","manifest":{"terminal_state":"complete"},"comments":[]}'
pass current-complete '{"status":"complete","comments":[]}'
pass legacy-success '{"status":"success","comments":[]}'

fail manifest-partial '{"status":"complete","manifest":{"terminal_state":"partial"},"comments":[]}'
fail manifest-failed '{"status":"success","manifest":{"terminal_state":"failed"},"comments":[]}'
fail current-failed '{"status":"failed","comments":[]}'
fail invalid-comments '{"status":"complete","comments":"invalid"}'

if bash "$VALIDATOR" "$TMP/missing.json" >/dev/null 2>&1; then
    echo "ERROR: missing result file must fail" >&2
    exit 1
fi

echo "Review result contract tests passed."
