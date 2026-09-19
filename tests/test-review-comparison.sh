#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git -C "$TMP" init -q
git -C "$TMP" config user.name "Test"
git -C "$TMP" config user.email "test@example.com"

printf '%s\n' "base" > "$TMP/source.txt"
git -C "$TMP" add source.txt
git -C "$TMP" commit -q -m "base"
base_sha="$(git -C "$TMP" rev-parse HEAD)"

printf '%s\n' "head" > "$TMP/source.txt"
git -C "$TMP" add source.txt
git -C "$TMP" commit -q -m "head"
head_sha="$(git -C "$TMP" rev-parse HEAD)"

printf '%s\n' '{"conclusion":"success"}' > "$TMP/.action-worker-ci-evidence.json"
comparison="$(
    bash "$ROOT/scripts/build-review-comparison.sh" \
        "$TMP" \
        "$base_sha" \
        "$head_sha" \
        .action-worker-ci-evidence.json
)"
review_base_sha="$(jq -r '.base_sha' <<< "$comparison")"
review_head_sha="$(jq -r '.head_sha' <<< "$comparison")"

[ "$(git -C "$TMP" show "$review_head_sha:.action-worker-ci-evidence.json")" = '{"conclusion":"success"}' ] || {
    echo "ERROR: review head cannot read controlled CI evidence." >&2
    exit 1
}
[ "$(git -C "$TMP" show "$review_base_sha:.action-worker-ci-evidence.json")" = '{"conclusion":"success"}' ] || {
    echo "ERROR: review base does not contain matching controlled CI evidence." >&2
    exit 1
}
[ "$(git -C "$TMP" diff --name-only "$review_base_sha" "$review_head_sha")" = "source.txt" ] || {
    echo "ERROR: controlled CI evidence leaked into the reviewed diff." >&2
    exit 1
}

echo "Review comparison tests passed."
