import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolveBranchSourceSha } from "../scripts/authorize-branch-operation.ts";
import {
  bootstrapApprovalComment,
  DevBootstrapPendingError,
  isClosedDevProtection,
  verifyAuthorizedDevBootstrap,
  verifyBootstrapSource,
} from "../scripts/dev-bootstrap-authorization.ts";
import { attestFixtureStatuses } from "./attested-status-fixtures.ts";

const repository = "fongap-labs/example";
const control = "fongap-labs/action-worker";
const sha = "a".repeat(40);
const now = Date.parse("2026-11-25T12:00:00Z");
const prefix = `repos/${repository}`;
const policy = JSON.parse(readFileSync("policies/rulesets.json", "utf8")) as {
  rulesets: Array<Record<string, unknown>>;
};
const closed = policy.rulesets.find((rule) => rule.name === "Protect Dev Branch");

test("development initialization needs exact locked rules and explicit immutable approval", () => {
  assert.equal(isClosedDevProtection(closed), true);
  assert.equal(isClosedDevProtection({ ...closed, bypass_actors: [{ actor_id: 1 }] }), false);
  assert.equal(isClosedDevProtection({ ...closed, rules: [{ type: "creation" }] }), false);
  assert.equal(
    bootstrapApprovalComment(repository, sha, 42, 1),
    `approve-dev-init 42/1 ${repository} ${sha}`
  );
  assert.throws(() => bootstrapApprovalComment(repository, "main", 42, 1));
});

test("unsigned, expired and changed bootstrap evidence cannot establish dev trust", async () => {
  const receipt = {
    context: "Dev Bootstrap Authorization",
    state: "success",
    description: `init-v1=${sha}`,
    target_url: `https://github.com/${control}/actions/runs/42`,
    created_at: "2026-11-25T11:00:00Z",
  };
  const responses = new Map<string, unknown>([
    [
      `repos/${control}/actions/runs/42`,
      {
        id: 42,
        repository: { full_name: control },
        head_branch: "main",
        path: ".github/workflows/authorize-branch-transfer.yml",
        status: "completed",
        conclusion: "success",
        run_started_at: "2026-11-25T10:59:00Z",
        updated_at: "2026-11-25T11:01:00Z",
      },
    ],
    [prefix, { full_name: repository, private: false, default_branch: "main" }],
    [`${prefix}/rulesets?includes_parents=false&per_page=100`, [{ ...closed, id: 12 }]],
    [`${prefix}/rulesets/12?includes_parents=false`, closed],
    [`${prefix}/branches/main`, { commit: { sha: "b".repeat(40) } }],
    [`${prefix}/branches/dev`, { commit: { sha } }],
  ]);
  const reader = {
    async get(path: string): Promise<unknown> {
      assert.ok(responses.has(path), path);
      return responses.get(path);
    },
  };
  const signed = attestFixtureStatuses({ statuses: [receipt] }, repository, sha);
  assert.equal(
    await verifyAuthorizedDevBootstrap(
      reader,
      repository,
      sha,
      { statuses: [receipt] },
      control,
      now
    ),
    undefined
  );
  await assert.rejects(
    verifyAuthorizedDevBootstrap(reader, repository, sha, signed, control, now + 86_400_000),
    /expired/
  );
  await assert.rejects(
    verifyAuthorizedDevBootstrap(reader, repository, sha, signed, control, now),
    /branch identity changed/
  );
});

test("the signed receipt of a running manual initialization defers the dev audit", async () => {
  const receipt = {
    context: "Dev Bootstrap Authorization",
    state: "success",
    description: `init-v1=${sha}`,
    target_url: `https://github.com/${control}/actions/runs/42`,
    created_at: "2026-11-25T11:00:00Z",
  };
  const signed = attestFixtureStatuses({ statuses: [receipt] }, repository, sha);
  const reader = {
    async get(path: string): Promise<unknown> {
      assert.equal(path, `repos/${control}/actions/runs/42`);
      return {
        id: 42,
        repository: { full_name: control },
        head_branch: "main",
        path: ".github/workflows/authorize-branch-transfer.yml",
        event: "workflow_dispatch",
        run_attempt: 1,
        status: "in_progress",
      };
    },
  };
  await assert.rejects(
    verifyAuthorizedDevBootstrap(reader, repository, sha, signed, control, now),
    DevBootstrapPendingError
  );
});

test("existing dev adoption locks the same main SHA and never accepts a PR identity", async () => {
  const reader = {
    async get(path: string): Promise<unknown> {
      assert.equal(path, `${prefix}/branches/main`);
      return { commit: { sha } };
    },
  };
  assert.equal(await resolveBranchSourceSha(reader, "adopt-dev", repository, 0, ""), sha);
  assert.equal(await resolveBranchSourceSha(reader, "adopt-dev", repository, 0, sha), sha);
  await assert.rejects(resolveBranchSourceSha(reader, "adopt-dev", repository, 7, ""));
});

test("existing dev adoption cannot move a divergent baseline or use a bypassed rule", async () => {
  const responses = new Map<string, unknown>([
    [prefix, { full_name: repository, private: false, default_branch: "main" }],
    [`${prefix}/rulesets?includes_parents=false&per_page=100`, [{ ...closed, id: 12 }]],
    [`${prefix}/rulesets/12?includes_parents=false`, closed],
    [`${prefix}/branches/main`, { commit: { sha } }],
    [`${prefix}/branches/dev`, { commit: { sha: "b".repeat(40) } }],
  ]);
  const reader = {
    async get(path: string): Promise<unknown> {
      assert.ok(responses.has(path), path);
      return responses.get(path);
    },
  };
  await assert.rejects(
    verifyBootstrapSource(reader, repository, sha, control, true),
    /branch identity changed/
  );
  responses.set(`${prefix}/branches/dev`, { commit: { sha } });
  responses.set(`${prefix}/rulesets/12?includes_parents=false`, {
    ...closed,
    bypass_actors: [{ actor_id: 1 }],
  });
  await assert.rejects(
    verifyBootstrapSource(reader, repository, sha, control, true),
    /closed live protection/
  );
});

test("adoption reuses the manual admin workflow but cannot mint a branch-write token", () => {
  const workflow = readFileSync(".github/workflows/authorize-branch-transfer.yml", "utf8");
  const script = readFileSync("scripts/authorize-branch-operation.ts", "utf8");
  assert.match(workflow, /options: \[initialize-dev, adopt-dev, transfer\]/);
  assert.match(workflow, /name: admin-ops/);
  assert.match(
    workflow,
    /if: inputs\.confirm && inputs\.operation == 'initialize-dev'\n\s+id: ref_app/
  );
  assert.match(script, /if \(!adopt\) \{\n\s+await initializeProtectedDev/);
  assert.match(
    script,
    /verifyBootstrapSource\(reader, repository, sha, controlRepository, adopt\)/
  );
});
