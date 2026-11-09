import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auditStorageMetadata,
  managedAuditTargets,
  storageAuditFailureScope,
} from "../scripts/config-storage-audit.ts";

const repository = "fongap-labs/private-source";

function fixture(overrides: Record<string, unknown> = {}) {
  const records: Record<string, unknown> = {
    "orgs/fongap-labs/actions/secrets": {
      total_count: 1,
      secrets: [{ name: "ORG_KEY", visibility: "selected" }],
    },
    "orgs/fongap-labs/actions/secrets/ORG_KEY/repositories": {
      total_count: 1,
      repositories: [{ id: 101 }],
    },
    "orgs/fongap-labs/actions/variables": {
      total_count: 1,
      variables: [{ name: "AW_REPOSITORY_POLICY", visibility: "all", value: "sensitive-policy" }],
    },
    ["repos/" + repository]: { id: 101, private: true },
    ["repos/" + repository + "/actions/secrets"]: {
      total_count: 2,
      secrets: [{ name: "ORG_KEY" }, { name: "ONLY_REPO" }],
    },
    ["repos/" + repository + "/actions/variables"]: {
      total_count: 1,
      variables: [{ name: "PUBLIC_NAME", value: "never-log-variable-values" }],
    },
    ["repos/" + repository + "/environments"]: {
      total_count: 1,
      environments: [{ name: "production" }],
    },
    ["repos/" + repository + "/environments/production/secrets"]: {
      total_count: 1,
      secrets: [{ name: "ONLY_REPO" }],
    },
    ["repos/" + repository + "/environments/production/variables"]: {
      total_count: 2,
      variables: [
        { name: "PUBLIC_NAME", value: "hidden" },
        { name: "AW_REPOSITORY_POLICY", value: "hidden" },
      ],
    },
    ...overrides,
  };
  const calls: string[] = [];
  const reader = {
    async get(path: string): Promise<unknown> {
      calls.push(path);
      const bare = path.split("?")[0] ?? "";
      if (!Object.hasOwn(records, bare)) throw new Error("No mocked read endpoint");
      return records[bare];
    },
  };
  return { reader, calls };
}

test("metadata inventory detects inherited, repository and environment shadowing", async () => {
  const { reader, calls } = fixture();
  const summary = await auditStorageMetadata(reader, [repository]);
  assert.equal(summary.repositories_verified, 1);
  assert.equal(summary.coverage, "complete");
  assert.equal(summary.organization_scope_verified, true);
  assert.equal(summary.organization_secrets, 1);
  assert.equal(summary.organization_variables, 1);
  assert.equal(summary.repository_secrets, 2);
  assert.equal(summary.repository_variables, 1);
  assert.equal(summary.environment_secrets, 1);
  assert.equal(summary.environment_variables, 2);
  assert.equal(summary.inherited_secret_bindings, 1);
  assert.equal(summary.inherited_variable_bindings, 1);
  assert.equal(summary.repository_shadowed_secret_bindings, 1);
  assert.equal(summary.environment_shadowed_secret_bindings, 1);
  assert.equal(summary.environment_shadowed_variable_bindings, 2);
  assert.equal(summary.protected_variable_bindings, 2);
  assert.equal(summary.authorization_variable_bindings, 2);
  assert.equal(summary.root_trust_variable_bindings, 0);
  assert.equal(summary.secret_values_read, false);
  assert.equal(summary.secret_values_verified, false);
  assert.equal(summary.automatic_writes, false);
  assert.doesNotMatch(JSON.stringify(summary), /ORG_KEY|ONLY_REPO|sensitive-policy|never-log/);
  assert.ok(calls.every((path) => path.includes("per_page=100") || path === "repos/" + repository));
});

test("audit protects root keys, authorization switches and security-sensitive variables", async () => {
  const { reader } = fixture({
    ["repos/" + repository + "/actions/variables"]: {
      total_count: 3,
      variables: [
        { name: "AW_CI_EVIDENCE_PUBLIC_KEY", value: "do-not-emit" },
        { name: "AW_TASK_ISOLATION_PILOT_ENABLED", value: "true" },
        { name: "SERVICE_ACCESS_TOKEN", value: "do-not-emit" },
      ],
    },
  });
  const summary = await auditStorageMetadata(reader, [repository]);
  assert.equal(summary.authorization_variable_bindings, 3);
  assert.equal(summary.root_trust_variable_bindings, 1);
  assert.equal(summary.protected_variable_bindings, 5);
  assert.doesNotMatch(JSON.stringify(summary), /do-not-emit|SERVICE_ACCESS_TOKEN/);
});

test("metadata inventory rejects missing organization access rather than guessing inheritance", async () => {
  const { reader } = fixture();
  await assert.rejects(
    auditStorageMetadata(
      {
        async get(path: string): Promise<unknown> {
          if (path.startsWith("orgs/")) throw new Error("403");
          return await reader.get(path);
        },
      },
      [repository]
    ),
    /403/
  );
});

test("metadata inventory refuses inconsistent or duplicated repository metadata", async () => {
  const path = "repos/" + repository + "/actions/secrets";
  const { reader } = fixture({
    [path]: { total_count: 2, secrets: [{ name: "ORG_KEY" }, { name: "ORG_KEY" }] },
  });
  await assert.rejects(auditStorageMetadata(reader, [repository]), /duplicate/);
});

test("metadata inventory rejects invalid targets", async () => {
  const { reader } = fixture();
  await assert.rejects(auditStorageMetadata(reader, [repository, repository]), /targets/);
  await assert.rejects(auditStorageMetadata(reader, ["other-org/private"]), /targets/);
});

