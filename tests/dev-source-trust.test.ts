import assert from "node:assert/strict";
import { test } from "node:test";
import { assertTrustedDevSource } from "../scripts/dev-source-trust.ts";
import { prTitleFingerprint } from "../scripts/pr-title-fingerprint.ts";
import { attestFixtureStatuses } from "./attested-status-fixtures.ts";

const repo = "fongap-labs/example";
const sha = "a".repeat(40);
const headSha = "b".repeat(40);
const title = "feat: add Beta routing";
const validPr = {
  number: 51,
  state: "closed",
  merged_at: "2026-11-15T04:00:00Z",
  merge_commit_sha: sha,
  base: { ref: "dev" },
  head: { sha: headSha },
  title,
};
const statusUrl = (run: number) =>
  `https://github.com/fongap-labs/action-worker/actions/runs/${run}`;
const runs = {
  100: {
    id: 100,
    path: ".github/workflows/handle-pr-dispatch.yml",
    repository: { full_name: "fongap-labs/action-worker" },
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    run_started_at: "2026-11-15T03:30:00Z",
    updated_at: "2026-11-15T04:01:00Z",
  },
  101: {
    id: 101,
    path: ".github/workflows/central-ci-dispatch.yml",
    repository: { full_name: "fongap-labs/action-worker" },
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    run_started_at: "2026-11-15T03:30:00Z",
    updated_at: "2026-11-15T04:01:00Z",
  },
};
function readerFor({
  devSha = sha,
  pr = validPr,
  associated = [validPr],
  statuses,
}: {
  devSha?: string;
  pr?: typeof validPr;
  associated?: Array<typeof validPr>;
  statuses?: unknown;
} = {}) {
  const messagePrefix = `title-sha256=${prTitleFingerprint(title)} `;
  const successStatuses = attestFixtureStatuses(
    {
      statuses: [
        ...["PR Governance", "validate-merge"].map((context) => ({
          context,
          state: "success",
          target_url: statusUrl(100),
          created_at: "2026-11-15T03:58:00Z",
          description: `${messagePrefix}Verified PR gate`,
        })),
        {
          context: "CI Evidence",
          state: "success",
          target_url: statusUrl(101),
          created_at: "2026-11-15T03:58:00Z",
          description: "Central CI succeeded",
        },
      ],
    },
    repo,
    headSha
  );
  return {
    async get(path: string): Promise<unknown> {
      switch (path) {
        case `repos/${repo}`:
          return { default_branch: "main" };
        case `repos/${repo}/git/ref/heads/dev`:
          return { ref: "refs/heads/dev", object: { sha: devSha } };
        case `repos/${repo}/commits/${sha}`:
          return { sha, commit: { message: "feat: deploy Beta (#51)" } };
        case `repos/${repo}/commits/${sha}/pulls?per_page=100`:
          return associated;
        case `repos/${repo}/pulls/51`:
          return pr;
        case `repos/${repo}/commits/${headSha}/status`:
          return statuses ?? successStatuses;
        case "repos/fongap-labs/action-worker/actions/runs/100":
          return runs[100];
        case "repos/fongap-labs/action-worker/actions/runs/101":
          return runs[101];
        default:
          throw new Error(`Unexpected GitHub path: ${path}`);
      }
    },
  };
}

test("dev Beta source requires an exact merged PR with verified signed CI", async () => {
  const proof = await assertTrustedDevSource(readerFor(), repo, sha);
  assert.deepEqual(proof, { dev_sha: sha, pr_number: 51, pr_head_sha: headSha });
});

test("dev Beta gate rejects stale SHA, direct pushes, wrong PR base or wrong title", async () => {
  await assert.rejects(assertTrustedDevSource(readerFor({ devSha: "c".repeat(40) }), repo, sha));
  await assert.rejects(
    assertTrustedDevSource(
      readerFor({ associated: [], pr: { ...validPr, number: 51, title: "" } }),
      repo,
      sha
    )
  );
  await assert.rejects(
    assertTrustedDevSource(readerFor({ pr: { ...validPr, base: { ref: "main" } } }), repo, sha)
  );
  await assert.rejects(
    assertTrustedDevSource(readerFor({ pr: { ...validPr, title: "other PR title" } }), repo, sha)
  );
  await assert.rejects(
    assertTrustedDevSource(readerFor({ associated: [{ ...validPr, base: { ref: "main" } }] }), repo, sha)
  );
});
