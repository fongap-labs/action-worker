import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auditRepositoryMain,
  hasReusableFailedMainGuard,
  hasReusableSuccessfulMainGuard,
} from "../scripts/audit-main-writes.ts";
import type { GithubReader } from "../scripts/github-api.ts";
import {
  MainWriteVerificationPendingError,
  mainWriteEvidenceError,
  validateMainWriteProvenance,
} from "../scripts/main-write-guard.ts";
import { signedStatusDescription } from "../scripts/status-attestation.ts";

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

test("complete exact commit association avoids redundant PR detail GET", async () => {
  const { reader, requests } = fixture("fix: normal merge", [goodPr]);
  const result = await validateMainWriteProvenance(reader, repository, mainSha, false);
  assert.equal(result.pr_number, 44);
  assert.equal(result.pr_head_sha, headSha);
  assert.equal(requests.filter((path) => path.endsWith("/pulls/44")).length, 0);
  assert.equal(
    requests.filter((path) => path.endsWith("/check-runs?filter=latest&per_page=100")).length,
    1,
    "the independent local validate-merge check is never omitted"
  );
});

test("incomplete commit-associated PR requires an independently verified detail GET", async () => {
  const association = { ...goodPr, head: { sha: "" } };
  const { reader, requests } = fixture("fix: normal merge", [association]);
  const result = await validateMainWriteProvenance(reader, repository, mainSha, false);
  assert.equal(result.pr_head_sha, headSha);
  assert.equal(requests.filter((path) => path.endsWith("/pulls/44")).length, 1);
});

