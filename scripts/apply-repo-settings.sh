#!/usr/bin/env bash
set -Eeuo pipefail

repository="${1:-}"
is_dry_run="${2:-false}"
policy_path="${REPOSITORY_POLICY:-policies/repository.json}"

if [[ ! "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "repository must use owner/name format" >&2
  exit 2
fi

if [[ "$is_dry_run" != "true" && "$is_dry_run" != "false" ]]; then
  echo "is_dry_run must be true or false" >&2
  exit 2
fi

command -v jq >/dev/null
command -v gh >/dev/null

if [[ ! -f "$policy_path" ]]; then
  echo "repository policy not found: $policy_path" >&2
  exit 2
fi

payload_file="$(mktemp)"
response_file="$(mktemp)"
trap 'rm -f "$payload_file" "$response_file"' EXIT

jq 'del(.schema_version)' "$policy_path" > "$payload_file"

if [[ "$is_dry_run" == "true" ]]; then
  jq . "$payload_file"
  exit 0
fi

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "GH_TOKEN is required" >&2
  exit 2
fi

gh api \
  --method PATCH \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "repos/$repository" \
  --input "$payload_file" > "$response_file"

while IFS= read -r key; do
  expected="$(jq -c --arg key "$key" '.[$key]' "$payload_file")"
  actual="$(jq -c --arg key "$key" '.[$key]' "$response_file")"

  if [[ "$expected" != "$actual" ]]; then
    echo "repository setting mismatch: $key expected=$expected actual=$actual" >&2
    exit 1
  fi
done < <(jq -r 'keys[]' "$payload_file")

echo "repository settings applied: $repository"
