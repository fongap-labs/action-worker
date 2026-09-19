#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 4 ]; then
    echo "用法：detect-pr-context.sh <base-sha> <head-sha> <repo-root> <policy-dir>" >&2
    exit 64
fi

BASE="$1"
HEAD="$2"
ROOT="$3"
POLICY_DIR="$4"

WORKFLOW_POLICY="$POLICY_DIR/workflow.json"
SECURITY_POLICY="$POLICY_DIR/security.json"
RELEASE_POLICY="$POLICY_DIR/release.json"

for policy in "$WORKFLOW_POLICY" "$SECURITY_POLICY" "$RELEASE_POLICY"; do
    [ -f "$policy" ] || {
        echo "::error::缺少 context policy：$policy。" >&2
        exit 65
    }
done

cd "$ROOT"

mapfile -t changed_files < <(git diff --name-only --diff-filter=ACMR "$BASE" "$HEAD")

declare -A change_areas=()
# project_types is consumed through a Bash nameref in json_array_from_assoc.
declare -A project_types=()
declare -A impacts=()

add_area() {
    change_areas["$1"]=1
}

add_project() {
    # shellcheck disable=SC2034
    project_types["$1"]=1
}

add_impact() {
    impacts["$1"]=1
}

path_has_prefix() {
    local path="$1"
    local prefix
    while IFS= read -r prefix; do
        [ -n "$prefix" ] || continue
        if [[ "$path" == "$prefix"* ]]; then
            return 0
        fi
    done < <(jq -r '.path_prefixes[]' "$WORKFLOW_POLICY")
    return 1
}

path_has_security_term() {
    local path="${1,,}"
    local term
    while IFS= read -r term; do
        [ -n "$term" ] || continue
        if [[ "$path" == *"${term,,}"* ]]; then
            return 0
        fi
    done < <(jq -r '.path_terms[]' "$SECURITY_POLICY")
    return 1
}

is_changelog_file() {
    local path="$1"
    jq -e --arg path "$path" '.changelog_file == $path' "$RELEASE_POLICY" >/dev/null
}

for path in "${changed_files[@]}"; do
    if path_has_prefix "$path"; then
        add_area workflow
    elif [[ "$path" == scripts/* || "$path" == *.sh ]]; then
        add_area script
    elif [[ "$path" == tests/* || "$path" == test/* || "$path" == *_test.* || "$path" == *.test.* ]]; then
        add_area test
    elif [[ "$path" == Dockerfile || "$path" == */Dockerfile || "$path" == docker-compose.yml || "$path" == docker-compose.yaml || "$path" == compose.yml || "$path" == compose.yaml ]]; then
        add_area container
    elif is_changelog_file "$path"; then
        add_area release
    elif [[ "$path" == *.md || "$path" == docs/* ]]; then
        add_area documentation
    else
        add_area source
    fi

    if path_has_security_term "$path"; then
        add_area security
    fi
done

[ -f package.json ] && add_project node
[ -f Cargo.toml ] && add_project rust
[ -f pyproject.toml ] && add_project python
[ -f requirements.txt ] && add_project python
[ -f go.mod ] && add_project go
[ -f Dockerfile ] && add_project container
[ -d .github/workflows ] && add_project github-automation

changelog_changed=false
declared_text=""

while IFS= read -r changelog; do
    [ -n "$changelog" ] || continue
    if printf '%s\n' "${changed_files[@]}" | grep -Fxq "$changelog"; then
        changelog_changed=true
        additions="$(git diff --unified=0 "$BASE" "$HEAD" -- "$changelog"             | sed -n 's/^+[^+]/&/p'             | sed 's/^+//' || true)"
        declared_text+=$'\n'
        declared_text+="$additions"
    fi
done < <(jq -r '.changelog_file' "$RELEASE_POLICY")

matches_declared_impact() {
    local category="$1"
    local pattern
    local text="${declared_text,,}"

    while IFS= read -r pattern; do
        [ -n "$pattern" ] || continue
        if grep -Fqi -- "$pattern" <<< "$text"; then
            return 0
        fi
    done < <(jq -r --arg category "$category" '.impact_patterns[$category][]' "$RELEASE_POLICY")

    return 1
}

for category in breaking security migration api deployment performance compatibility release; do
    if matches_declared_impact "$category"; then
        add_impact "$category"
    fi
done

risk=low

if [[ -n "${change_areas[security]:-}" || -n "${impacts[security]:-}" || -n "${impacts[breaking]:-}" || -n "${impacts[migration]:-}" || -n "${impacts[deployment]:-}" ]]; then
    risk=high
elif [[ -n "${change_areas[source]:-}" || -n "${change_areas[workflow]:-}" || -n "${change_areas[script]:-}" || -n "${change_areas[container]:-}" || -n "${change_areas[release]:-}" || -n "${impacts[api]:-}" || -n "${impacts[performance]:-}" || -n "${impacts[compatibility]:-}" || -n "${impacts[release]:-}" ]]; then
    risk=medium
fi

json_array_from_assoc() {
    local -n assoc="$1"

    if [ "${#assoc[@]}" -eq 0 ]; then
        printf '[]'
        return
    fi

    printf '%s\n' "${!assoc[@]}" | sort | jq -R . | jq -s .
}

changed_json="$(printf '%s\n' "${changed_files[@]}" | jq -R . | jq -s .)"
project_json="$(json_array_from_assoc project_types)"
change_json="$(json_array_from_assoc change_areas)"
impact_json="$(json_array_from_assoc impacts)"

jq -n     --argjson changed_files "$changed_json"     --argjson project_types "$project_json"     --argjson change_areas "$change_json"     --argjson declared_impacts "$impact_json"     --argjson changelog_changed "$changelog_changed"     --arg risk "$risk"     '{
      changed_files: $changed_files,
      project_types: $project_types,
      change_areas: $change_areas,
      changelog_changed: $changelog_changed,
      declared_impacts: $declared_impacts,
      risk: $risk
    }'
