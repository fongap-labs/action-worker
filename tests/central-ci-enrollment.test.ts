import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { missingBridges, selectBridgeCandidates } from "../scripts/central-ci-enrollment.ts";
import { GithubHttpError } from "../scripts/github-api.ts";

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
  const bridge = await readFile("templates/bridge/notify-action-worker.yml", "utf8");
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
  assert.match(
    workflow,
    /name: Mint App inventory read token[\s\S]*?permission-contents: read\n\s*permission-pull-requests: read/,
    "bridge discovery requires PR inventory read access but never PR write permission"
  );
  assert.match(workflow, /permission-workflows: write/);
  assert.doesNotMatch(workflow, /continue-on-error: true/);
  const script = await readFile("scripts/central-ci-enrollment.ts", "utf8");
  assert.match(script, /changed\[0\]\.filename !== bridgePath/);
  assert.match(script, /decodeGithubContent\(file\) !== template/);
  assert.match(script, /Central CI onboarding branch contains unverified work/);
  assert.match(script, /hasPendingBridgePullRequest/);
});

test("empty repositories defer bridge PR creation without reporting a verified bridge", async () => {
  const repository = "fongap-labs/new-public";
  const calls: string[] = [];
  const reader = {
    async get(path: string): Promise<unknown> {
      calls.push(path);
      if (path.endsWith("/contents/.github/workflows/notify-action-worker.yml?ref=main")) {
        throw new GithubHttpError(404);
      }
      if (path.endsWith("/pulls?state=open&base=main&per_page=100")) return [];
      if (path.endsWith("/git/ref/heads/main")) throw new GithubHttpError(409);
      if (path === "repos/" + repository) {
        return { full_name: repository, default_branch: "main", size: 0, archived: false };
      }
      throw new Error("Unexpected test request");
    },
  };
  const outcome = await missingBridges(reader, [{ repository, default_branch: "main" }]);
  assert.deepEqual(outcome, { targets: [], pending: 0, uninitialized: 1 });
  assert.ok(calls.includes("repos/" + repository + "/git/ref/heads/main"));
  assert.ok(calls.includes("repos/" + repository));
});

test("missing bridges on initialized main remain enrollment candidates", async () => {
  const repository = "fongap-labs/new-public";
  const sha = "a".repeat(40);
  const reader = {
    async get(path: string): Promise<unknown> {
      if (path.includes("/contents/")) throw new GithubHttpError(404);
      if (path.endsWith("/pulls?state=open&base=main&per_page=100")) return [];
      if (path.endsWith("/git/ref/heads/main")) return { object: { sha } };
      throw new Error("Unexpected test request");
    },
  };
  assert.deepEqual(await missingBridges(reader, [{ repository, default_branch: "main" }]), {
    targets: [{ repository, default_branch: "main" }],
    pending: 0,
    uninitialized: 0,
  });
});

test("409 on nonempty or unverifiable repositories and permission failures remain blocking", async () => {
  const repository = "fongap-labs/new-public";
  for (const [status, size] of [
    [409, 1],
    [409, null],
    [403, 0],
  ] as const) {
    const reader = {
      async get(path: string): Promise<unknown> {
        if (path.includes("/contents/")) throw new GithubHttpError(404);
        if (path.endsWith("/pulls?state=open&base=main&per_page=100")) return [];
        if (path.endsWith("/git/ref/heads/main")) throw new GithubHttpError(status);
        if (path === "repos/" + repository) {
          return { full_name: repository, default_branch: "main", size, archived: false };
        }
        throw new Error("Unexpected test request");
      },
    };
    await assert.rejects(missingBridges(reader, [{ repository, default_branch: "main" }]));
  }
});
