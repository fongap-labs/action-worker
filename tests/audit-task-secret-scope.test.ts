import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertPinnedTaskSource,
  auditTaskSecretScope,
  parseNamesOnlyInventory,
  verifyPinnedTaskSource,
} from "../scripts/audit-task-secret-scope.ts";
import type { ScopedTaskSecretPlan } from "../scripts/resolve-task-secret-plan.ts";
import { runText } from "../scripts/runtime-command.ts";

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
    parseNamesOnlyInventory({
      ...baseline,
      repository: ["CF_ACCOUNT_PRIMARY", "CF_ACCOUNT_PRIMARY"],
    })
  );
  assert.throws(() => parseNamesOnlyInventory({ ...baseline, environments: { "bad/name": [] } }));
  assert.throws(() => parseNamesOnlyInventory({ ...baseline, repository: ["bad=value"] }));
});

test("pin guard rejects non-full SHA, changed HEAD and dirty declarations", () => {
  const sha = "a".repeat(40);
  assert.doesNotThrow(() => assertPinnedTaskSource(sha, sha.toUpperCase(), ""));
  assert.throws(() => assertPinnedTaskSource("main", sha, ""), /Pinned source/);
  assert.throws(() => assertPinnedTaskSource(sha, "b".repeat(40), ""), /Pinned source/);
  assert.throws(
    () => assertPinnedTaskSource(sha, sha, " M projects/Example/.secrets.required"),
    /Pinned source/
  );
});

test("pin guard rejects changed or untracked declarations in a local Git checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-pinned-secret-audit-"));
  const dir = join(root, "projects", "Example");
  const git = async (...args: string[]): Promise<string> =>
    runText("git", ["-C", root, ...args], { timeoutMs: 5000, maxBuffer: 4096 });
  try {
    await mkdir(dir, { recursive: true });
    await git("init", "-q");
    await git("config", "user.email", "audit@example.invalid");
    await git("config", "user.name", "Test Runner");
    await writeFile(join(dir, ".secrets.required"), "TASK_KEY\\n");
    await git("add", ".");
    await git("commit", "-qm", "pin source declaration");
    const sha = await git("rev-parse", "HEAD");
    await verifyPinnedTaskSource(root, "Example", sha);
    await assert.rejects(verifyPinnedTaskSource(root, "Example", "b".repeat(40)), /Pinned source/);
    await writeFile(join(dir, ".secrets.required"), "OTHER_KEY\\n");
    await assert.rejects(verifyPinnedTaskSource(root, "Example", sha), /Pinned source/);
    await git("checkout", "--", "projects/Example/.secrets.required");
    await writeFile(join(dir, ".secrets.allowed"), "EXTRA_KEY\\n");
    await assert.rejects(verifyPinnedTaskSource(root, "Example", sha), /Pinned source/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
