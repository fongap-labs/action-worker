import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeCoverage } from "../scripts/security-coverage-audit.ts";

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
    ])
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
    ])
  );
  assert.equal(result.missing_bridge_count, 1);
  assert.equal(result.unverified_count, 1);
  assert.equal(result.complete, false);
});

test("security coverage rejects duplicate inventory identities", () => {
  assert.throws(() => summarizeCoverage([repos[0]!, repos[0]!], policy, new Map()));
});
