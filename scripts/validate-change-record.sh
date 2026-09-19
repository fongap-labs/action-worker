#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 5 ]; then
    echo "用法：validate-change-record.sh <pr-title> <base-sha> <head-sha> <repo-root> <policy-dir>" >&2
    exit 64
fi

TITLE="$1"
BASE="$2"
HEAD="$3"
ROOT="$4"
POLICY_DIR="$5"
POLICY="$POLICY_DIR/release.json"

fail() {
    echo "::error::$1" >&2
    exit "${2:-65}"
}

[ -f "$POLICY" ] || fail "缺少 release policy：$POLICY。"

title_pattern='^([a-z]+)(\(([A-Za-z0-9._/-]+)\))?(!)?:[[:space:]]+(.+)$'
if [[ ! "$TITLE" =~ $title_pattern ]]; then
    fail "PR 标题必须使用 type(scope)!: summary 格式。" 64
fi

change_type="${BASH_REMATCH[1]}"
scope="${BASH_REMATCH[3]:-}"
bang="${BASH_REMATCH[4]:-}"
summary="${BASH_REMATCH[5]}"

jq -e --arg type "$change_type" '.change_types | index($type) != null' "$POLICY" >/dev/null     || fail "不支持的变更类型：$change_type。" 64

[ -n "$summary" ] || fail "PR 标题 summary 不能为空。" 64

attributes='[]'
breaking=false
if [ "$bang" = "!" ]; then
    breaking=true
    attributes='["breaking"]'
fi

changelog_file="$(jq -r '.changelog_file' "$POLICY")"
changelog_required="$(jq -r --arg type "$change_type" '.changelog_required_types | index($type) != null' "$POLICY")"
if [ "$breaking" = "true" ]; then
    changelog_required=true
fi

cd "$ROOT"

changelog_changed=false
if git diff --name-only --diff-filter=ACMR "$BASE" "$HEAD" | grep -Fxq "$changelog_file"; then
    changelog_changed=true
fi

if [ "$changelog_required" = "true" ] && [ "$changelog_changed" != "true" ]; then
    fail "变更类型 $change_type 必须更新 $changelog_file。"
fi

if [ "$changelog_changed" = "true" ]; then
    [ -f "$changelog_file" ] || fail "$changelog_file 已删除或不存在。"

    grep -Fxq '## [Unreleased]' "$changelog_file"         || fail "$changelog_file 必须包含 ## [Unreleased]。"

    additions="$(git diff --unified=0 "$BASE" "$HEAD" -- "$changelog_file"         | sed -n 's/^+[^+]/&/p'         | sed 's/^+//' || true)"

    matching_entry=false
    entry_pattern='^- ([a-z]+)( \[([^]]+)\])?: (.+)$'

    while IFS= read -r line; do
        [[ "$line" == "- "* ]] || continue

        if [[ ! "$line" =~ $entry_pattern ]]; then
            fail "CHANGELOG 条目格式无效：$line"
        fi

        entry_type="${BASH_REMATCH[1]}"
        attr_text="${BASH_REMATCH[3]:-}"
        entry_summary="${BASH_REMATCH[4]}"

        jq -e --arg type "$entry_type" '.change_types | index($type) != null' "$POLICY" >/dev/null             || fail "CHANGELOG 使用了不支持的变更类型：$entry_type。"

        [ -n "$entry_summary" ] || fail "CHANGELOG summary 不能为空。"

        entry_attrs='[]'
        if [ -n "$attr_text" ]; then
            entry_attrs="$(printf '%s' "$attr_text"                 | tr ',' '\n'                 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'                 | sed '/^$/d'                 | jq -R .                 | jq -s 'unique')"

            allowed_attrs="$(jq -c '.change_attributes' "$POLICY")"
            jq -n -e              --argjson attrs "$entry_attrs"                 --argjson allowed "$allowed_attrs"                 '($attrs | length) > 0
                 and (($attrs - $allowed) | length) == 0'                 >/dev/null || fail "CHANGELOG 包含不支持的属性：$attr_text。"
        fi

        if [ "$entry_type" = "$change_type" ]; then
            matching_entry=true
            if [ "$breaking" = "true" ] && ! jq -e 'index("breaking") != null' <<< "$entry_attrs" >/dev/null; then
                fail "breaking PR 的 CHANGELOG 条目必须包含 breaking 属性。"
            fi
        fi
    done <<< "$additions"

    if [ "$changelog_required" = "true" ] && [ "$matching_entry" != "true" ]; then
        fail "CHANGELOG 必须新增至少一条与 PR Type '$change_type' 一致的记录。"
    fi
fi

jq -n     --arg type "$change_type"     --arg scope "$scope"     --arg summary "$summary"     --argjson attributes "$attributes"     --argjson changelog_required "$changelog_required"     --argjson changelog_changed "$changelog_changed"     '{
      schema_version: "1",
      type: $type,
      scope: (if $scope == "" then null else $scope end),
      attributes: $attributes,
      summary: $summary,
      changelog_required: $changelog_required,
      changelog_changed: $changelog_changed
    }'
