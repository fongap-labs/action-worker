#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VALIDATOR="$ROOT/scripts/validate-change-record.sh"
POLICIES="$ROOT/policies"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git -C "$TMP" init -q
git -C "$TMP" config user.name test
git -C "$TMP" config user.email test@example.com

cat > "$TMP/README.md" <<'EOF'
# Fixture
EOF

cat > "$TMP/CHANGELOG.md" <<'EOF'
# Changelog

## [Unreleased]
EOF

git -C "$TMP" add .
git -C "$TMP" commit -qm base
BASE="$(git -C "$TMP" rev-parse HEAD)"

printf '\nmore docs\n' >> "$TMP/README.md"
git -C "$TMP" add README.md
git -C "$TMP" commit -qm docs
DOCS_HEAD="$(git -C "$TMP" rev-parse HEAD)"

docs_record="$(bash "$VALIDATOR" "docs: clarify setup" "$BASE" "$DOCS_HEAD" "$TMP" "$POLICIES")"
jq -e '
  .type == "docs"
  and .attributes == []
  and .changelog_required == false
  and .changelog_changed == false
' <<< "$docs_record" >/dev/null

if bash "$VALIDATOR" "feature: invalid type" "$BASE" "$DOCS_HEAD" "$TMP" "$POLICIES" >/dev/null 2>&1; then
    echo "ERROR: invalid type should fail." >&2
    exit 1
fi

if bash "$VALIDATOR" "feat: add feature" "$BASE" "$DOCS_HEAD" "$TMP" "$POLICIES" >/dev/null 2>&1; then
    echo "ERROR: feat without changelog should fail." >&2
    exit 1
fi

git -C "$TMP" reset --hard -q "$BASE"
printf '\nfeature\n' >> "$TMP/README.md"
cat >> "$TMP/CHANGELOG.md" <<'EOF'
- feat: 增加示例能力。
EOF
git -C "$TMP" add .
git -C "$TMP" commit -qm feat
FEAT_HEAD="$(git -C "$TMP" rev-parse HEAD)"

feat_record="$(bash "$VALIDATOR" "feat(core): add example capability" "$BASE" "$FEAT_HEAD" "$TMP" "$POLICIES")"
jq -e '
  .type == "feat"
  and .scope == "core"
  and .changelog_required == true
  and .changelog_changed == true
' <<< "$feat_record" >/dev/null

git -C "$TMP" reset --hard -q "$BASE"
printf '\nbreaking\n' >> "$TMP/README.md"
cat >> "$TMP/CHANGELOG.md" <<'EOF'
- feat [breaking, migration]: 替换旧接口。
EOF
git -C "$TMP" add .
git -C "$TMP" commit -qm breaking
BREAKING_HEAD="$(git -C "$TMP" rev-parse HEAD)"

breaking_record="$(bash "$VALIDATOR" "feat(api)!: replace legacy contract" "$BASE" "$BREAKING_HEAD" "$TMP" "$POLICIES")"
jq -e '
  .type == "feat"
  and (.attributes | index("breaking")) != null
  and .changelog_required == true
' <<< "$breaking_record" >/dev/null

git -C "$TMP" reset --hard -q "$BASE"
printf '\nbad attr\n' >> "$TMP/README.md"
cat >> "$TMP/CHANGELOG.md" <<'EOF'
- fix [urgent]: 修复问题。
EOF
git -C "$TMP" add .
git -C "$TMP" commit -qm bad
BAD_HEAD="$(git -C "$TMP" rev-parse HEAD)"

if bash "$VALIDATOR" "fix: repair issue" "$BASE" "$BAD_HEAD" "$TMP" "$POLICIES" >/dev/null 2>&1; then
    echo "ERROR: unknown changelog attribute should fail." >&2
    exit 1
fi

echo "Change record tests passed."
