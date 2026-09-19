#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/gh" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail

if [ "${1:-}" != "api" ]; then
    exit 64
fi

case "${FAKE_STATUS_OWNER:-current}" in
    current)
        cat <<'JSON'
{"statuses":[
  {"context":"PR Governance","target_url":"https://example.test/older","created_at":"2026-09-18T21:00:00Z"},
  {"context":"Other","target_url":"https://example.test/other","created_at":"2026-09-18T23:00:00Z"},
  {"context":"PR Governance","target_url":"https://example.test/current","created_at":"2026-09-18T22:00:00Z"}
]}
JSON
        ;;
    stale)
        cat <<'JSON'
{"statuses":[
  {"context":"PR Governance","target_url":"https://example.test/current","created_at":"2026-09-18T21:00:00Z"},
  {"context":"PR Governance","target_url":"https://example.test/newer","created_at":"2026-09-18T22:00:00Z"}
]}
JSON
        ;;
    *)
        exit 64
        ;;
esac
SH
chmod +x "$TMP/gh"

export PATH="$TMP:$PATH"
export GH_TOKEN=test-token
sha="0123456789abcdef0123456789abcdef01234567"

FAKE_STATUS_OWNER=current bash "$ROOT/scripts/check-status-owner.sh" \
    "fongap/example" "$sha" "https://example.test/current" >/dev/null

if FAKE_STATUS_OWNER=stale bash "$ROOT/scripts/check-status-owner.sh" \
    "fongap/example" "$sha" "https://example.test/current" >/dev/null 2>&1; then
    echo "ERROR: stale governance run retained status ownership." >&2
    exit 1
fi

echo "PR status ownership tests passed."
