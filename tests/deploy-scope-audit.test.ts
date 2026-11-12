import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  auditDeploySecretScope,
  verifyPinnedDeploySource,
} from "../scripts/audit-deploy-secret-scope.ts";
import { parseNamesOnlyInventory } from "../scripts/audit-task-secret-scope.ts";
import type { DeploySecretPlanEntry } from "../scripts/resolve-secret-scope.ts";
import { runText } from "../scripts/runtime-command.ts";

const plan: DeploySecretPlanEntry[] = [
  { name: "HEALTH_KEY", source: "HEALTH_KEY", kind: "secret", required: true },
  { name: "STORAGE_KEY", source: "STORAGE_KEY_PRIMARY", kind: "secret", required: true },
  { name: "ORG_KEY", source: "ORG_KEY", kind: "secret", required: true },
  { name: "WRONG_ENV", source: "WRONG_ENV", kind: "secret", required: true },
  { name: "MISSING_KEY", source: "MISSING_KEY", kind: "secret", required: true },
  { name: "ACCOUNT_ID", source: "ACCOUNT_ID_PRIMARY", kind: "variable", required: true },
  { name: "OPTIONAL_KEY", source: "OPTIONAL_KEY", kind: "secret", required: false },
];

test("deploy audit distinguishes the active Environment, other Environments and Variables", () => {
  const inventory = parseNamesOnlyInventory({
    schema_version: 1,
    coverage: "complete",
    repository: ["STORAGE_KEY_PRIMARY"],
    organization_accessible: ["ORG_KEY"],
    environments: {
      production: ["HEALTH_KEY"],
      staging: ["WRONG_ENV"],
    },
  });
  const report = auditDeploySecretScope(plan, inventory, "production");
  assert.deepEqual(report, {
    status: "UNVERIFIED",
    source_policy_binding_checked: true,
    inventory_claims_complete: true,
    required_secret_count: 5,
    aliased_required_count: 1,
    repository_name_matches: 1,
    organization_name_matches: 1,
    active_environment_name_matches: 1,
    other_environment_only_names: 1,
    missing_from_complete_inventory: 1,
    scope_unknown_names: null,
    actual_secret_values_checked: false,
    runtime_injection_proven: false,
    deployment_success_proven: false,
  });
  const output = JSON.stringify(report);
  assert.doesNotMatch(output, /HEALTH_KEY|STORAGE_KEY|production|staging|ACCOUNT_ID/);
});

test("partial inventories cannot prove absent deployment Secrets", () => {
  const inventory = parseNamesOnlyInventory({
    schema_version: 1,
    coverage: "partial",
    repository: [],
    organization_accessible: [],
    environments: { staging: ["WRONG_ENV"] },
  });
  const report = auditDeploySecretScope(plan, inventory, "production");
  assert.equal(report.other_environment_only_names, 1);
  assert.equal(report.missing_from_complete_inventory, null);
  assert.equal(report.scope_unknown_names, 4);
  assert.equal(report.runtime_injection_proven, false);
});

test("offline deploy audit rejects forged bindings and value-bearing inventories", () => {
  const inventory = parseNamesOnlyInventory({
    schema_version: 1,
    coverage: "complete",
    repository: [],
    organization_accessible: [],
    environments: {},
  });
  assert.throws(
    () => auditDeploySecretScope([{ ...plan[0]!, source: "../escape" }], inventory, "production"),
    /invalid approved deploy Secret binding/i
  );
  assert.throws(
    () => auditDeploySecretScope([plan[0]!, plan[0]!], inventory, "production"),
    /invalid approved deploy Secret binding/i
  );
  assert.throws(() => auditDeploySecretScope(plan, inventory, "../production"), /context/);
  assert.throws(() =>
    parseNamesOnlyInventory({
      schema_version: 1,
      coverage: "complete",
      repository: [],
      organization_accessible: [],
      environments: {},
      secret_values: { HEALTH_KEY: "forbidden" },
    })
  );
});

