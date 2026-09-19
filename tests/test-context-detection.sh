#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DETECTOR="$ROOT/scripts/detect-pr-context.sh"
POLICIES="$ROOT/policies"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git -C "$TMP" init -q
git -C "$TMP" config user.name test
git -C "$TMP" config user.email test@example.com

cat > "$TMP/package.json" <<'EOF'
{"name":"fixture"}
EOF
cat > "$TMP/README.md" <<'EOF'
# Fixture
EOF

git -C "$TMP" add .
git -C "$TMP" commit -qm base
BASE="$(git -C "$TMP" rev-parse HEAD)"

mkdir -p "$TMP/.github/workflows"
cat > "$TMP/.github/workflows/release.yml" <<'EOF'
name: Release
EOF
cat > "$TMP/CHANGELOG.md" <<'EOF'
# Changelog

- Breaking API migration affecting deployment compatibility.
EOF

git -C "$TMP" add .
git -C "$TMP" commit -qm head
HEAD="$(git -C "$TMP" rev-parse HEAD)"

context="$(bash "$DETECTOR" "$BASE" "$HEAD" "$TMP" "$POLICIES")"

jq -e '
  (.project_types | index("node")) != null
  and (.project_types | index("github-automation")) != null
  and (.change_areas | index("workflow")) != null
  and (.change_areas | index("release")) != null
  and .changelog_changed == true
  and (.declared_impacts | index("breaking")) != null
  and (.declared_impacts | index("api")) != null
  and (.declared_impacts | index("migration")) != null
  and (.declared_impacts | index("deployment")) != null
  and (.declared_impacts | index("compatibility")) != null
  and .risk == "high"
' <<< "$context" >/dev/null

echo "PR context detection tests passed."
