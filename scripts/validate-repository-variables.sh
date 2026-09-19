#!/usr/bin/env bash

set -Eeuo pipefail

SNAPSHOT="${RUNNER_TEMP:-}/action-worker-repository-vars.json"

fail() {
    echo "::error::$*" >&2
    exit 1
}

[ -f "$SNAPSHOT" ] || fail "Repository Variables snapshot is missing."

while IFS= read -r encoded; do
    [ -n "$encoded" ] || continue

    entry=$(printf '%s' "$encoded" | base64 --decode)
    name=$(printf '%s' "$entry" | jq -r '.key')
    expected=$(printf '%s' "$entry" | jq -r '.value // "" | tostring')

    case "$name" in
        GITHUB_*|RUNNER_*|ACTIONS_*|NODE_OPTIONS)
            continue
            ;;
    esac

    if [[ ! -v "$name" ]]; then
        fail "Repository Variable missing from runtime environment: $name"
    fi

    if [ "${!name}" != "$expected" ]; then
        fail "Repository Variable runtime collision: $name"
    fi
done < <(jq -r 'to_entries | sort_by(.key)[] | @base64' "$SNAPSHOT")

echo "Repository Variables runtime check passed."