test("pinned source requires a full immutable SHA and clean regular declaration files", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-deploy-scope-pin-"));
  const git = (...args: string[]) =>
    runText("git", ["-C", root, ...args], { timeoutMs: 5000, maxBuffer: 4096 });
  const required = join(root, ".github", "deploy.secrets.required");
  const allowed = join(root, ".github", "deploy.secrets.allowed");
  try {
    await mkdir(join(root, ".github"), { recursive: true });
    await git("init", "-q");
    await git("config", "user.email", "scope@example.invalid");
    await git("config", "user.name", "Scope Audit");
    await writeFile(required, "HEALTH_KEY\n");
    await writeFile(allowed, "");
    await git("add", ".");
    await git("commit", "-qm", "pin deploy declarations");
    const sha = await git("rev-parse", "HEAD");
    const paths = await verifyPinnedDeploySource(root, "", sha);
    assert.equal(paths.requiredPath, required);
    await assert.rejects(verifyPinnedDeploySource(root, "", "main"), /identity/);
    await assert.rejects(verifyPinnedDeploySource(root, "", "a".repeat(40)), /identity/);
    await writeFile(required, "ANOTHER_KEY\n");
    await assert.rejects(verifyPinnedDeploySource(root, "", sha), /changed/);
    await git("checkout", "--", ".github/deploy.secrets.required");
    await rm(required);
    await symlink(allowed, required);
    await git("add", ".");
    await git("commit", "-qm", "try unsafe symlink declaration");
    await assert.rejects(
      verifyPinnedDeploySource(root, "", await git("rev-parse", "HEAD")),
      /bounded regular file/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline CLI reads live policy and pinned source without runtime Secret or Variable values", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-deploy-scope-cli-"));
  const git = (...args: string[]) =>
    runText("git", ["-C", root, ...args], { timeoutMs: 5000, maxBuffer: 4096 });
  try {
    await mkdir(join(root, ".github"), { recursive: true });
    await git("init", "-q");
    await git("config", "user.email", "scope@example.invalid");
    await git("config", "user.name", "Scope Audit");
    await writeFile(
      join(root, ".github", "deploy.secrets.required"),
      "CLOUDFLARE_API_TOKEN\nCLOUDFLARE_ACCOUNT_ID\nAIG_INFERENCE_AUTH_KEY\nAIG_PERCEPTION_AUTH_KEY\nAIG_GENERATION_AUTH_KEY\n"
    );
    await writeFile(join(root, ".github", "deploy.secrets.allowed"), "");
    await git("add", ".");
    await git("commit", "-qm", "pin synthetic deploy source");
    const sha = await git("rev-parse", "HEAD");
    const inventoryPath = join(root, "inventory.json");
    await writeFile(
      inventoryPath,
      JSON.stringify({
        schema_version: 1,
        coverage: "complete",
        repository: [
          "AIG_GENERATION_AUTH_KEY_REPOSITORY",
          "AIG_INFERENCE_AUTH_KEY_REPOSITORY",
          "AIG_PERCEPTION_AUTH_KEY_REPOSITORY",
          "CLOUDFLARE_API_TOKEN_REPOSITORY",
        ],
        organization_accessible: [],
        environments: { "ai-gateway-ops": [] },
      })
    );
    const args = [
      "scripts/audit-deploy-secret-scope.ts",
      root,
      "fongap-labs/ai-gateway",
      "production",
      "-",
      sha,
      inventoryPath,
    ];
    const run = (extra: Record<string, string> = {}) =>
      spawnSync(process.execPath, args, {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { PATH: process.env.PATH, ...extra },
      });
    const ok = run();
    assert.equal(ok.status, 0, ok.stderr);
    const report = JSON.parse(ok.stdout) as {
      status: string;
      required_secret_count: number;
      repository_name_matches: number;
      active_environment_name_matches: number;
      other_environment_only_names: number;
      actual_secret_values_checked: boolean;
      runtime_injection_proven: boolean;
    };
    assert.equal(report.status, "UNVERIFIED");
    assert.equal(report.required_secret_count, 4);
    assert.equal(report.repository_name_matches, 4);
    assert.equal(report.active_environment_name_matches, 0);
    assert.equal(report.other_environment_only_names, 0);
    // Repository-scoped Secrets cannot be replaced by same-named credentials
    // placed in a different Environment, even for the production deployment.
    await writeFile(
      inventoryPath,
      JSON.stringify({
        schema_version: 1,
        coverage: "complete",
        repository: [],
        organization_accessible: [],
        environments: {
          production: [
            "AIG_GENERATION_AUTH_KEY_REPOSITORY",
            "AIG_INFERENCE_AUTH_KEY_REPOSITORY",
            "AIG_PERCEPTION_AUTH_KEY_REPOSITORY",
            "CLOUDFLARE_API_TOKEN_REPOSITORY",
          ],
        },
      })
    );
    const wrongScope = run();
    assert.equal(wrongScope.status, 0, wrongScope.stderr);
    const wrongReport = JSON.parse(wrongScope.stdout) as {
      active_environment_name_matches: number;
      other_environment_only_names: number;
    };
    assert.equal(wrongReport.active_environment_name_matches, 0);
    assert.equal(wrongReport.other_environment_only_names, 4);
    assert.equal(report.actual_secret_values_checked, false);
    assert.equal(report.runtime_injection_proven, false);
    assert.doesNotMatch(ok.stdout, /AIG_DEPLOY_HEALTH_KEY|CLOUDFLARE|OFFLINE_NAMES_ONLY/);
    const blocked = run({ GITHUB_ACTIONS: "true" });
    assert.equal(blocked.status, 77);
    assert.doesNotMatch(blocked.stderr, /AIG_DEPLOY_HEALTH_KEY|CLOUDFLARE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
