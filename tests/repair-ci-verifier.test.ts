import assert from "node:assert/strict";
import { after, test } from "node:test";
import { loadGateContract } from "../scripts/governance-gate-contract.ts";
import { prTitleFingerprint } from "../scripts/pr-title-fingerprint.ts";
import { verifyRepairPullRequest } from "../scripts/repair-ci-verifier.ts";
import { signedStatusDescription } from "../scripts/status-attestation.ts";

const repository = "fongap-labs/dsh-plugin";
const controlRepository = "fongap-labs/action-worker";
const issueNumber = 1739;
const prNumber = 521;
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const title = "fix(delta-code): repair skill discovery";
const now = "2026-11-21T10:00:00Z";
const verifiedAt = "2026-11-21T10:02:00Z";
const governanceRunUrl = "https://github.com/fongap-labs/action-worker/actions/runs/101";
const ciRunUrl = "https://github.com/fongap-labs/action-worker/actions/runs/102";
const contract = loadGateContract();
const previousKeyring = process.env.AW_STATUS_KEYRING;

process.env.AW_STATUS_KEYRING = JSON.stringify({
  schema_version: 1,
  active: "k1",
  keys: { k1: Buffer.alloc(32, 7).toString("base64url") },
  legacy_tokens: [],
});

function makeStatus(context: string, targetUrl: string, id: number, description: string) {
  return {
    id,
    context,
    state: "success",
    target_url: targetUrl,
    created_at: now,
    description: signedStatusDescription({
      repository,
      sha: headSha,
      state: "success",
      context,
      description,
      targetUrl,
    }),
  };
}

function fixture() {
  const titleEvidence = "title-sha256=" + prTitleFingerprint(title) + " Central CI gate verdict";
  const statuses = {
    statuses: [
      makeStatus(contract.status_contexts.pr_governance, governanceRunUrl, 201, titleEvidence),
      makeStatus(contract.status_contexts.ci_evidence, ciRunUrl, 202, "Central CI gate verdict"),
      makeStatus(contract.status_contexts.merge_validation, governanceRunUrl, 203, titleEvidence),
    ],
  };
  const pull = {
    state: "open",
    number: prNumber,
    merged: false,
    draft: false,
    title,
    head: { sha: headSha, repo: { full_name: repository } },
    base: { sha: baseSha, ref: "main", repo: { full_name: repository } },
  };
  const runs = new Map<string, unknown>([
    [
      "repos/" + controlRepository + "/actions/runs/101",
      {
        id: 101,
        repository: { full_name: controlRepository },
        path: ".github/workflows/handle-pr-dispatch.yml",
        head_branch: "main",
        status: "completed",
        conclusion: "success",
        run_started_at: "2026-11-21T09:59:00Z",
        updated_at: "2026-11-21T10:01:00Z",
      },
    ],
    [
      "repos/" + controlRepository + "/actions/runs/102",
      {
        id: 102,
        repository: { full_name: controlRepository },
        path: ".github/workflows/central-ci-dispatch.yml",
        head_branch: "main",
        status: "completed",
        conclusion: "success",
        run_started_at: "2026-11-21T09:59:00Z",
        updated_at: "2026-11-21T10:01:00Z",
      },
    ],
  ]);
  const calls: string[] = [];
  const reader = {
    async get(path: string): Promise<unknown> {
      calls.push(path);
      if (path === "repos/" + repository + "/pulls/" + prNumber) return pull;
      if (path === "repos/" + repository + "/commits/" + headSha + "/status") return statuses;
      if (runs.has(path)) return runs.get(path);
      throw new Error("Unexpected read path: " + path);
    },
  };
  return { pull, statuses, runs, reader, calls };
}

function identity(
  overrides: Partial<{
    repository: string;
    issue_number: number;
    pr_number: number;
    head_sha: string;
    base_sha: string;
  }> = {}
) {
  return {
    repository,
    issue_number: issueNumber,
    pr_number: prNumber,
    head_sha: headSha,
    base_sha: baseSha,
    ...overrides,
  };
}

function verify(
  reader: { get(path: string): Promise<unknown> },
  overrides: Parameters<typeof identity>[0] = {},
  verified_at = verifiedAt
) {
  return verifyRepairPullRequest(reader, identity(overrides), {
    control_repository: controlRepository,
    verified_at,
  });
}

