#!/usr/bin/env bash

set -Eeuo pipefail

SNAPSHOT="${RUNNER_TEMP:-}/action-worker-repository-vars.json"

fail() {
    echo "::error::$*" >&2
    exit 1
}

[ -n "${RUNNER_TEMP:-}" ] || fail "RUNNER_TEMP is not set."
[ -n "${GITHUB_ENV:-}" ] || fail "GITHUB_ENV is not set."

raw="${REPOSITORY_VARS_JSON:-}"
[ -n "$raw" ] || raw='{}'

printf '%s' "$raw" | jq -e 'type == "object"' >/dev/null \
    || fail "Repository Variables payload must be a JSON object."

invalid=$(printf '%s' "$raw" | jq -r '
    keys[]
    | select(test("^[A-Za-z_][A-Za-z0-9_]*$") | not)
' | head -n 1)

[ -z "$invalid" ] || fail "Invalid Repository Variable name: $invalid"

printf '%s' "$raw" | jq -c 'to_entries | sort_by(.key) | from_entries' > "$SNAPSHOT"
chmod 600 "$SNAPSHOT"

count=0
while IFS= read -r encoded; do
    [ -n "$encoded" ] || continue

    entry=$(printf '%s' "$encoded" | base64 --decode)
    name=$(printf '%s' "$entry" | jq -r '.key')
    value=$(printf '%s' "$entry" | jq -r '.value // "" | tostring')

    case "$name" in
        GITHUB_*|RUNNER_*|ACTIONS_*|NODE_OPTIONS)
            continue
            ;;
    esac

    delimiter="__ACTION_WORKER_VAR_${RANDOM}_${RANDOM}_$$__"
    while grep -Fqx "$delimiter" <<< "$value"; do
        delimiter="__ACTION_WORKER_VAR_${RANDOM}_${RANDOM}_$$__"
    done

    {
        printf '%s<<%s\n' "$name" "$delimiter"
        printf '%s\n' "$value"
        printf '%s\n' "$delimiter"
    } >> "$GITHUB_ENV"

    count=$((count + 1))
done < <(printf '%s' "$raw" | jq -r 'to_entries | sort_by(.key)[] | @base64')

echo "Repository Variables exported: $count"
