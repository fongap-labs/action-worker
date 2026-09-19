#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 4 ]; then
    echo "Usage: build-review-comparison.sh <repository-path> <base-sha> <head-sha> <evidence-path>" >&2
    exit 64
fi

repository_path="$1"
base_sha="$2"
head_sha="$3"
evidence_path="$4"

[ "$evidence_path" = ".action-worker-ci-evidence.json" ] || {
    echo "ERROR: unexpected CI evidence path: $evidence_path" >&2
    exit 65
}
[[ "$base_sha" =~ ^[0-9a-f]{40}$ ]] || {
    echo "ERROR: invalid base SHA." >&2
    exit 65
}
[[ "$head_sha" =~ ^[0-9a-f]{40}$ ]] || {
    echo "ERROR: invalid head SHA." >&2
    exit 65
}
[ "$(git -C "$repository_path" rev-parse --is-inside-work-tree 2>/dev/null)" = "true" ] || {
    echo "ERROR: review repository is not a Git worktree." >&2
    exit 65
}
[ -f "$repository_path/$evidence_path" ] && [ ! -L "$repository_path/$evidence_path" ] || {
    echo "ERROR: controlled CI evidence file is missing or unsafe." >&2
    exit 65
}
git -C "$repository_path" cat-file -e "$base_sha^{commit}"
git -C "$repository_path" cat-file -e "$head_sha^{commit}"

temporary_directory="$(mktemp -d)"
base_index="$temporary_directory/base.index"
head_index="$temporary_directory/head.index"
trap 'rm -f "$base_index" "$base_index.lock" "$head_index" "$head_index.lock"; rmdir "$temporary_directory" 2>/dev/null || true' EXIT

GIT_INDEX_FILE="$base_index" git -C "$repository_path" read-tree "$base_sha"
GIT_INDEX_FILE="$base_index" git -C "$repository_path" add --force -- "$evidence_path"
base_tree="$(GIT_INDEX_FILE="$base_index" git -C "$repository_path" write-tree)"
review_base_sha="$(
    printf '%s\n' "Inject Action Worker CI evidence at review base" |
        git -C "$repository_path" \
            -c user.name="Action Worker" \
            -c user.email="action-worker@users.noreply.github.com" \
            commit-tree "$base_tree" -p "$base_sha"
)"

GIT_INDEX_FILE="$head_index" git -C "$repository_path" read-tree "$head_sha"
GIT_INDEX_FILE="$head_index" git -C "$repository_path" add --force -- "$evidence_path"
head_tree="$(GIT_INDEX_FILE="$head_index" git -C "$repository_path" write-tree)"
review_head_sha="$(
    printf '%s\n' "Inject Action Worker CI evidence at review head" |
        git -C "$repository_path" \
            -c user.name="Action Worker" \
            -c user.email="action-worker@users.noreply.github.com" \
            commit-tree "$head_tree" -p "$head_sha" -p "$review_base_sha"
)"

[[ "$review_base_sha" =~ ^[0-9a-f]{40}$ ]] || {
    echo "ERROR: failed to create review base commit." >&2
    exit 1
}
[[ "$review_head_sha" =~ ^[0-9a-f]{40}$ ]] || {
    echo "ERROR: failed to create review head commit." >&2
    exit 1
}

jq -cn \
    --arg base_sha "$review_base_sha" \
    --arg head_sha "$review_head_sha" \
    '{base_sha: $base_sha, head_sha: $head_sha}'