test("repair verifier requires the exact PR head/base and all signed central gates", async () => {
  const f = fixture();
  const proof = await verify(f.reader);
  assert.equal(proof.schema_version, "1");
  assert.equal(proof.repository, repository);
  assert.equal(proof.issue_number, issueNumber);
  assert.equal(proof.pr_number, prNumber);
  assert.equal(proof.head_sha, headSha);
  assert.equal(proof.base_sha, baseSha);
  assert.equal(proof.ci_run_id, 102);
  assert.equal(proof.governance_run_id, 101);
  assert.deepEqual(proof.required_gate_contexts, [
    contract.status_contexts.pr_governance,
    contract.status_contexts.ci_evidence,
    contract.status_contexts.merge_validation,
  ]);
  assert.match(proof.evidence_sha256, /^[0-9a-f]{64}$/);
  assert.ok(f.calls.includes("repos/" + controlRepository + "/actions/runs/101"));
  assert.ok(f.calls.includes("repos/" + controlRepository + "/actions/runs/102"));
  assert.equal(
    f.calls.some((path) => /merge|update|dispatch|pulls\/\d+\/reviews/.test(path)),
    false
  );
});

test("verification fingerprint binds the source issue as well as PR and immutable SHAs", async () => {
  const f = fixture();
  const first = await verify(f.reader);
  const second = await verify(f.reader, { issue_number: issueNumber + 1 });
  assert.notEqual(first.evidence_sha256, second.evidence_sha256);
});

test("stale head or base and fork PRs are rejected", async () => {
  const f = fixture();
  await assert.rejects(verify(f.reader, { head_sha: "c".repeat(40) }), /head or base changed/);
  await assert.rejects(verify(f.reader, { base_sha: "d".repeat(40) }), /head or base changed/);
  f.pull.head.repo.full_name = "external/fork";
  await assert.rejects(verify(f.reader), /fork or cross-repository/);
});

test("draft, closed and title-changed PRs cannot pass the repair CI gate", async () => {
  const f = fixture();
  f.pull.draft = true;
  await assert.rejects(verify(f.reader), /non-draft/);
  f.pull.draft = false;
  f.pull.state = "closed";
  await assert.rejects(verify(f.reader), /open, non-draft/);
  f.pull.state = "open";
  f.pull.title = "fix(delta-code): changed after gate";
  await assert.rejects(verify(f.reader), /current PR title/);
});

test("signed success without an actual CI run is not repair evidence", async () => {
  const f = fixture();
  f.statuses.statuses[1] = makeStatus(
    contract.status_contexts.ci_evidence,
    ciRunUrl,
    204,
    "CI not run: the governance plan does not require CI"
  );
  await assert.rejects(verify(f.reader), /completed successful central CI run/);
});

test("CI Evidence and PR Governance must come from their trusted completed workflows", async () => {
  const badCi = fixture();
  const ciRun = badCi.runs.get("repos/" + controlRepository + "/actions/runs/102") as Record<
    string,
    unknown
  >;
  ciRun.path = ".github/workflows/untrusted.yml";
  await assert.rejects(verify(badCi.reader), /completed successful central CI run/);

  const badGovernance = fixture();
  const governanceRun = badGovernance.runs.get(
    "repos/" + controlRepository + "/actions/runs/101"
  ) as Record<string, unknown>;
  governanceRun.path = ".github/workflows/untrusted.yml";
  await assert.rejects(verify(badGovernance.reader), /trusted completed PR Governance run/);
});

test("unsigned or missing required gate statuses fail closed", async () => {
  const unsigned = fixture();
  const first = unsigned.statuses.statuses[0];
  assert.ok(first);
  unsigned.statuses.statuses[0] = { ...first, description: "unsigned green status" };
  await assert.rejects(verify(unsigned.reader), /trusted control run/);

  const missingMerge = fixture();
  missingMerge.statuses.statuses = missingMerge.statuses.statuses.filter(
    (status) => status.context !== contract.status_contexts.merge_validation
  );
  await assert.rejects(verify(missingMerge.reader), /lacks a current-head signed success/);
});

test("invalid identity and verification time are rejected", async () => {
  const f = fixture();
  await assert.rejects(
    verify(f.reader, { repository: "../outside/repository" }),
    /identity is invalid/
  );
  await assert.rejects(verify(f.reader, {}, "not-a-time"), /timestamp is invalid/);
});

after(() => {
  if (previousKeyring === undefined) delete process.env.AW_STATUS_KEYRING;
  else process.env.AW_STATUS_KEYRING = previousKeyring;
});
