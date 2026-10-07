import assert from "node:assert/strict";
import { test } from "node:test";
import type { GithubReader } from "../scripts/github-api.ts";
import { CliError } from "../scripts/runtime-command.ts";
import { validateTaskSource } from "../scripts/validate-task-source.ts";

const repository = "fongap-labs/example";
const headSha = "a".repeat(40);
const prHeadSha = "b".repeat(40);
const staleSha = "c".repeat(40);
const controlRuns = "https://github.com/fongap-labs/action-worker/actions/runs/";
const fast = { statusAttempts: 1, runAttempts: 1, retryDelayMs: 0 };

function run(path = ".github/workflows/central-ci-dispatch.yml", conclusion = "success") {
  return {
    repository: { full_name: "fongap-labs/action-worker" },
    path,
    head_branch: "main",
    status: "completed",
    conclusion,
    run_started_at: "2026-10-02T13:10:00Z",
    updated_at: "2026-10-02T13:12:00Z",
  };
}

function ciStatus(runId: number) {
  return {
    context: "CI Evidence",
    state: "success",
    target_url: `${controlRuns}${runId}`,
    created_at: "2026-10-02T13:11:00Z",
  };
}

function world() {
  const paths = new Map<string, unknown>([
    [`repos/${repository}`, { default_branch: "main" }],
    [`repos/${repository}/commits/main`, { sha: headSha }],
    [`repos/${repository}/commits/${headSha}`, { sha: headSha }],
    [
      `repos/${repository}/commits/${headSha}/pulls?per_page=100`,
      [
        {
          number: 7,
          merged_at: "2026-10-02T13:00:00Z",
          merge_commit_sha: headSha,
          base: { ref: "main" },
        },
      ],
    ],
    [
      `repos/${repository}/pulls/7`,
      {
        number: 7,
        merged_at: "2026-10-02T13:00:00Z",
        merge_commit_sha: headSha,
        base: { ref: "main" },
        head: { sha: prHeadSha },
      },
    ],
    [
      `repos/${repository}/commits/${prHeadSha}/status`,
      {
        statuses: [
          { context: "PR Governance", state: "success", target_url: `${controlRuns}1` },
          ciStatus(2),
          { context: "validate-merge", state: "success", target_url: `${controlRuns}1` },
        ],
      },
    ],
    [
      `repos/${repository}/commits/${headSha}/status`,
      {
        statuses: [
          ciStatus(3),
          { context: "Main Write Guard", state: "success", target_url: `${controlRuns}4` },
        ],
      },
    ],
    ["repos/fongap-labs/action-worker/actions/runs/2", run()],
    ["repos/fongap-labs/action-worker/actions/runs/3", run()],
  ]);
  const requested: string[] = [];
  const reader = {
    async get(path: string): Promise<unknown> {
      requested.push(path);
      if (!paths.has(path)) {
        throw new Error(`unexpected path: ${path}`);
      }
      return paths.get(path);
    },
  } as unknown as GithubReader;
  return { paths, reader, requested };
}

async function exitCodeOf(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof CliError ? error.exitCode : -1;
  }
  return undefined;
}

test("task source gate accepts the default HEAD with verified evidence and a trusted main write", async () => {
  const { reader } = world();
  const check = await validateTaskSource(reader, repository, headSha, fast);
  assert.equal(check.default_branch, "main");
  assert.equal(check.main_write.pr_number, 7);
  await validateTaskSource(reader, repository, headSha.toUpperCase(), fast);
});

test("task source gate rejects a ref that is not the current default HEAD without side effects", async () => {
  const { reader, requested } = world();
  assert.equal(await exitCodeOf(validateTaskSource(reader, repository, staleSha, fast)), 75);
  assert.deepEqual(requested, [`repos/${repository}`, `repos/${repository}/commits/main`]);
});

test("task source gate rejects malformed requests before any API call", async () => {
  const { reader, requested } = world();
  assert.equal(await exitCodeOf(validateTaskSource(reader, repository, "abc", fast)), 64);
  assert.equal(await exitCodeOf(validateTaskSource(reader, "not a repo", headSha, fast)), 64);
  assert.deepEqual(requested, []);
});

test("task source gate rejects a default HEAD without CI Evidence", async () => {
  const { paths, reader } = world();
  paths.set(`repos/${repository}/commits/${headSha}/status`, { statuses: [] });
  assert.equal(await exitCodeOf(validateTaskSource(reader, repository, headSha, fast)), 65);
});

test("task source gate rejects CI Evidence that points at an unrelated or failed control run", async () => {
  for (const forged of [
    run(".github/workflows/validate-ci.yml"),
    run(".github/workflows/central-ci-dispatch.yml", "failure"),
  ]) {
    const { paths, reader } = world();
    paths.set("repos/fongap-labs/action-worker/actions/runs/3", forged);
    assert.equal(await exitCodeOf(validateTaskSource(reader, repository, headSha, fast)), 65);
  }
});

test("task source gate rejects a commit that is not a trusted main write", async () => {
  const direct = world();
  direct.paths.set(`repos/${repository}/commits/${headSha}/pulls?per_page=100`, []);
  assert.equal(await exitCodeOf(validateTaskSource(direct.reader, repository, headSha, fast)), 65);

  const failedGuard = world();
  failedGuard.paths.set(`repos/${repository}/commits/${headSha}/status`, {
    statuses: [
      ciStatus(3),
      { context: "Main Write Guard", state: "failure", target_url: `${controlRuns}4` },
    ],
  });
  assert.equal(
    await exitCodeOf(validateTaskSource(failedGuard.reader, repository, headSha, fast)),
    65
  );
});
