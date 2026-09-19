#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 2 ]; then
    echo "用法：validate-naming-rules.sh <base-sha> <head-sha>" >&2
    exit 64
fi

BASE="$1"
HEAD="$2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mapfile -t files < <(git diff --name-only --diff-filter=ACMR "$BASE" "$HEAD")

failures=0
warnings=0

is_three_part_kebab() {
    local stem="$1"
    [[ "$stem" =~ ^[a-z0-9]+(-[a-z0-9]+){0,2}$ ]]
}

is_canonical_document() {
    local name="$1"
    [[ "$name" =~ ^[A-Z0-9]+(_[A-Z0-9]+)*\.md$ ]]
}

is_native_exception() {
    local name="$1"
    case "$name" in
        README.md|LICENSE|LICENSE.md|CHANGELOG.md|CONTRIBUTING.md|SECURITY.md|CODEOWNERS|Dockerfile|Makefile|Cargo.toml|Cargo.lock|package.json|package-lock.json|pnpm-lock.yaml|yarn.lock|tsconfig.json|pyproject.toml|requirements.txt)
            return 0
            ;;
    esac
    return 1
}

echo "检查 ${#files[@]} 个本次变更路径"

for path in "${files[@]}"; do
    base="$(basename "$path")"
    stem="${base%.*}"
    ext="${base##*.}"

    if is_native_exception "$base"; then
        continue
    fi

    if [[ "$ext" == "md" && "$base" =~ ^[A-Z0-9_]+\.md$ ]]; then
        if ! is_canonical_document "$base"; then
            echo "::error file=$path::规范文档必须使用 UPPER_SNAKE_CASE.md。"
            failures=$((failures + 1))
        fi
        continue
    fi

    if [[ "$path" == .github/workflows/* || "$ext" == "sh" ]]; then
        if ! is_three_part_kebab "$stem"; then
            echo "::error file=$path::Workflow、Shell 与测试文件必须使用 kebab-case，且最多三段。"
            failures=$((failures + 1))
        fi
    fi

    if [[ "$stem" =~ (^|[-_.])(new|final|latest|temp|tmp)([-_.]|$) ]]; then
        echo "::error file=$path::长期文件名禁止使用 new/final/latest/temp/tmp 等临时生命周期词。"
        failures=$((failures + 1))
    fi

    if [[ "$stem" =~ ^(utils?|helpers?|common|misc|shared)$ ]]; then
        echo "::warning file=$path::文件名 '$base' 语义过于宽泛，建议按具体职责命名。"
        warnings=$((warnings + 1))
    fi
done

if ! python3 "$SCRIPT_DIR/validate-source-naming.py" "$BASE" "$HEAD"; then
    failures=$((failures + 1))
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
        echo "## 命名规则"
        echo
        echo "- 本次变更路径：${#files[@]}"
        echo "- 错误：$failures"
        echo "- 警告：$warnings"
        echo
        echo "规则：最多三段；一个概念一个标准词。"
    } >> "$GITHUB_STEP_SUMMARY"
fi

if (( failures > 0 )); then
    exit 1
fi