test("configuration audit automatically includes governed repositories without losing discovery coverage", () => {
  assert.deepEqual(
    managedAuditTargets(
      ["fongap-labs/ai-gateway", "fongap-labs/action-worker"],
      ["fongap-labs/action-worker", "fongap-labs/newly-enrolled"]
    ),
    ["fongap-labs/action-worker", "fongap-labs/ai-gateway", "fongap-labs/newly-enrolled"]
  );
  assert.deepEqual(managedAuditTargets([], ["fongap-labs/action-worker"]), [
    "fongap-labs/action-worker",
  ]);
  const invalid: Array<[string[], string[]]> = [
    [[], []],
    [["fongap-labs/action-worker", "fongap-labs/action-worker"], []],
    [[], ["another-org/other"]],
    [["fongap-labs/a"], ["fongap-labs/a", "fongap-labs/a"]],
  ];
  for (const [discovery, governed] of invalid) {
    assert.throws(() => managedAuditTargets(discovery, governed), /targets/);
  }
});

test("metadata error diagnostics expose only the access layer, never individual names", () => {
  assert.equal(storageAuditFailureScope("orgs/fongap-labs/actions/secrets"), "organization");
  assert.equal(
    storageAuditFailureScope("orgs/fongap-labs/actions/variables/AW_PRIVATE_KEY/repositories"),
    "organization"
  );
  assert.equal(
    storageAuditFailureScope("repos/fongap-labs/action-worker/environments/admin-ops/secrets"),
    "environment"
  );
  assert.equal(
    storageAuditFailureScope("repos/fongap-labs/action-worker/actions/variables"),
    "repository"
  );
  assert.equal(storageAuditFailureScope("repos/fongap-labs/internal-vault"), "repository");
});

test("organization permission gap falls back to explicit control-repository-only coverage", async () => {
  const { reader } = fixture();
  const calls: string[] = [];
  const controlReader = {
    async get(path: string): Promise<unknown> {
      calls.push(path);
      if (path.startsWith("orgs/")) throw new Error("Unexpected organization metadata read");
      return await reader.get(path.replace("fongap-labs/action-worker", repository));
    },
  };
  const summary = await auditStorageMetadata(controlReader, ["fongap-labs/action-worker"], {
    skipOrganization: true,
  });
  assert.equal(summary.coverage, "control-only");
  assert.equal(summary.organization_scope_verified, false);
  assert.equal(summary.repositories_verified, 1);
  assert.equal(summary.environment_count, 1);
  assert.equal(summary.repository_variables, 1);
  assert.equal(summary.environment_variables, 2);
  assert.equal(summary.organization_secrets, null);
  assert.equal(summary.organization_variables, null);
  assert.equal(summary.inherited_secret_bindings, null);
  assert.equal(summary.inherited_variable_bindings, null);
  assert.equal(summary.environment_shadowed_variable_bindings, null);
  assert.equal(summary.protected_variable_bindings, null);
  assert.equal(summary.secret_values_read, false);
  assert.equal(summary.automatic_writes, false);
  assert.ok(calls.every((path) => !path.startsWith("orgs/")));
  assert.doesNotMatch(JSON.stringify(summary), /ORG_KEY|ONLY_REPO|sensitive-policy|never-log/);
  await assert.rejects(
    auditStorageMetadata(controlReader, [repository], { skipOrganization: true }),
    /targets/
  );
});

test("organization and Environment permission gaps preserve only verified control repository metadata", async () => {
  const { reader } = fixture();
  const calls: string[] = [];
  const controlReader = {
    async get(path: string): Promise<unknown> {
      calls.push(path);
      assert.equal(path.startsWith("orgs/"), false, "organization metadata must not be requested");
      assert.equal(
        path.includes("/environments"),
        false,
        "Environment metadata must not be requested"
      );
      return await reader.get(path.replace("fongap-labs/action-worker", repository));
    },
  };
  const summary = await auditStorageMetadata(controlReader, ["fongap-labs/action-worker"], {
    skipOrganization: true,
    skipEnvironments: true,
  });
  assert.equal(summary.coverage, "control-repository-only");
  assert.equal(summary.organization_scope_verified, false);
  assert.equal(summary.environment_scope_verified, false);
  assert.equal(summary.repositories_verified, 1);
  assert.equal(summary.repository_secrets, 2);
  assert.equal(summary.repository_variables, 1);
  assert.equal(summary.environment_count, null);
  assert.equal(summary.environment_secrets, null);
  assert.equal(summary.environment_variables, null);
  assert.equal(summary.organization_secrets, null);
  assert.equal(summary.organization_variables, null);
  assert.equal(summary.environment_shadowed_variable_bindings, null);
  assert.equal(summary.protected_variable_bindings, null);
  assert.equal(summary.secret_values_read, false);
  assert.equal(summary.automatic_writes, false);
  assert.deepEqual(calls.length, 3);
  assert.doesNotMatch(JSON.stringify(summary), /ORG_KEY|ONLY_REPO|sensitive-policy|never-log/);
  await assert.rejects(
    auditStorageMetadata(controlReader, [repository], {
      skipOrganization: true,
      skipEnvironments: true,
    }),
    /targets/
  );
  await assert.rejects(
    auditStorageMetadata(controlReader, ["fongap-labs/action-worker"], {
      skipEnvironments: true,
    }),
    /targets/
  );
});
