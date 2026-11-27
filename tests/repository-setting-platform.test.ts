import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  applyRulesets,
  isUnsupportedPrivateRuleset,
  rulesetPayloads,
  settingMatchesPlatform,
} from "../scripts/apply-repository-settings.ts";
import { CliError } from "../scripts/runtime-command.ts";

test("private GitHub Free repository may not support the native auto-merge toggle", () => {
  assert.equal(settingMatchesPlatform("allow_auto_merge", true, false, true), true);
  assert.equal(settingMatchesPlatform("allow_auto_merge", true, true, true), true);
});

test("public or unrelated mismatches remain hard errors", () => {
  assert.equal(settingMatchesPlatform("allow_auto_merge", true, false, false), false);
  assert.equal(settingMatchesPlatform("allow_auto_merge", false, true, true), false);
  assert.equal(settingMatchesPlatform("allow_squash_merge", true, false, true), false);
  assert.equal(settingMatchesPlatform("delete_branch_on_merge", true, false, true), false);
  assert.equal(
    settingMatchesPlatform("required_status_checks", "validate-merge", "none", true),
    false
  );
});

test("private ruleset exclusion requires a real plan restriction, never visibility alone", () => {
  const restriction = new CliError(
    "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)"
  );
  assert.equal(isUnsupportedPrivateRuleset(restriction, true), true);
  assert.equal(isUnsupportedPrivateRuleset(restriction, false), false);
  for (const error of [
    new CliError("gh: Resource not accessible by integration (HTTP 403)"),
    new CliError("gh: API rate limit exceeded (HTTP 403)"),
    new CliError("gh: Not Found (HTTP 404)"),
    new CliError(
      "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 500)"
    ),
  ]) {
    assert.equal(isUnsupportedPrivateRuleset(error, true), false);
  }
});

test("ruleset writes are verified by an independent read before reporting success", async () => {
  const repository = "fongap-labs/example";
  const desired = {
    name: "Protect Dev Branch",
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["refs/heads/dev"], exclude: [] } },
    rules: [{ type: "creation" }],
  };
  for (const isExisting of [true, false]) {
    for (const isDrifted of [true, false]) {
      const methods: string[] = [];
      let hasWritten = false;
      const request = async (method: string, endpoint: string): Promise<unknown> => {
        methods.push(method);
        if (endpoint.includes("per_page=100")) {
          return isExisting ? [{ id: 42, name: desired.name }] : [];
        }
        if (method === "GET") {
          return hasWritten && !isDrifted ? desired : { ...desired, enforcement: "disabled" };
        }
        hasWritten = true;
        return { id: 42 };
      };
      const pending = applyRulesets(repository, "test-token", false, [desired], request);
      if (isDrifted) {
        await assert.rejects(pending, /read-back does not match/);
      } else {
        assert.equal((await pending).protectionApplied, true);
      }
      assert.deepEqual(methods, isExisting ? ["GET", "GET", "PUT", "GET"] : ["GET", "POST", "GET"]);
    }
  }
});

test("ambiguous managed rulesets never permit reconciliation", async () => {
  await assert.rejects(
    applyRulesets("fongap-labs/example", "test-token", false, [], async () => [
      { id: 42, name: "Protect Main Branch" },
      { id: 43, name: "Protect Main Branch" },
    ]),
    /duplicate names/
  );
});

test("GitHub rule order alone does not trigger repeated writes or read-back failures", async () => {
  const policy: unknown = JSON.parse(readFileSync("policies/rulesets.json", "utf8"));
  const desired = rulesetPayloads(policy).find((rule) => rule.name === "Protect Main Branch")!;
  const reordered = { ...desired, rules: desired.rules.toReversed() };
  for (const isExisting of [true, false]) {
    const methods: string[] = [];
    const result = await applyRulesets(
      "fongap-labs/example",
      "test-token",
      false,
      [desired],
      async (method, endpoint) => {
        methods.push(method);
        if (endpoint.includes("per_page=100")) {
          return isExisting ? [{ id: 42, name: desired.name }] : [];
        }
        if (method === "POST") return { id: 42 };
        assert.equal(method, "GET");
        return reordered;
      }
    );
    assert.equal(result.protectionApplied, true);
    assert.deepEqual(methods, isExisting ? ["GET", "GET"] : ["GET", "POST", "GET"]);
  }
  const drifted = {
    ...reordered,
    rules: reordered.rules.map((rule) =>
      typeof rule === "object" &&
      rule !== null &&
      "type" in rule &&
      rule.type === "required_status_checks"
        ? { ...rule, parameters: { required_status_checks: [] } }
        : rule
    ),
  };
  for (const actual of [
    drifted,
    { ...reordered, rules: [...reordered.rules, reordered.rules[0]] },
    {
      ...reordered,
      bypass_actors: [{ actor_id: 5609149, actor_type: "Integration", bypass_mode: "always" }],
    },
    { ...reordered, conditions: { ref_name: { include: ["refs/heads/dev"], exclude: [] } } },
    { ...reordered, enforcement: "disabled" },
  ]) {
    await assert.rejects(
      applyRulesets(
        "fongap-labs/example",
        "test-token",
        false,
        [desired],
        async (method, endpoint) => {
          if (endpoint.includes("per_page=100")) return [{ id: 42, name: desired.name }];
          return method === "GET" ? actual : {};
        }
      ),
      /read-back does not match/
    );
  }
});
