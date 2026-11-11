#!/usr/bin/env bash
set -Eeuo pipefail

# Shared by naming and security checks; retain identical event-specific ranges.
if [[ "$GITHUB_EVENT_NAME" == "pull_request" ]]; then
  base="$PR_BASE_SHA"
  head="$PR_HEAD_SHA"
elif [[ "$GITHUB_EVENT_NAME" == "push" ]]; then
  base="$PUSH_BEFORE_SHA"
  head="$GITHUB_SHA"
  if [[ "$base" == "0000000000000000000000000000000000000000" ]]; then
    base="$(git rev-list --max-parents=0 "$head" | tail -1)"
  fi
else
  head="$GITHUB_SHA"
  base="$(git rev-parse "$head^" 2>/dev/null || git rev-list --max-parents=0 "$head" | tail -1)"
fi

{
  echo "base=$base"
  echo "head=$head"
} >> "$GITHUB_OUTPUT"
