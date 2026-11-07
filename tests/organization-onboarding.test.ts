import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { reconcileRepositoryPolicy } from "../scripts/reconcile-organization-repositories.ts";

const policy = {
  schema_version: 1,
  organization: "fongap-labs",
  auto_enroll_created_after: "2026-11-07T00:00:00Z",
  excluded_repositories: ["fongap-labs/delta-legacy"],
  grants: {
    "fongap-labs/action-worker": ["pr", "task"],
    "fongap-labs/delta": ["pr", "task", "release-source", "release-target"],
  },
};

const repo = (name: string, created_at = "2026-11-08T00:00:00Z", overrides = {}) => ({
  full_name: `fongap-labs/${name}`,
  owner: { login: "fongap-labs" },
  default_branch: "main",
  archived: false,
  created_at,
  ...overrides,
});

test("preserves existing elevated grants and auto-enrolls new repositories with PR only", () => {
  const resolved = reconcileRepositoryPolicy(policy, [
    repo("action-worker", "2025-01-01T00:00:00Z"),
    repo("delta", "2026-11-06T14:49:30Z"),
    repo("new-service"),
    repo("delta-legacy", "2025-01-01T00:00:00Z"),
    repo("old-unmanaged", "2025-01-01T00:00:00Z"),
  ]);
  assert.deepEqual(resolved, {
    "fongap-labs/action-worker": ["pr", "task"],
    "fongap-labs/delta": ["pr", "task", "release-source", "release-target"],
    "fongap-labs/new-service": ["pr"],
  });
});

test("uninstalled, archived, disabled, non-main, and legacy repositories do not enter active policy", () => {
  const active = reconcileRepositoryPolicy(policy, [
    repo("delta-legacy"),
    repo("archived", undefined, { archived: true }),
    repo("disabled", undefined, { disabled: true }),
    repo("master-branch", undefined, { default_branch: "master" }),
    repo("action-worker", "2025-01-01T00:00:00Z", { archived: true }),
  ]);
  assert.deepEqual(active, {});
});

test("renaming cannot transfer release or deploy authority to a new repository name", () => {
  const afterRename = reconcileRepositoryPolicy(policy, [repo("delta-renamed")]);
  assert.deepEqual(afterRename, { "fongap-labs/delta-renamed": ["pr"] });
});

test("rejects malformed inventories, duplicate names, excluded grants, and cross-organization access", () => {
  assert.throws(() =>
    reconcileRepositoryPolicy(policy, [repo("new-service"), repo("new-service")])
  );
  assert.throws(() =>
    reconcileRepositoryPolicy(policy, [{ ...repo("rogue"), full_name: "other/rogue" }])
  );
  assert.throws(() =>
    reconcileRepositoryPolicy({ ...policy, grants: { ...policy.grants, "other/repo": ["pr"] } }, [])
  );
  assert.throws(() =>
    reconcileRepositoryPolicy(
      {
        ...policy,
        grants: { ...policy.grants, "fongap-labs/delta-legacy": ["pr"] },
      },
      []
    )
  );
});

test("onboarding workflow remains admin-only; repo settings are re-applied after policy changes", async () => {
  const onboarding = await readFile(
    ".github/workflows/reconcile-organization-repositories.yml",
    "utf8"
  );
  const settings = await readFile(".github/workflows/apply-repository-settings.yml", "utf8");
  assert.match(onboarding, /environment: admin-ops/);
  assert.match(onboarding, /AW_ADMIN_TOKEN: \$\{\{ secrets\.AW_ADMIN_TOKEN \}\}/);
  assert.match(
    onboarding,
    /AW_INVENTORY_APP_TOKEN: \$\{\{ steps\.inventory_app\.outputs\.token \}\}/
  );
  assert.doesNotMatch(onboarding, /permission-contents: write/);
  assert.match(settings, /types: \[managed-repositories-changed\]/);
});
