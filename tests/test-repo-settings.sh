#!/usr/bin/env bash
set -Eeuo pipefail

jq -e '
  .schema_version == 1 and
  .has_issues == true and
  .has_projects == false and
  .has_wiki == false and
  .has_discussions == false and
  .allow_merge_commit == false and
  .allow_squash_merge == true and
  .allow_rebase_merge == false and
  .allow_auto_merge == false and
  .delete_branch_on_merge == true and
  .allow_update_branch == true and
  .web_commit_signoff_required == false and
  .squash_merge_commit_title == "PR_TITLE" and
  .squash_merge_commit_message == "PR_BODY"
' policies/repository.json >/dev/null

grep -Fq 'secrets.GH_ADMIN_TOKEN' .github/workflows/apply-repo-settings.yml
grep -Fq "jq 'del(.schema_version)'" scripts/apply-repo-settings.sh
grep -Fq 'repos/$repository' scripts/apply-repo-settings.sh

echo "repository settings contract passed"
