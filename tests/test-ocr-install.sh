#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

asset="open-code-review-linux-amd64"
cache="$TMP/cache"
fakebin="$TMP/bin"
mkdir -p "$cache" "$fakebin"

cat > "$cache/$asset" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then
  echo "OpenCodeReview test"
  exit 0
fi
exit 0
SH
chmod +x "$cache/$asset"
(
  cd "$cache"
  sha256sum "$asset" > "$asset.sha256"
)

cat > "$fakebin/curl" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "$FAKE_CURL_LOG"
exit 22
SH
chmod +x "$fakebin/curl"

export PATH="$fakebin:$PATH"
export HOME="$TMP/home"
export GITHUB_PATH="$TMP/github-path"
export FAKE_CURL_LOG="$TMP/curl.log"
mkdir -p "$HOME"

bash "$ROOT/scripts/install-ocr.sh" owner/repo 1.2.3 "$asset" "$cache"
"$HOME/.local/bin/ocr" --version | grep -qF "OpenCodeReview test"
grep -qF "$HOME/.local/bin" "$GITHUB_PATH"
[ ! -e "$FAKE_CURL_LOG" ] || {
  echo "ERROR: verified cache hit must not download OCR." >&2
  exit 1
}

rm -rf "$cache"
if bash "$ROOT/scripts/install-ocr.sh" owner/repo 1.2.3 "$asset" "$cache"; then
  echo "ERROR: missing release asset must fail closed." >&2
  exit 1
fi
[ -s "$FAKE_CURL_LOG" ] || {
  echo "ERROR: missing cache must attempt the release download." >&2
  exit 1
}

if grep -qE 'npm[[:space:]]+install|@alibaba-group/open-code-review' "$ROOT/scripts/install-ocr.sh"; then
  echo "ERROR: OCR installer must not contain an npm bootstrap path." >&2
  exit 1
fi

echo "OCR release-only installer tests passed."
