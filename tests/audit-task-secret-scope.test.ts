import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auditTaskSecretScope,
  parseNamesOnlyInventory,
} from "../scripts/audit-task-secret-scope.ts";
import type { ScopedTaskSecretPlan } from "../scripts/resolve-task-secret-plan.ts";

const plan: ScopedTaskSecretPlan = {
  schema_version: 1,
  repository: "example/source",
  project: "Example",
  slots: [
    {
      slot: "AW_TASK_SECRET_SLOT_01",
      logical_name: "CF_ACCOUNT",
      stored_name: "CF_ACCOUNT_PRIMARY",
      required: true,
    },
    {
      slot: "AW_TASK_SECRET_SLOT_02",
      logical_name: "CF_TOKEN",
      stored_name: "CF_TOKEN_PRIMARY",
      required: true,
    },
    {
      slot: "AW_TASK_SECRET_SLOT_03",
      logical_name: "EXTRA_KEY",
      stored_name: "EXTRA_KEY",
      required: false,
    },
  ],
};

test("offline scope audit reports required-name location but never names or values", () => {
  const inventory = parseNamesOnlyInventory({
    schema_version: 1,
    coverage: "complete",
    repository: ["CF_TOKEN_PRIMARY"],
    organization_accessible: [],
    environments: { production: ["CF_ACCOUNT_PRIMARY"] },
  });
  const report = auditTaskSecretScope(plan, inventory);
  assert.equal(report.status, "UNVERIFIED");
  assert.equal(report.required_count, 2);
  assert.equal(report.aliased_required_count, 2);
  assert.equal(report.repository_name_matches, 1);
  assert.equal(report.environment_only_names, 1);
  assert.equal(report.missing_from_complete_inventory, 0);
  assert.equal(report.actual_secret_values_checked, false);
  assert.equal(report.runtime_injection_proven, false);
  const printed = JSON.stringify(report);
  assert.doesNotMatch(printed, /CF_ACCOUNT|CF_TOKEN|production|EXTRA_KEY/);
});

test("incomplete inventory never claims a missing Secret", () => {
  const inventory = parseNamesOnlyInventory({
    schema_version: 1,
    coverage: "partial",
    repository: [],
    organization_accessible: [],
    environments: {},
  });
  const report = auditTaskSecretScope(plan, inventory);
  assert.equal(report.missing_from_complete_inventory, null);
  assert.equal(report.scope_unknown_names, 2);
  assert.equal(report.inventory_claims_complete, false);
});

test("complete inventory distinguishes organization-accessible from missing", () => {
  const inventory = parseNamesOnlyInventory({
    schema_version: 1,
    coverage: "complete",
    repository: [],
    organization_accessible: ["CF_ACCOUNT_PRIMARY"],
    environments: {},
  });
  const report = auditTaskSecretScope(plan, inventory);
  assert.equal(report.organization_name_matches, 1);
  assert.equal(report.missing_from_complete_inventory, 1);
  assert.equal(report.runtime_injection_proven, false);
});

test("inventory rejects values, extra fields and malformed names", () => {
  const baseline = {
    schema_version: 1,
    coverage: "complete",
    repository: [],
    organization_accessible: [],
    environments: {},
  };
  assert.throws(() =>
    parseNamesOnlyInventory({ ...baseline, secret_values: { CF_ACCOUNT_PRIMARY: "sensitive" } })
  );
  assert.throws(() =>
    parseNamesOnlyInventory({ ...baseline, repository: ["CF_ACCOUNT_PRIMARY", "CF_ACCOUNT_PRIMARY"] })
  );
  assert.throws(() =>
    parseNamesOnlyInventory({ ...baseline, environments: { "bad/name": [] } })
  );
  assert.throws(() =>
    parseNamesOnlyInventory({ ...baseline, repository: ["bad=value"] })
  );
});
