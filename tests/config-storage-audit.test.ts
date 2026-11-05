import assert from "node:assert/strict";
import { test } from "node:test";
import { auditStorageMetadata } from "../scripts/config-storage-audit.ts";

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
      variables: [{ name: "PUBLIC_NAME", value: "hidden" }, { name: "AW_REPOSITORY_POLICY", value: "hidden" }],
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
  assert.equal(summary.secret_values_read, false);
  assert.equal(summary.secret_values_verified, false);
  assert.equal(summary.automatic_writes, false);
  assert.doesNotMatch(JSON.stringify(summary), /ORG_KEY|ONLY_REPO|sensitive-policy|never-log/);
  assert.ok(calls.every((path) => path.includes("per_page=100") || path === "repos/" + repository));
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