test("inconsistent PR detail number after an incomplete association fails closed", async () => {
  const association = { ...goodPr, head: { sha: "not-a-sha" } };
  const { reader, requests } = fixture("fix: normal merge", [association], {
    ...goodPr,
    number: 55,
  });
  await assert.rejects(
    validateMainWriteProvenance(reader, repository, mainSha, false),
    /Merged pull request facts do not match/
  );
  assert.equal(requests.filter((path) => path.endsWith("/pulls/44")).length, 1);
  assert.equal(
    requests.filter((path) => path.includes("/check-runs")).length,
    0,
    "mismatched PR facts must never reach the CI evidence phase"
  );
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
  assert.deepEqual(verified, { main_sha: mainSha, pr_number: 44, pr_head_sha: headSha });
  assert.equal(observedSha, mainSha);
  assert.equal(
    requests.length,
    5,
    "one repository, one main HEAD, associated PR, CI and incident checks"
  );
  assert.equal(requests.filter((path) => path.endsWith("/pulls/44")).length, 0);
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

test("main write audit reuses only a signed guard from a successful control run", async () => {
  const previousKeyring = process.env.AW_STATUS_KEYRING;
  process.env.AW_STATUS_KEYRING = JSON.stringify({
    schema_version: 1,
    active: "k1",
    keys: { k1: "A".repeat(43) },
    legacy_tokens: [],
  });
  try {
    const runId = 43849134815;
    const targetUrl = `https://github.com/fongap-labs/action-worker/actions/runs/${runId}`;
    const status = {
      state: "success",
      context: "Main Write Guard",
      description: signedStatusDescription({
        repository,
        sha: mainSha,
        state: "success",
        context: "Main Write Guard",
        description: "Trusted main write via PR #44",
        targetUrl,
      }),
      target_url: targetUrl,
      created_at: "2026-11-16T10:28:49Z",
    };
    const run = {
      id: runId,
      repository: { full_name: "fongap-labs/action-worker" },
      path: ".github/workflows/intake.yml",
      head_branch: "main",
      status: "completed",
      conclusion: "success",
      run_started_at: "2026-11-16T10:28:19Z",
      updated_at: "2026-11-16T10:29:04Z",
    };
    const requests: string[] = [];
    const reader = {
      async get(path: string): Promise<unknown> {
        requests.push(path);
        if (path === `repos/${repository}/commits/${mainSha}/status`) {
          return { statuses: [status] };
        }
        if (path === `repos/fongap-labs/action-worker/actions/runs/${runId}`) {
          return run;
        }
        throw new Error(`Unexpected API path: ${path}`);
      },
    } as GithubReader;

    assert.equal(await hasReusableSuccessfulMainGuard(reader, repository, mainSha), true);
    assert.equal(requests.length, 2);

    run.conclusion = "failure";
    assert.equal(await hasReusableSuccessfulMainGuard(reader, repository, mainSha), false);

    run.conclusion = "success";
    status.state = "failure";
    assert.equal(await hasReusableSuccessfulMainGuard(reader, repository, mainSha), false);

    status.state = "success";
    status.description = "Unattested success";
    assert.equal(await hasReusableSuccessfulMainGuard(reader, repository, mainSha), false);
  } finally {
    if (previousKeyring === undefined) delete process.env.AW_STATUS_KEYRING;
    else process.env.AW_STATUS_KEYRING = previousKeyring;
  }
});

test("signed repeated main guard failure is reused without bypassing validation", async () => {
  const previousKeyring = process.env.AW_STATUS_KEYRING;
  process.env.AW_STATUS_KEYRING = JSON.stringify({
    schema_version: 1,
    active: "k1",
    keys: { k1: "A".repeat(43) },
    legacy_tokens: [],
  });
  try {
    const targetUrl = "https://github.com/fongap-labs/action-worker/actions/runs/123";
    const status = {
      state: "failure",
      context: "Main Write Guard",
      description: signedStatusDescription({
        repository,
        sha: mainSha,
        state: "failure",
        context: "Main Write Guard",
        description: "Untrusted main write",
        targetUrl,
      }),
      target_url: targetUrl,
    };
    const reader = {
      async get(path: string): Promise<unknown> {
        assert.equal(path, `repos/${repository}/commits/${mainSha}/status`);
        return { statuses: [status] };
      },
    } as GithubReader;
    assert.equal(await hasReusableFailedMainGuard(reader, repository, mainSha), true);
    status.state = "success";
    assert.equal(await hasReusableFailedMainGuard(reader, repository, mainSha), false);
    status.state = "failure";
    status.description = "Untrusted main write";
    assert.equal(await hasReusableFailedMainGuard(reader, repository, mainSha), false);
    const failedReader = {
      async get(): Promise<unknown> {
        throw new Error("temporary status read failure");
      },
    } as unknown as GithubReader;
    assert.equal(await hasReusableFailedMainGuard(failedReader, repository, mainSha), false);
  } finally {
    if (previousKeyring === undefined) delete process.env.AW_STATUS_KEYRING;
    else process.env.AW_STATUS_KEYRING = previousKeyring;
  }
});

test("post-merge remediation fixes display status but cannot authorize release provenance", async () => {
  const oldKeyring = process.env.AW_STATUS_KEYRING;
  process.env.AW_STATUS_KEYRING = JSON.stringify({
    schema_version: 1,
    active: "k1",
    keys: { k1: "A".repeat(43) },
    legacy_tokens: [],
  });
  try {
    const url = "https://github.com/fongap-labs/action-worker/actions/runs/987";
    const remediated = {
      state: "success",
      context: "Main Write Guard",
      description: signedStatusDescription({
        repository,
        sha: mainSha,
        state: "success",
        context: "Main Write Guard",
        description: "Post-merge CI remediation PR #471 (incident #473)",
        targetUrl: url,
      }),
      target_url: url,
      created_at: "2026-11-16T10:28:49Z",
    };
    const requests: string[] = [];
    const reader = {
      async get(path: string): Promise<unknown> {
        requests.push(path);
        if (path === `repos/${repository}/commits/${mainSha}/status`) {
          return { statuses: [remediated] };
        }
        throw new Error(`Remediation must not be verified as source provenance: ${path}`);
      },
    } as GithubReader;
    assert.equal(await hasReusableSuccessfulMainGuard(reader, repository, mainSha), false);
    assert.deepEqual(requests, [`repos/${repository}/commits/${mainSha}/status`]);
  } finally {
    if (oldKeyring === undefined) delete process.env.AW_STATUS_KEYRING;
    else process.env.AW_STATUS_KEYRING = oldKeyring;
  }
});

test("exact Delta history target enters the strict migration verifier, not the PR fallback", async () => {
  const repo = "fongap-labs/delta";
  const sha = "decc6ee1388df99d2769024ac78b0f153ab8800d";
  const reads: string[] = [];
  const reader = {
    async get(path: string): Promise<unknown> {
      reads.push(path);
      if (path === `repos/${repo}`) return { default_branch: "main" };
      if (path === `repos/${repo}/commits/${sha}`) return { sha };
      if (path === `repos/${repo}/git/ref/heads/main`) {
        return { object: { sha: "f".repeat(40) } };
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  } as GithubReader;
  await assert.rejects(
    validateMainWriteProvenance(reader, repo, sha, true),
    /Delta history migration denied: protected reference main/
  );
  assert.ok(
    !reads.some((path) => path.endsWith("/pulls?per_page=100")),
    "migration cannot be mistaken for an ordinary merged PR"
  );
});
