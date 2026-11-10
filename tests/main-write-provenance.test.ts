import assert from "node:assert/strict";
import { test } from "node:test";
import type { GithubReader } from "../scripts/github-api.ts";
import { auditRepositoryMain } from "../scripts/audit-main-writes.ts";
import {
  MainWriteVerificationPendingError,
  mainWriteEvidenceError,
  validateMainWriteProvenance,
} from "../scripts/main-write-guard.ts";

const repository = "fongap-labs/dsh-plugin";
const mainSha = "a".repeat(40);
const headSha = "b".repeat(40);
const goodPr = {
  number: 44,
  merged_at: "2026-11-02T16:00:21Z",
  merge_commit_sha: mainSha,
  base: { ref: "main" },
  head: { sha: headSha },
};

function fixture(
  subject: string,
  associated: unknown[],
  hintedPr: unknown = goodPr
): { reader: GithubReader; requests: string[] } {
  const requests: string[] = [];
  const reader = {
    async get(path: string): Promise<unknown> {
      requests.push(path);
      if (path === `repos/${repository}`) return { default_branch: "main" };
      if (path === `repos/${repository}/commits/${mainSha}`) {
        return { sha: mainSha, commit: { message: subject } };
      }
      if (path === `repos/${repository}/commits/${mainSha}/pulls?per_page=100`) {
        return associated;
      }
      if (path === `repos/${repository}/pulls/44`) return hintedPr;
      if (path === `repos/${repository}/commits/${headSha}/check-runs?filter=latest&per_page=100`) {
        return {
          check_runs: [
            {
              name: "validate-merge",
              status: "completed",
              conclusion: "success",
              app: { slug: "github-actions" },
            },
          ],
        };
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  } as GithubReader;
  return { reader, requests };
}

test("squash release commit verifies the exact merged PR when reverse association is empty", async () => {
  const { reader, requests } = fixture("chore(release): dsh-ui-delta-v0.1.0-beta.6 (#44)", []);
  const result = await validateMainWriteProvenance(reader, repository, mainSha, false);
  assert.equal(result.pr_number, 44);
  assert.equal(result.pr_head_sha, headSha);
  assert.equal(requests.filter((path) => path.endsWith("/pulls/44")).length, 1);
});

test("a forged PR number cannot substitute for an exact merge SHA", async () => {
  const { reader } = fixture("fix: direct write pretending to be PR (#44)", [], {
    ...goodPr,
    merge_commit_sha: "c".repeat(40),
  });
  await assert.rejects(
    validateMainWriteProvenance(reader, repository, mainSha, false),
    /not uniquely attributable/
  );
});

test("an unmerged PR cannot satisfy the fallback", async () => {
  const { reader } = fixture("fix: fake merged reference (#44)", [], {
    ...goodPr,
    merged_at: null,
  });
  await assert.rejects(
    validateMainWriteProvenance(reader, repository, mainSha, false),
    /not uniquely attributable/
  );
});

test("direct writes without a verifiable PR reference remain rejected", async () => {
  const { reader, requests } = fixture("fix: direct main write", []);
  await assert.rejects(
    validateMainWriteProvenance(reader, repository, mainSha, false),
    /not uniquely attributable/
  );
  assert.ok(!requests.some((path) => path.endsWith("/pulls/44")));
});

test("existing verified commit associations still work without a fallback", async () => {
  const { reader, requests } = fixture("fix: normal merge", [goodPr]);
  const result = await validateMainWriteProvenance(reader, repository, mainSha, false);
  assert.equal(result.pr_number, 44);
  assert.equal(requests.filter((path) => path.endsWith("/pulls/44")).length, 1);
});

test("ambiguous associations are rejected even if the commit subject includes a PR number", async () => {
  const { reader } = fixture("fix: ambiguous (#44)", [goodPr, goodPr]);
  await assert.rejects(
    validateMainWriteProvenance(reader, repository, mainSha, false),
    /not uniquely attributable/
  );
});

test("ongoing control runs remain untrusted without creating permanent incident evidence", () => {
  for (const context of ["PR Governance", "CI Evidence", "validate-merge"] as const) {
    const pending = mainWriteEvidenceError(context, "run-still-running");
    assert.ok(pending instanceof MainWriteVerificationPendingError);
    assert.match(pending.message, /run-still-running/);
    assert.match(pending.message, new RegExp(context));
  }
  for (const reason of [
    "status-missing",
    "status-not-success",
    "run-not-success",
    "run-outside-window",
    "run-mismatch",
    "run-not-found",
  ]) {
    const failure = mainWriteEvidenceError("PR Governance", reason);
    assert.equal(failure instanceof MainWriteVerificationPendingError, false, reason);
    assert.match(failure.message, new RegExp(reason));
  }
});

test("main write audit uses one pinned HEAD snapshot without duplicate repository and commit reads", async () => {
  const requests: string[] = [];
  const reader = {
    async get(path: string): Promise<unknown> {
      requests.push(path);
      if (path === `repos/${repository}`) return { default_branch: "main" };
      if (path === `repos/${repository}/commits/main`) {
        return { sha: mainSha, commit: { message: "fix: safe merge (#44)" } };
      }
      if (path === `repos/${repository}/commits/${mainSha}/pulls?per_page=100`) {
        return [goodPr];
      }
      if (path === `repos/${repository}/pulls/44`) return goodPr;
      if (path === `repos/${repository}/commits/${headSha}/check-runs?filter=latest&per_page=100`) {
        return {
          check_runs: [
            {
              name: "validate-merge",
              status: "completed",
              conclusion: "success",
              app: { slug: "github-actions" },
            },
          ],
        };
      }
      if (path === `repos/${repository}/issues?state=open&per_page=100&page=1`) return [];
      throw new Error(`Unnecessary or unexpected API request: ${path}`);
    },
  } as GithubReader;
  let observedSha = "";
  const verified = await auditRepositoryMain(reader, repository, false, (sha) => {
    observedSha = sha;
  });
  assert.deepEqual(verified, { main_sha: mainSha, pr_number: 44 });
  assert.equal(observedSha, mainSha);
  assert.equal(requests.length, 6, "one repository, one main HEAD, and four independent checks");
  assert.equal(requests.filter((path) => path === `repos/${repository}`).length, 1);
  assert.equal(requests.filter((path) => path === `repos/${repository}/commits/main`).length, 1);
  assert.equal(requests.includes(`repos/${repository}/commits/${mainSha}`), false);
});

test("a mismatched or untrusted audit snapshot fails closed before PR evidence", async () => {
  const { reader, requests } = fixture("fix: safe merge (#44)", [goodPr]);
  for (const snapshot of [
    { repositoryValue: { default_branch: "develop" }, mainCommit: { sha: mainSha } },
    { repositoryValue: { default_branch: "main" }, mainCommit: { sha: headSha } },
    { repositoryValue: { default_branch: "main" }, mainCommit: {} },
  ]) {
    await assert.rejects(
      validateMainWriteProvenance(reader, repository, mainSha, false, snapshot),
      /default branch must be main|could not be resolved exactly/
    );
  }
  assert.deepEqual(requests, [], "invalid pinned snapshots must not consult GitHub for PR data");
});

test("direct provenance validation still fetches independently when no snapshot is supplied", async () => {
  const { reader, requests } = fixture("fix: normal merge", [goodPr]);
  const result = await validateMainWriteProvenance(reader, repository, mainSha, false);
  assert.equal(result.pr_number, 44);
  assert.ok(requests.includes(`repos/${repository}`));
  assert.ok(requests.includes(`repos/${repository}/commits/${mainSha}`));
});
