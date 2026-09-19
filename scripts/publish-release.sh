#!/usr/bin/env bash
set -Eeuo pipefail

request_path="${1:-}"

[ -n "$request_path" ] && [ -f "$request_path" ] || {
  echo "release request file is required." >&2
  exit 64
}

for command_name in gh jq unzip sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "$command_name is required." >&2
    exit 69
  }
done

[ -n "${GITHUB_CONTROL_TOKEN:-}" ] || {
  echo "GITHUB_CONTROL_TOKEN is required." >&2
  exit 77
}

[ -n "${GITHUB_RELEASE_TOKEN:-}" ] || {
  echo "GITHUB_RELEASE_TOKEN is required." >&2
  exit 77
}

bash "$(dirname "$0")/validate-release-request.sh" "$request_path"

source_repository="$(jq -r '.repository' "$request_path")"
source_sha="$(jq -r '.source_sha' "$request_path")"
source_run_id="$(jq -r '.source_run_id' "$request_path")"
artifact_name="$(jq -r '.artifact_name' "$request_path")"
request_id="$(jq -r '.request_id' "$request_path")"

export GH_TOKEN="$GITHUB_CONTROL_TOKEN"

default_branch="$(gh api "repos/$source_repository" --jq '.default_branch')"
default_sha="$(gh api "repos/$source_repository/commits/$default_branch" --jq '.sha')"

if [ "$source_sha" != "$default_sha" ]; then
  echo "::error::Release source must be the current default-branch HEAD: expected=$default_sha actual=$source_sha." >&2
  exit 65
fi

run_json="$(gh api "repos/$source_repository/actions/runs/$source_run_id")"
run_repository="$(jq -r '.repository.full_name' <<< "$run_json")"
run_sha="$(jq -r '.head_sha' <<< "$run_json")"
run_status="$(jq -r '.status' <<< "$run_json")"
run_conclusion="$(jq -r '.conclusion // ""' <<< "$run_json")"

if [ "$run_repository" != "$source_repository" ] || [ "$run_sha" != "$source_sha" ]; then
  echo "::error::Source run does not match the requested repository and commit." >&2
  exit 65
fi

if [ "$run_status" != "completed" ] || [ "$run_conclusion" != "success" ]; then
  echo "::error::Source run must be completed successfully: run=$source_run_id status=$run_status conclusion=$run_conclusion." >&2
  exit 65
fi

ci_runs="$(
  gh run list     --repo "$source_repository"     --workflow ci.yml     --commit "$source_sha"     --limit 20     --json status,conclusion,headSha,databaseId
)"

ci_run_id="$(
  jq -r --arg sha "$source_sha" '
    [
      .[]
      | select(
          .headSha == $sha
          and .status == "completed"
          and .conclusion == "success"
        )
    ]
    | sort_by(.databaseId)
    | reverse
    | .[0].databaseId // empty
  ' <<< "$ci_runs"
)"

[ -n "$ci_run_id" ] || {
  echo "::error::No successful ci.yml run found for source commit: $source_sha." >&2
  exit 65
}

artifact_json="$(gh api "repos/$source_repository/actions/runs/$source_run_id/artifacts?per_page=100")"
artifact_count="$(
  jq --arg name "$artifact_name" '
    [.artifacts[] | select(.name == $name and .expired == false)] | length
  ' <<< "$artifact_json"
)"

if [ "$artifact_count" -ne 1 ]; then
  echo "::error::Expected exactly one non-expired artifact named $artifact_name; found $artifact_count." >&2
  exit 66
fi

artifact_id="$(
  jq -r --arg name "$artifact_name" '
    .artifacts[]
    | select(.name == $name and .expired == false)
    | .id
  ' <<< "$artifact_json"
)"

work_dir="$(mktemp -d)"
archive_path="$work_dir/artifact.zip"
artifact_dir="$work_dir/artifact"
mkdir -p "$artifact_dir"

gh api "repos/$source_repository/actions/artifacts/$artifact_id/zip" > "$archive_path"
unzip -q "$archive_path" -d "$artifact_dir"

manifest_path="$artifact_dir/release-manifest.json"
bash "$(dirname "$0")/validate-release-request.sh" "$request_path" "$manifest_path"

if find "$artifact_dir" -mindepth 2 -type f -print -quit | grep -q .; then
  echo "::error::Release artifact must contain only root-level files." >&2
  exit 66
fi

mapfile -t actual_files < <(
  find "$artifact_dir" -maxdepth 1 -type f ! -name 'release-manifest.json' -printf '%f\n' | LC_ALL=C sort
)
mapfile -t expected_files < <(
  jq -r '.assets[].name' "$manifest_path" | LC_ALL=C sort
)

if [ "$(printf '%s\n' "${actual_files[@]}")" != "$(printf '%s\n' "${expected_files[@]}")" ]; then
  echo "::error::Artifact files do not match release-manifest.json." >&2
  printf 'expected: %s\n' "${expected_files[*]}" >&2
  printf 'actual:   %s\n' "${actual_files[*]}" >&2
  exit 66
fi

while IFS=$'\t' read -r asset_name expected_hash; do
  asset_path="$artifact_dir/$asset_name"
  actual_hash="$(sha256sum "$asset_path" | awk '{print $1}')"

  if [ "$actual_hash" != "$expected_hash" ]; then
    echo "::error::Artifact SHA256 verification failed: $asset_name." >&2
    exit 66
  fi

  printf '%s  %s\n' "$expected_hash" "$asset_name" > "$artifact_dir/$asset_name.sha256"
done < <(jq -r '.assets[] | [.name, .sha256] | @tsv' "$manifest_path")

