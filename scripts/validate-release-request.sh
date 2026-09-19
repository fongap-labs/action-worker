#!/usr/bin/env bash
set -Eeuo pipefail

request_path="${1:-}"
manifest_path="${2:-}"

[ -n "$request_path" ] && [ -f "$request_path" ] || {
  echo "release request file is required." >&2
  exit 64
}

command -v jq >/dev/null 2>&1 || {
  echo "jq is required." >&2
  exit 69
}

source_allowlist="${RELEASE_SOURCE_ALLOWLIST:-[]}"
target_allowlist="${RELEASE_TARGET_ALLOWLIST:-[]}"

jq -e '
  type == "array"
  and all(.[];
    type == "string"
    and test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
  )
' <<< "$source_allowlist" >/dev/null || {
  echo "RELEASE_SOURCE_ALLOWLIST must be a JSON array of repositories." >&2
  exit 65
}

jq -e '
  type == "array"
  and all(.[];
    type == "string"
    and test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
  )
' <<< "$target_allowlist" >/dev/null || {
  echo "RELEASE_TARGET_ALLOWLIST must be a JSON array of repositories." >&2
  exit 65
}

jq -e '
  type == "object"
  and (keys | sort) == ([
    "artifact_name",
    "repository",
    "request_id",
    "schema_version",
    "source_run_id",
    "source_sha"
  ] | sort)
  and .schema_version == "1"
  and (.request_id | type == "string" and length >= 1 and length <= 128 and test("^[A-Za-z0-9._:-]+$"))
  and (.repository | type == "string" and test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"))
  and (.source_sha | type == "string" and test("^[0-9a-f]{40}$"))
  and (.source_run_id | type == "number" and floor == . and . >= 1)
  and (.artifact_name | type == "string" and length >= 1 and length <= 128 and test("^[A-Za-z0-9._-]+$"))
' "$request_path" >/dev/null || {
  echo "release dispatch payload is invalid." >&2
  exit 64
}

source_repository="$(jq -r '.repository' "$request_path")"

jq -e --arg repository "$source_repository" 'index($repository) != null'   <<< "$source_allowlist" >/dev/null || {
    echo "source repository is not allowed for release dispatch: $source_repository" >&2
    exit 77
  }

if [ -z "$manifest_path" ]; then
  exit 0
fi

[ -f "$manifest_path" ] || {
  echo "release manifest not found: $manifest_path" >&2
  exit 66
}

jq -e '
  type == "object"
  and ((keys - [
    "schema_version",
    "target_repository",
    "release_key",
    "version",
    "release_name",
    "release_notes",
    "prerelease",
    "license",
    "assets"
  ]) | length == 0)
  and .schema_version == "1"
  and (.target_repository | type == "string" and test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"))
  and (.release_key | type == "string" and length >= 1 and length <= 64 and test("^[a-z0-9]+(-[a-z0-9]+)*$"))
  and (.version | type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$"))
  and ((.release_name // "") | type == "string" and length <= 160)
  and ((.release_notes // "") | type == "string" and length <= 20000)
  and ((.prerelease // false) | type == "boolean")
  and (
    (has("license") | not)
    or (
      .license
      | type == "object"
      and ((keys - ["expression", "file"]) | length == 0)
      and (.expression | type == "string" and length >= 1 and length <= 128 and test("^[A-Za-z0-9][A-Za-z0-9.+() -]*$"))
      and ((.file // "") | type == "string" and length <= 160 and (length == 0 or test("^[A-Za-z0-9][A-Za-z0-9._-]*$")))
    )
  )
  and (.assets | type == "array" and length >= 1 and length <= 50)
  and (all(.assets[];
      type == "object"
      and (keys | sort) == (["name", "sha256"] | sort)
      and (.name | type == "string" and length >= 1 and length <= 160 and test("^[A-Za-z0-9][A-Za-z0-9._-]*$"))
      and (.sha256 | type == "string" and test("^[0-9a-f]{64}$"))
    ))
  and (([.assets[].name] | length) == ([.assets[].name] | unique | length))
  and (
    ((.license // {}) | .file // "") as $license_file
    | ($license_file == "" or ([.assets[].name] | index($license_file) != null))
  )
' "$manifest_path" >/dev/null || {
  echo "release manifest is invalid." >&2
  exit 64
}

target_repository="$(jq -r '.target_repository' "$manifest_path")"

jq -e --arg repository "$target_repository" 'index($repository) != null'   <<< "$target_allowlist" >/dev/null || {
    echo "target repository is not allowed for release publication: $target_repository" >&2
    exit 77
  }
