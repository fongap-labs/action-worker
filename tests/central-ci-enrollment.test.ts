import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { selectBridgeCandidates } from "../scripts/central-ci-enrollment.ts";

const repos = [
  {
    full_name: "fongap-labs/action-worker",
    private: false,
    archived: false,
    default_branch: "main",
  },
  { full_name: "fongap-labs/old-private", private: true, archived: false, default_branch: "main" },
  { full_name: "fongap-labs/new-public", private: false, archived: false, default_branch: "main" },
  { full_name: "fongap-labs/archived", private: true, archived: true, default_branch: "main" },
];

test("default central CI covers every active installed repository without age or visibility filters", () => {
  assert.deepEqual(selectBridgeCandidates(repos, "fongap-labs/action-worker"), [
    { repository: "fongap-labs/new-public", default_branch: "main" },
    { repository: "fongap-labs/old-private", default_branch: "main" },
  ]);
});

test("central CI enrollment rejects duplicate, external, and unsupported repository identities", () => {
  assert.throws(() => selectBridgeCandidates([repos[1]!, repos[1]!], "fongap-labs/action-worker"));
  assert.throws(() =>
    selectBridgeCandidates(
      [{ ...repos[1]!, full_name: "external/repository" }],
      "fongap-labs/action-worker"
    )
  );
  assert.throws(() =>
    selectBridgeCandidates(
      [{ ...repos[1]!, default_branch: "master" }],
      "fongap-labs/action-worker"
    )
  );
});

test("central CI bridge template matches the protected security hash and the writer stays scoped", async () => {
  const bridge = await readFile("policies/templates/notify-action-worker.yml", "utf8");
  const policy = JSON.parse(await readFile("policies/security.json", "utf8")) as {
    approved_workflows: Array<{ path: string; sha256: string }>;
  };
  const expected = policy.approved_workflows.find(
    (item) => item.path === ".github/workflows/notify-action-worker.yml"
  );
  assert.ok(expected);
  assert.equal(createHash("sha256").update(bridge).digest("hex"), expected.sha256);
  const workflow = await readFile(".github/workflows/enroll-organization-repositories.yml", "utf8");
  assert.match(workflow, /node scripts\/central-ci-enrollment\.ts plan/);
  assert.match(workflow, /node scripts\/central-ci-enrollment\.ts apply/);
  assert.match(workflow, /repositories: \$\{\{ steps\.ci_scope\.outputs\.repositories_csv \}\}/);
  assert.match(workflow, /permission-contents: write/);
  assert.match(workflow, /permission-pull-requests: write/);
  assert.match(workflow, /permission-workflows: write/);
  assert.doesNotMatch(workflow, /continue-on-error: true/);
  const script = await readFile("scripts/central-ci-enrollment.ts", "utf8");
  assert.match(script, /changed\[0\]\.filename !== bridgePath/);
  assert.match(script, /decodeGithubContent\(file\) !== template/);
  assert.match(script, /Central CI onboarding branch contains unverified work/);
  assert.match(script, /hasPendingBridgePullRequest/);
});