target_repository="$(jq -r '.target_repository' "$manifest_path")"
release_key="$(jq -r '.release_key' "$manifest_path")"
version="$(jq -r '.version' "$manifest_path")"
release_name="$(jq -r '.release_name // empty' "$manifest_path")"
release_notes="$(jq -r '.release_notes // empty' "$manifest_path")"
prerelease="$(jq -r '.prerelease // false' "$manifest_path")"
license_expression="$(jq -r '.license.expression // "Apache-2.0"' "$manifest_path")"
license_file="$(jq -r '.license.file // empty' "$manifest_path")"

tag="$release_key-v$version"
name="${release_name:-$tag}"

export GH_TOKEN="$GITHUB_RELEASE_TOKEN"

target_branch="$(gh api "repos/$target_repository" --jq '.default_branch')"
target_sha="$(gh api "repos/$target_repository/commits/$target_branch" --jq '.sha')"

if gh api "repos/$target_repository/git/ref/tags/$tag" >/dev/null 2>&1; then
  echo "::error::Tag already exists in $target_repository: $tag." >&2
  exit 65
fi

if gh api "repos/$target_repository/releases/tags/$tag" >/dev/null 2>&1; then
  echo "::error::Release already exists in $target_repository: $tag." >&2
  exit 65
fi

provenance="$(
  cat <<EOF
Source: https://github.com/$source_repository/commit/$source_sha
Source run: https://github.com/$source_repository/actions/runs/$source_run_id
CI run: https://github.com/$source_repository/actions/runs/$ci_run_id
Request: $request_id
License: $license_expression
EOF
)"

if [ -n "$license_file" ]; then
  provenance="$(printf '%s\nLicense file: %s' "$provenance" "$license_file")"
fi

if [ -n "$release_notes" ]; then
  body="$release_notes"$'\n\n'"$provenance"
else
  body="$provenance"
fi

created_tag=false
created_release=false
release_id=""

rollback_release() {
  if [ "$created_release" = "true" ] && [ -n "$release_id" ]; then
    echo "::warning::Release publication failed; rolling back Release: $tag."
    gh api --method DELETE "repos/$target_repository/releases/$release_id" >/dev/null 2>&1 || true
  fi
  if [ "$created_tag" = "true" ]; then
    echo "::warning::Rolling back Tag: $tag."
    gh api --method DELETE "repos/$target_repository/git/refs/tags/$tag" >/dev/null 2>&1 || true
  fi
}

trap rollback_release ERR

gh api   --method POST   "repos/$target_repository/git/refs"   -f ref="refs/tags/$tag"   -f sha="$target_sha"   >/dev/null
created_tag=true

release_json="$(
  gh api     --method POST     "repos/$target_repository/releases"     -f tag_name="$tag"     -f target_commitish="$target_sha"     -f name="$name"     -f body="$body"     -F prerelease="$prerelease"     -F draft=true
)"

release_id="$(jq -r '.id' <<< "$release_json")"
release_url="$(jq -r '.html_url' <<< "$release_json")"
created_release=true

mapfile -t upload_files < <(
  find "$artifact_dir" -maxdepth 1 -type f ! -name 'release-manifest.json' -printf '%p\n' | LC_ALL=C sort
)

gh release upload "$tag" "${upload_files[@]}" --repo "$target_repository"

mapfile -t expected_release_names < <(
  {
    jq -r '.assets[].name' "$manifest_path"
    jq -r '.assets[].name + ".sha256"' "$manifest_path"
  } | LC_ALL=C sort
)

mapfile -t actual_release_names < <(
  gh api "repos/$target_repository/releases/$release_id/assets?per_page=100"     --jq '.[].name'     | LC_ALL=C sort
)

if [ "$(printf '%s\n' "${expected_release_names[@]}")" != "$(printf '%s\n' "${actual_release_names[@]}")" ]; then
  echo "::error::Published Release assets do not match the validated manifest." >&2
  exit 66
fi

verify_dir="$work_dir/verify"
mkdir -p "$verify_dir"
gh release download "$tag" --repo "$target_repository" --dir "$verify_dir"

while IFS=$'\t' read -r asset_name expected_hash; do
  downloaded="$verify_dir/$asset_name"
  checksum_file="$verify_dir/$asset_name.sha256"

  [ -f "$downloaded" ] && [ -f "$checksum_file" ] || {
    echo "::error::Downloaded Release is missing asset or checksum: $asset_name." >&2
    exit 66
  }

  actual_hash="$(sha256sum "$downloaded" | awk '{print $1}')"
  checksum_hash="$(awk '{print $1}' "$checksum_file" | tr '[:upper:]' '[:lower:]')"

  if [ "$actual_hash" != "$expected_hash" ] || [ "$checksum_hash" != "$expected_hash" ]; then
    echo "::error::Published Release checksum verification failed: $asset_name." >&2
    exit 66
  fi
done < <(jq -r '.assets[] | [.name, .sha256] | @tsv' "$manifest_path")

gh api   --method PATCH   "repos/$target_repository/releases/$release_id"   -F draft=false   >/dev/null

trap - ERR

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "tag=$tag"
    echo "release_url=$release_url"
    echo "target_repository=$target_repository"
  } >> "$GITHUB_OUTPUT"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## Release Governance"
    echo
    echo "- Source: $source_repository@$source_sha"
    echo "- Source run: $source_run_id"
    echo "- CI run: $ci_run_id"
    echo "- Target: $target_repository@$target_sha"
    echo "- Tag: $tag"
    echo "- License: $license_expression"
    if [ -n "$license_file" ]; then
      echo "- License file: $license_file"
    fi
    echo "- URL: $release_url"
  } >> "$GITHUB_STEP_SUMMARY"
fi
