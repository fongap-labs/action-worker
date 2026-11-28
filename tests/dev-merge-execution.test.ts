import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { managedRepositoryRulesets } from "../scripts/apply-repository-settings.ts";
import { isClosedDevProtection } from "../scripts/dev-bootstrap-authorization.ts";
import {
  authorizeDevMerge,
  devMergePolicyEnabled,
  executeDevMerge,
  protectedMergeRuleset,
  requireLiveProtection,
} from "../scripts/dev-merge-execution.ts";
import { GithubHttpError } from "../scripts/github-api.ts";

const policy: Record<string, unknown> = JSON.parse(readFileSync("policies/rulesets.json", "utf8"));
const closedPolicy = { ...policy, dev_merge_mode: "closed" };
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
  assert.equal(
    devMergePolicyEnabled(closedPolicy, identity.repository, identity.controlRepository),
    false
  );
  assert.equal(await authorizeDevMerge(reader, closedPolicy, identity), undefined);
  await assert.rejects(
    executeDevMerge(
      reader,
      closedPolicy,
      identity,
      async () => assert.fail("merge must not be attempted"),
      async () => assert.fail("receipt must not be published")
    ),
    /disabled by central policy/
  );
});

test("only a confirmed private platform plan restriction permits compensating merge admission", async () => {
  const reader = (error: GithubHttpError) => ({
    async get(): Promise<unknown> {
      throw error;
    },
  });
  const restriction = reader(new GithubHttpError(403, undefined, { kind: "plan-restriction" }));
  await requireLiveProtection(restriction, identity.repository, identity.controlRepository, true);
  await assert.rejects(
    requireLiveProtection(restriction, identity.repository, identity.controlRepository)
  );
  for (const error of [
    new GithubHttpError(403, undefined, { kind: "permission" }),
    new GithubHttpError(429),
    new GithubHttpError(404),
  ]) {
    await assert.rejects(
      requireLiveProtection(reader(error), identity.repository, identity.controlRepository, true)
    );
  }
});

test("development protection requires strict independent status and no bypass", () => {
  const main = (policy as { rulesets: Array<Record<string, unknown>> }).rulesets[0]!;
  const dev = {
    ...main,
    name: "Protect Dev Branch",
    conditions: { ref_name: { exclude: [], include: ["refs/heads/dev"] } },
    rules: [
      { type: "creation" },
      ...(main.rules as Array<Record<string, unknown>>).map((rule) =>
        rule.type === "required_status_checks"
          ? {
              ...rule,
              parameters: {
                strict_required_status_checks_policy: true,
                required_status_checks: [
                  { context: "validate-merge-dev", integration_id: 5609149 },
                ],
              },
            }
          : rule
      ),
    ],
  };
  assert.equal(protectedMergeRuleset(dev, "dev"), true);
  assert.equal(protectedMergeRuleset(dev, "main"), false);
  assert.equal(protectedMergeRuleset({ ...dev, bypass_actors: [{ actor_id: 1 }] }, "dev"), false);
  assert.equal(
    protectedMergeRuleset({ ...dev, rules: [...dev.rules, { type: "update" }] }, "dev"),
    false
  );
});

test("automatic policy derives dev rules and honors disabled repositories", () => {
  for (const repository of [identity.repository, "fongap-labs/delta", "fongap-labs/new-repo"]) {
    const selected = managedRepositoryRulesets(policy, repository, identity.controlRepository);
    assert.equal(
      protectedMergeRuleset(
        selected.find((rule) => rule.name === "Protect Dev Branch"),
        "dev"
      ),
      true
    );
    assert.equal(devMergePolicyEnabled(policy, repository, identity.controlRepository), true);
    const unready = managedRepositoryRulesets(
      policy,
      repository,
      identity.controlRepository,
      false
    );
    assert.equal(
      isClosedDevProtection(unready.find((rule) => rule.name === "Protect Dev Branch")),
      true
    );
  }
  assert.equal(devMergePolicyEnabled(policy, "outside/example", identity.controlRepository), false);
  const controller = managedRepositoryRulesets(
    policy,
    identity.controlRepository,
    identity.controlRepository
  );
  const main = controller.find((rule) => rule.name === "Protect Main Branch");
  const dev = controller.find((rule) => rule.name === "Protect Dev Branch");
  assert.equal(protectedMergeRuleset(main, "main", true), true);
  assert.equal(protectedMergeRuleset(main, "main"), false);
  assert.equal(isClosedDevProtection(dev), true);
  for (const repository of [
    "fongap-labs/action-worker",
    "fongap-labs/ai-gateway",
    "fongap-labs/external-vault",
    "fongap-labs/internal-vault",
    "fongap-labs/mcp-hub",
  ]) {
    assert.equal(devMergePolicyEnabled(policy, repository, identity.controlRepository), false);
    assert.equal(
      isClosedDevProtection(
        managedRepositoryRulesets(policy, repository, identity.controlRepository).find(
          (rule) => rule.name === "Protect Dev Branch"
        )
      ),
      true
    );
  }
  assert.throws(() =>
    managedRepositoryRulesets(
      { ...policy, dev_disabled_repositories: ["outside/example"] },
      identity.repository,
      identity.controlRepository
    )
  );
  assert.throws(() =>
    managedRepositoryRulesets(
      { ...policy, dev_merge_mode: "invalid" },
      identity.repository,
      identity.controlRepository
    )
  );
});
