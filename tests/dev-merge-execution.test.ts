import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  authorizeDevMerge,
  devMergePolicyEnabled,
  executeDevMerge,
  protectedMergeRuleset,
} from "../scripts/dev-merge-execution.ts";

const policy: unknown = JSON.parse(readFileSync("policies/rulesets.json", "utf8"));
const identity = {
  repository: "fongap-labs/example",
  prNumber: 7,
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  runUrl: "https://github.com/fongap-labs/action-worker/actions/runs/51",
  controlRepository: "fongap-labs/action-worker",
};

test("closed versioned dev protection withholds all merge writes and even live reads", async () => {
  const reader = {
    async get(): Promise<unknown> {
      return assert.fail("closed policy must not read or write target");
    },
  };
  assert.equal(devMergePolicyEnabled(policy), false);
  assert.equal(await authorizeDevMerge(reader, policy, identity), undefined);
  await assert.rejects(
    executeDevMerge(
      reader,
      policy,
      identity,
      async () => assert.fail("merge must not be attempted"),
      async () => assert.fail("receipt must not be published")
    ),
    /disabled by central policy/
  );
});

test("development protection requires strict independent status and no bypass", () => {
  const main = (policy as { rulesets: Array<Record<string, unknown>> }).rulesets[0]!;
  const dev = {
    ...main,
    name: "Protect Dev Branch",
    conditions: { ref_name: { exclude: [], include: ["refs/heads/dev"] } },
    rules: (main.rules as Array<Record<string, unknown>>).map((rule) =>
      rule.type === "required_status_checks"
        ? {
            ...rule,
            parameters: {
              strict_required_status_checks_policy: true,
              required_status_checks: [{ context: "validate-merge-dev", integration_id: 5609149 }],
            },
          }
        : rule
    ),
  };
  assert.equal(protectedMergeRuleset(dev, "dev"), true);
  assert.equal(protectedMergeRuleset(dev, "main"), false);
  assert.equal(protectedMergeRuleset({ ...dev, bypass_actors: [{ actor_id: 1 }] }, "dev"), false);
  assert.equal(
    protectedMergeRuleset({ ...dev, rules: [...dev.rules, { type: "update" }] }, "dev"),
    false
  );
});
