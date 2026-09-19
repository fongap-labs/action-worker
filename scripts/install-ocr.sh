#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 4 ]; then
    echo "Usage: install-ocr.sh <repository> <version> <asset> <cache-dir>" >&2
    exit 64
fi

repository="$1"
version="$2"
asset="$3"
cache_dir="$4"

[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || exit 65
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 65
[[ "$asset" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || exit 65
[ -n "$cache_dir" ] || exit 65

release_tag="open-code-review-v$version"
binary="$cache_dir/$asset"
checksum="$cache_dir/$asset.sha256"

mkdir -p "$cache_dir" "$HOME/.local/bin"

verify() {
    [ -s "$binary" ] && [ -s "$checksum" ] || return 1
    (
      cd "$cache_dir"
      sha256sum -c "$asset.sha256" >/dev/null
    )
}

if ! verify; then
    rm -f "$binary" "$checksum"
    base_url="https://github.com/$repository/releases/download/$release_tag"
    curl -fsSL --retry 3 --retry-delay 2 "$base_url/$asset" -o "$binary"
    curl -fsSL --retry 3 --retry-delay 2 "$base_url/$asset.sha256" -o "$checksum"
    verify

fi

install -m 0755 "$binary" "$HOME/.local/bin/ocr"
echo "$HOME/.local/bin" >> "${GITHUB_PATH:-/dev/null}"
"$HOME/.local/bin/ocr" --version
