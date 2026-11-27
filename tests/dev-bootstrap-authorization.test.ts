import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolveBranchSourceSha } from "../scripts/authorize-branch-operation.ts";
import {
  bootstrapApprovalComment,
  DevBootstrapPendingError,
  isClosedDevProtection,
  readClosedDevProtection,
  verifyAuthorizedDevBootstrap,
  verifyAutomaticDevAdoption,
  verifyBootstrapSource,
} from "../scripts/dev-bootstrap-authorization.ts";
import { GithubHttpError } from "../scripts/github-api.ts";
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
    [`${prefix}/compare/${sha}...${"b".repeat(40)}`, { status: "diverged" }],
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
  const creation = script.slice(
    script.indexOf("    if (!adopt) {"),
    script.indexOf("    if (\n      (await verifyBootstrapSource")
  );
  assert.ok(creation.startsWith("    if (!adopt) {"));
  assert.match(creation, /if \(protection === "compensating"\) \{/);
  assert.match(creation, /await initializeCompensatedDev\(/);
  assert.match(creation, /else \{\n\s+await initializeProtectedDev\(/);
  assert.equal(script.match(/await initialize(?:Compensated|Protected)Dev\(/g)?.length, 2);
  assert.match(
    script,
    /verifyBootstrapSource\(\s*reader,\s*repository,\s*sha,\s*controlRepository,\s*adopt\s*\)/
  );
});

test("automatic adoption verifies the same protected trusted main, never writes a ref", async () => {
  const mainGuard = {
    context: "Main Write Guard",
    state: "success",
    description: "verified main",
    target_url: `https://github.com/${control}/actions/runs/42`,
    created_at: "2026-11-25T11:00:00Z",
  };
  const responses = new Map<string, unknown>([
    [prefix, { full_name: repository, private: false, default_branch: "main" }],
    [`${prefix}/rulesets?includes_parents=false&per_page=100`, [{ ...closed, id: 12 }]],
    [`${prefix}/rulesets/12?includes_parents=false`, closed],
    [`${prefix}/branches/main`, { commit: { sha } }],
    [`${prefix}/branches/dev`, { commit: { sha } }],
    [`${prefix}/issues?state=open&per_page=100&page=1`, []],
    [
      `${prefix}/commits/${sha}/status`,
      attestFixtureStatuses({ statuses: [mainGuard] }, repository, sha),
    ],
    [
      `repos/${control}/actions/runs/42`,
      {
        id: 42,
        repository: { full_name: control },
        head_branch: "main",
        path: ".github/workflows/intake.yml",
        status: "completed",
        conclusion: "success",
        run_started_at: "2026-11-25T10:59:00Z",
        updated_at: "2026-11-25T11:01:00Z",
      },
    ],
  ]);
  const reader = {
    async get(path: string): Promise<unknown> {
      assert.ok(responses.has(path), path);
      return responses.get(path);
    },
  };
  const adopt = () =>
    verifyAutomaticDevAdoption(reader, repository, sha, { statuses: [] }, control);
  assert.equal(await adopt(), `init-v1=${sha}`);
  responses.set(`${prefix}/branches/main`, { commit: { sha: "b".repeat(40) } });
  assert.equal(await adopt(), undefined);
  responses.set(`${prefix}/branches/main`, { commit: { sha } });
  responses.set(`${prefix}/issues?state=open&per_page=100&page=1`, [
    { number: 614, title: "Dev write incident: example", author_association: "OWNER" },
  ]);
  responses.set(`${prefix}/issues/614/comments?per_page=100`, []);
  await assert.rejects(adopt(), /Unresolved dev write incident/);
});

test("controller bootstrap requires closed protection and trusted main, not auto-adoption", async () => {
  const path = `repos/${control}`;
  const status = {
    context: "Main Write Guard",
    state: "success",
    description: "verified main",
    target_url: `https://github.com/${control}/actions/runs/42`,
    created_at: "2026-11-25T11:00:00Z",
  };
  const responses = new Map<string, unknown>([
    [path, { full_name: control, private: false, default_branch: "main" }],
    [`${path}/rulesets?includes_parents=false&per_page=100`, [{ ...closed, id: 12 }]],
    [`${path}/rulesets/12?includes_parents=false`, closed],
    [`${path}/branches/main`, { commit: { sha } }],
    [`${path}/branches/dev`, { commit: { sha } }],
    [`${path}/issues?state=open&per_page=100&page=1`, []],
    [`${path}/commits/${sha}/status`, attestFixtureStatuses({ statuses: [status] }, control, sha)],
    [
      `${path}/actions/runs/42`,
      {
        id: 42,
        repository: { full_name: control },
        head_branch: "main",
        path: ".github/workflows/intake.yml",
        status: "completed",
        conclusion: "success",
        run_started_at: "2026-11-25T10:59:00Z",
        updated_at: "2026-11-25T11:01:00Z",
      },
    ],
  ]);
  const reader = {
    async get(endpoint: string): Promise<unknown> {
      assert.ok(responses.has(endpoint), endpoint);
      return responses.get(endpoint);
    },
  };
  await verifyBootstrapSource(reader, control, sha, control, true);
  assert.equal(
    await verifyAutomaticDevAdoption(reader, control, sha, { statuses: [] }, control),
    undefined
  );
  responses.set(`${path}/rulesets/12?includes_parents=false`, {});
  await assert.rejects(
    verifyBootstrapSource(reader, control, sha, control, true),
    /closed live protection/
  );
});

test("only an explicit private plan restriction permits compensated initialization", async () => {
  const limited = new GithubHttpError(403, undefined, { kind: "plan-restriction" });
  const reader = (error: unknown) => ({
    async get(): Promise<unknown> {
      throw error;
    },
  });
  assert.equal(await readClosedDevProtection(reader(limited), repository, true), "compensating");
  await assert.rejects(readClosedDevProtection(reader(limited), repository, false), /HTTP 403/);
  for (const error of [
    new GithubHttpError(403, undefined, { kind: "permission" }),
    new GithubHttpError(403, undefined, { kind: "primary-rate-limit" }),
    new GithubHttpError(404),
    new GithubHttpError(500),
  ]) {
    await assert.rejects(readClosedDevProtection(reader(error), repository, true));
  }
  await assert.rejects(
    readClosedDevProtection({ get: async () => [] }, repository, true),
    /Closed development ruleset is missing/
  );
});

test("completed manual authorization survives a later legitimate main advance", async () => {
  const mainSha = "b".repeat(40);
  const run = (id: number, path: string) => ({
    id,
    repository: { full_name: control },
    head_branch: "main",
    path,
    status: "completed",
    conclusion: "success",
    run_started_at: "2026-11-25T10:59:00Z",
    updated_at: "2026-11-25T11:01:00Z",
  });
  const receipt = {
    context: "Dev Bootstrap Authorization",
    state: "success",
    description: `init-v1=${sha}`,
    target_url: `https://github.com/${control}/actions/runs/42`,
    created_at: "2026-11-25T11:00:00Z",
  };
  const mainGuard = {
    ...receipt,
    context: "Main Write Guard",
    description: "verified main",
    target_url: `https://github.com/${control}/actions/runs/41`,
  };
  const statuses = attestFixtureStatuses({ statuses: [receipt, mainGuard] }, repository, sha);
  const comparePath = `${prefix}/compare/${sha}...${mainSha}`;
  const comparison = {
    status: "ahead",
    behind_by: 0,
    base_commit: { sha },
    merge_base_commit: { sha },
  };
  const responses = new Map<string, unknown>([
    [prefix, { full_name: repository, private: false, default_branch: "main" }],
    [`${prefix}/rulesets?includes_parents=false&per_page=100`, [{ ...closed, id: 12 }]],
    [`${prefix}/rulesets/12?includes_parents=false`, closed],
    [`${prefix}/branches/main`, { commit: { sha: mainSha } }],
    [`${prefix}/branches/dev`, { commit: { sha } }],
    [`${prefix}/issues?state=open&per_page=100&page=1`, []],
    [`${prefix}/commits/${sha}/status`, statuses],
    [comparePath, comparison],
    [`repos/${control}/actions/runs/41`, run(41, ".github/workflows/intake.yml")],
    [
      `repos/${control}/actions/runs/42`,
      run(42, ".github/workflows/authorize-branch-transfer.yml"),
    ],
  ]);
  const reader = {
    async get(path: string): Promise<unknown> {
      assert.ok(responses.has(path), path);
      return responses.get(path);
    },
  };
  const audit = () => verifyAuthorizedDevBootstrap(reader, repository, sha, statuses, control, now);
  assert.equal(await audit(), `init-v1=${sha}`);
  await assert.rejects(
    verifyBootstrapSource(reader, repository, sha, control, true),
    /branch identity changed/
  );
  assert.equal(
    await verifyAutomaticDevAdoption(reader, repository, sha, { statuses: [] }, control),
    undefined
  );
  responses.set(comparePath, { ...comparison, merge_base_commit: { sha: mainSha } });
  await assert.rejects(audit(), /branch identity changed/);
  responses.set(comparePath, comparison);
  responses.set(`${prefix}/branches/dev`, { commit: { sha: mainSha } });
  await assert.rejects(audit(), /branch identity changed/);
});
