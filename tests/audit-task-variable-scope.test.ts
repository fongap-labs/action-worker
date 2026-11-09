import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNamesOnlyInventory } from "../scripts/audit-task-secret-scope.ts";
import { auditTaskVariableScope } from "../scripts/audit-task-variable-scope.ts";
import type { ScopedTaskSecretPlan } from "../scripts/resolve-task-secret-plan.ts";

const plan: ScopedTaskSecretPlan = {
  schema_version: 1,
  repository: "fongap-labs/internal-vault",
  project: "FongapCDN",
  slots: [
    {
      slot: "AW_TASK_SECRET_SLOT_01",
      logical_name: "CLOUDFLARE_ACCOUNT_ID",
      stored_name: "CLOUDFLARE_ACCOUNT_ID_PRIMARY",
      kind: "variable",
      required: true,
    },
    {
      slot: "AW_TASK_SECRET_SLOT_02",
      logical_name: "CLOUDFLARE_API_TOKEN",
      stored_name: "CLOUDFLARE_API_TOKEN_PRIMARY",
      required: true,
    },
  ],
};

test("offline variable audit counts only required variable slots, not Secrets", () => {
  const inventory = parseNamesOnlyInventory({
    schema_version: 1,
    coverage: "complete",
    repository: ["CLOUDFLARE_ACCOUNT_ID_PRIMARY"],
    organization_accessible: [],
    environments: {},
  });
  const report = auditTaskVariableScope(plan, inventory);
  assert.equal(report.status, "UNVERIFIED");
  assert.equal(report.required_variable_count, 1);
  assert.equal(report.aliased_required_count, 1);
  assert.equal(report.repository_name_matches, 1);
  assert.equal(report.organization_name_matches, 0);
  assert.equal(report.actual_variable_values_checked, false);
  assert.equal(report.runtime_injection_proven, false);
  assert.equal(report.missing_from_complete_inventory, 0);
  const printed = JSON.stringify(report);
  assert.doesNotMatch(printed, /CLOUDFLARE|FongapCDN|internal-vault/);
});

test("environment-only variable is never mistaken for current task visibility", () => {
  const inventory = parseNamesOnlyInventory({
    schema_version: 1,
    coverage: "complete",
    repository: [],
    organization_accessible: [],
    environments: { production: ["CLOUDFLARE_ACCOUNT_ID_PRIMARY"] },
  });
  const report = auditTaskVariableScope(plan, inventory);
  assert.equal(report.environment_only_names, 1);
  assert.equal(report.repository_name_matches, 0);
  assert.equal(report.missing_from_complete_inventory, 0);
  assert.equal(report.runtime_injection_proven, false);
});

test("partial variable inventory cannot prove a missing or empty runtime value", () => {
  const inventory = parseNamesOnlyInventory({
    schema_version: 1,
    coverage: "partial",
    repository: [],
    organization_accessible: [],
    environments: {},
  });
  const report = auditTaskVariableScope(plan, inventory);
  assert.equal(report.inventory_claims_complete, false);
  assert.equal(report.scope_unknown_names, 1);
  assert.equal(report.missing_from_complete_inventory, null);
});

test("complete inventory distinguishes accessible organization Variable and missing name", () => {
  const inventory = parseNamesOnlyInventory({
    schema_version: 1,
    coverage: "complete",
    repository: [],
    organization_accessible: ["CLOUDFLARE_ACCOUNT_ID_PRIMARY"],
    environments: {},
  });
  const report = auditTaskVariableScope(plan, inventory);
  assert.equal(report.organization_name_matches, 1);
  assert.equal(report.missing_from_complete_inventory, 0);
  assert.throws(() =>
    parseNamesOnlyInventory({
      schema_version: 1,
      coverage: "complete",
      repository: [],
      organization_accessible: [],
      environments: {},
      values: { CLOUDFLARE_ACCOUNT_ID_PRIMARY: "forbidden" },
    })
  );
});

test("forged Variable bindings fail closed even in an offline report", () => {
  const inventory = parseNamesOnlyInventory({
    schema_version: 1,
    coverage: "complete",
    repository: [],
    organization_accessible: [],
    environments: {},
  });
  assert.throws(
    () => auditTaskVariableScope({ ...plan, slots: [{ ...plan.slots[0]!, stored_name: "bad name" }] }, inventory),
    /Invalid approved task Variable slot binding/
  );
});
