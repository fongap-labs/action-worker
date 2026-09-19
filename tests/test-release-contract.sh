#!/usr/bin/env bash
set -Eeuo pipefail

HANDLER=".github/workflows/handle-release-dispatch.yml"
VALIDATOR="scripts/validate-release-request.sh"
PUBLISHER="scripts/publish-release.sh"
DISPATCH_CONTRACT="contracts/release-dispatch.json"
MANIFEST_CONTRACT="contracts/release-manifest.json"

for path in "$HANDLER" "$VALIDATOR" "$PUBLISHER" "$DISPATCH_CONTRACT" "$MANIFEST_CONTRACT"; do
  [ -f "$path" ] || {
    echo "ERROR: release contract path not found: $path" >&2
    exit 1
  }
done

require_in() {
  local file="$1"
  local value="$2"
  grep -qF -- "$value" "$file" || {
    echo "ERROR: missing release contract in $file: $value" >&2
    exit 1
  }
}

require_in "$HANDLER" "types: [run-release]"
require_in "$HANDLER" "GH_CONTROL_TOKEN"
require_in "$HANDLER" "GH_RELEASE_TOKEN"
require_in "$HANDLER" "RELEASE_SOURCE_ALLOWLIST"
require_in "$HANDLER" "RELEASE_TARGET_ALLOWLIST"
require_in "$HANDLER" 'scripts/publish-release.sh "$RUNNER_TEMP/release-request.json"'

require_in "$PUBLISHER" 'gh run list'
require_in "$PUBLISHER" '--workflow ci.yml'
require_in "$PUBLISHER" 'actions/runs/$source_run_id'
require_in "$PUBLISHER" 'actions/artifacts/$artifact_id/zip'
require_in "$PUBLISHER" 'release-manifest.json'
require_in "$PUBLISHER" 'tag="$release_key-v$version"'
require_in "$PUBLISHER" 'sha256sum "$asset_path"'
require_in "$PUBLISHER" 'gh release upload'
require_in "$PUBLISHER" 'gh release download'
require_in "$PUBLISHER" 'rollback_release'
require_in "$PUBLISHER" '.license.expression // "Apache-2.0"'
require_in "$PUBLISHER" 'License: $license_expression'
require_in "$PUBLISHER" '-F draft=true'
require_in "$PUBLISHER" '-F draft=false'

if [ -e ".github/workflows/validate-release-policy.yml" ]; then
  echo "ERROR: legacy validate-release-policy.yml must be removed." >&2
  exit 1
fi

if [ -e ".github/workflows/publish-release.yml" ]; then
  echo "ERROR: legacy publish-release.yml must be removed." >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cat > "$tmp_dir/request.json" <<'JSON'
{
  "schema_version": "1",
  "request_id": "release-test-001",
  "repository": "fongap/source-repo",
  "source_sha": "0123456789abcdef0123456789abcdef01234567",
  "source_run_id": 123,
  "artifact_name": "release-package"
}
JSON

cat > "$tmp_dir/manifest.json" <<'JSON'
{
  "schema_version": "1",
  "target_repository": "fongap/external-vault",
  "release_key": "example-tool",
  "version": "0.1.0",
  "release_name": "Example Tool 0.1.0",
  "release_notes": "Test release.",
  "prerelease": false,
  "license": {
    "expression": "Apache-2.0"
  },
  "assets": [
    {
      "name": "example-tool-linux-x64.tar.gz",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  ]
}
JSON

RELEASE_SOURCE_ALLOWLIST='["fongap/source-repo"]' RELEASE_TARGET_ALLOWLIST='["fongap/external-vault"]'   bash "$VALIDATOR" "$tmp_dir/request.json" "$tmp_dir/manifest.json"

jq 'del(.license)' "$tmp_dir/manifest.json" > "$tmp_dir/default-license-manifest.json"
RELEASE_SOURCE_ALLOWLIST='["fongap/source-repo"]' RELEASE_TARGET_ALLOWLIST='["fongap/external-vault"]'   bash "$VALIDATOR" "$tmp_dir/request.json" "$tmp_dir/default-license-manifest.json"

jq '.license = {"expression":"MPL-2.0","file":"LICENSE.txt"} | .assets += [{"name":"LICENSE.txt","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]' "$tmp_dir/manifest.json" > "$tmp_dir/custom-license-manifest.json"
RELEASE_SOURCE_ALLOWLIST='["fongap/source-repo"]' RELEASE_TARGET_ALLOWLIST='["fongap/external-vault"]'   bash "$VALIDATOR" "$tmp_dir/request.json" "$tmp_dir/custom-license-manifest.json"

jq '.license = {"expression":"MPL-2.0","file":"LICENSE.txt"}' "$tmp_dir/manifest.json" > "$tmp_dir/missing-license-file-manifest.json"
if RELEASE_SOURCE_ALLOWLIST='["fongap/source-repo"]' RELEASE_TARGET_ALLOWLIST='["fongap/external-vault"]' bash "$VALIDATOR" "$tmp_dir/request.json" "$tmp_dir/missing-license-file-manifest.json"; then
  echo "ERROR: missing declared license file was accepted." >&2
  exit 1
fi

jq '.release_key = "Example Tool"' "$tmp_dir/manifest.json" > "$tmp_dir/invalid-manifest.json"

if RELEASE_SOURCE_ALLOWLIST='["fongap/source-repo"]'    RELEASE_TARGET_ALLOWLIST='["fongap/external-vault"]'    bash "$VALIDATOR" "$tmp_dir/request.json" "$tmp_dir/invalid-manifest.json"; then
  echo "ERROR: invalid release key was accepted." >&2
  exit 1
fi

if RELEASE_SOURCE_ALLOWLIST='["fongap/other-repo"]'    RELEASE_TARGET_ALLOWLIST='["fongap/external-vault"]'    bash "$VALIDATOR" "$tmp_dir/request.json"; then
  echo "ERROR: unapproved release source was accepted." >&2
  exit 1
fi

echo "Release contract tests passed."
