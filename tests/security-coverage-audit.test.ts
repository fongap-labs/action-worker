import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasProtectedMainGate,
  readProtectedPolling,
  requiredMainCheck,
  summarizeCoverage,
} from "../scripts/security-coverage-audit.ts";

const policy = {
  organization: "test-org",
  excluded_repositories: ["test-org/legacy"],
  grants: { "test-org/public": ["pr"], "test-org/private": ["pr"] },
};
const repos = [
  { full_name: "test-org/public", private: false, archived: false },
  { full_name: "test-org/private", private: true, archived: false },
  { full_name: "test-org/legacy", private: true, archived: false },
  { full_name: "test-org/old", private: true, archived: true },
];

test("security coverage counts private, excluded and archived without revealing names", () => {
  const output = summarizeCoverage(
    repos,
    policy,
    new Map([
      ["test-org/public", "present"],
      ["test-org/private", "present"],
    ]),
    "test-org/control"
  );
  assert.equal(output.public_count, 1);
  assert.equal(output.private_count, 3);
  assert.equal(output.archived_count, 1);
  assert.equal(output.excluded_count, 1);
  assert.equal(output.complete, false);
  assert.equal(JSON.stringify(output).includes("test-org/private"), false);
});

test("security coverage refuses missing protected CI bridge and unknown reads", () => {
  const policyAll = {
    ...policy,
    excluded_repositories: [],
    grants: { ...policy.grants, "test-org/legacy": ["pr"] },
  };
  const result = summarizeCoverage(
    repos,
    policyAll,
    new Map([
      ["test-org/public", "absent"],
      ["test-org/private", "unknown"],
      ["test-org/legacy", "present"],
    ]),
    "test-org/control"
  );
  assert.equal(result.missing_bridge_count, 1);
  assert.equal(result.unverified_count, 1);
  assert.equal(result.complete, false);
});

test("security coverage rejects duplicate inventory identities", () => {
  assert.throws(() => summarizeCoverage([repos[0]!, repos[0]!], policy, new Map(), "test-org/control"));
});

test("controller is self-checked and protected polling is not overstated as full coverage", () => {
  const policyAll = {
    ...policy,
    excluded_repositories: [],
    grants: {
      ...policy.grants,
      "test-org/control": ["pr"],
    },
  };
  const result = summarizeCoverage(
    [
      { full_name: "test-org/control", private: false, archived: false },
      repos[0]!,
      repos[1]!,
    ],
    policyAll,
    new Map([
      ["test-org/public", "protected-polling"],
      ["test-org/private", "present"],
    ]),
    "test-org/control"
  );
  assert.equal(result.controller_count, 1);
  assert.equal(result.protected_polling_count, 1);
  assert.equal(result.missing_bridge_count, 0);
  assert.equal(result.complete, false);
  assert.equal(result.privacy_enforcement_verified, false);
});

test("required main check comes from the central ruleset policy", async () => {
  const value = JSON.parse(
    await import("node:fs/promises").then((fs) => fs.readFile("policies/rulesets.json", "utf8"))
  ) as unknown;
  const context = requiredMainCheck(value);
  assert.equal(context, "validate-merge");
});

test("a polling fallback accepts only an active strict main ruleset with no bypass", async () => {
  const rule = {
    id: 123,
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    rules: [{
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: [{ context: "validate-merge" }],
      },
    }],
  };
  assert.equal(hasProtectedMainGate(rule, "validate-merge"), true);
  assert.equal(hasProtectedMainGate({ ...rule, bypass_actors: [{}] }, "validate-merge"), false);
  assert.equal(hasProtectedMainGate({ ...rule, enforcement: "disabled" }, "validate-merge"), false);
  const reader = {
    get: async (path: string): Promise<unknown> =>
      path.includes("/rulesets/123") ? rule : [{ id: 123 }],
  };
  assert.equal(await readProtectedPolling(reader, "test-org/public", "validate-merge"), "protected-polling");
  assert.equal(
    await readProtectedPolling({ get: async () => { throw new Error("unavailable"); } }, "test-org/public", "validate-merge"),
    "unknown"
  );
});

test("security coverage reuses the existing organization config workflow", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(".github/workflows/audit-config-scope.yml", "utf8")
  );
  assert.match(source, /node scripts\/security-coverage-audit\.ts/);
});
