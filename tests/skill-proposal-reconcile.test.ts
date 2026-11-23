import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import type { GithubReader } from "../scripts/github-api.ts";
import { hasVerifiedMainWriteGuard } from "../scripts/main-write-guard.ts";
import { prTitleFingerprint } from "../scripts/pr-title-fingerprint.ts";
import { makeOwnerBoundSkillTransport } from "../scripts/skill-proposal-advance.ts";
import {
  parseSkillAdmissionPolicy,
  pinnedSkillProposalIdentity,
  type SkillAdmissionTarget,
  verifyMergedSkillProposal,
} from "../scripts/skill-proposal-reconcile.ts";
import { signedStatusDescription } from "../scripts/status-attestation.ts";

const priorKeyring = process.env.AW_STATUS_KEYRING;
process.env.AW_STATUS_KEYRING = JSON.stringify({
  schema_version: 1,
  active: "k1",
  keys: { k1: Buffer.alloc(32, 5).toString("base64url") },
  legacy_tokens: [],
});
after(() => {
  if (priorKeyring === undefined) delete process.env.AW_STATUS_KEYRING;
  else process.env.AW_STATUS_KEYRING = priorKeyring;
});

const target: SkillAdmissionTarget = {
  repository: "fongap-labs/plugins",
  proposal_prefix: "packages/delta-code/skill-proposals/",
  catalog_path: "packages/delta-code/src/delta-code-strategy/trusted-github-skills.ts",
  enabled: true,
  max_closed_prs: 40,
};
const head = "a".repeat(40);
const base = "b".repeat(40);
const merge = "c".repeat(40);
const source = {
  repository: "example/skills",
  path: "skills/review-tool/SKILL.md",
  commit: "d".repeat(40),
  sourceBlobSha: "e".repeat(40),
  licenseBlobSha: "f".repeat(40),
  license: "MIT",
};
const identity = pinnedSkillProposalIdentity(source);
const proposalPath = target.proposal_prefix + "review-tool-" + identity + ".json";
const title = "chore(delta-code): stage verified free Skill proposal";
const governanceUrl = "https://github.com/fongap-labs/action-worker/actions/runs/410";
const ciUrl = "https://github.com/fongap-labs/action-worker/actions/runs/411";
const manifest = {
  schemaVersion: 1,
  state: "pending-ci-review",
  source,
  staticAudit: { status: "static-review-ready", riskIndicators: [], freeUseEvidence: true },
  approvalRequired: true,
  autoEnabled: false,
  executable: false,
};
const pull = {
  state: "closed",
  merged: true,
  merged_at: "2026-11-20T12:00:00Z",
  merge_commit_sha: merge,
  number: 88,
  title,
  head: {
    sha: head,
    ref: "chore/skill-proposal-" + identity,
    repo: { full_name: target.repository },
  },
  base: { sha: base, ref: "main", repo: { full_name: target.repository } },
};
const files = [
  { filename: proposalPath, status: "added" },
  { filename: "CHANGELOG.md", status: "modified" },
];

function signed(
  context: string,
  sha: string,
  url: string,
  state: "success" | "pending" | "failure" = "success"
) {
  const description =
    context === "CI Evidence" || context === "Main Write Guard"
      ? "Central CI gate verdict"
      : "title-sha256=" + prTitleFingerprint(title) + " Central CI gate verdict";
  return {
    context,
    state,
    target_url: url,
    created_at: "2026-11-20T11:00:00Z",
    description: signedStatusDescription({
      repository: target.repository,
      sha,
      context,
      state,
      targetUrl: url,
      description,
    }),
  };
}

function signedStatuses() {
  return {
    statuses: [
      signed("PR Governance", head, governanceUrl),
      signed("CI Evidence", head, ciUrl),
      signed("validate-merge", head, governanceUrl),
    ],
  };
}

function signedMainGuard() {
  return { statuses: [signed("Main Write Guard", merge, ciUrl)] };
}

function evaluate(
  pr: unknown = pull,
  statuses: unknown = signedStatuses(),
  changed: unknown = files,
  record: unknown = manifest,
  guard: unknown = signedMainGuard()
) {
  return verifyMergedSkillProposal(
    pr,
    statuses,
    changed,
    record,
    target,
    guard,
    "fongap-labs/action-worker"
  );
}

test("policy only enables bounded, explicitly reviewed repositories", () => {
  assert.deepEqual(
    parseSkillAdmissionPolicy({
      schema_version: 1,
      targets: [target],
    }),
    [target]
  );
  for (const value of [
    {},
    { schema_version: 2, targets: [target] },
    { schema_version: 1, targets: [] },
    { schema_version: 1, targets: [target, target] },
    { schema_version: 1, targets: [{ ...target, repository: "other/../repo" }] },
    { schema_version: 1, targets: [{ ...target, max_closed_prs: 101 }] },
    { schema_version: 1, targets: [{ ...target, extraPermission: true }] },
  ]) {
    assert.throws(() => parseSkillAdmissionPolicy(value), /Invalid/);
  }
});

test("signed, exactly scoped free proposal is an inert eligible promotion candidate", () => {
  const candidate = evaluate();
  assert.equal(candidate?.targetRepository, target.repository);
  assert.equal(candidate?.expectedProposalHead, head);
  assert.equal(candidate?.mergeCommit, merge);
  assert.equal(candidate?.proposalPath, proposalPath);
  assert.equal(candidate?.identity, identity);
  assert.deepEqual(candidate?.source, {
    repository: source.repository,
    path: source.path,
    commit: source.commit,
    sourceBlobSha: source.sourceBlobSha,
    licenseBlobSha: source.licenseBlobSha,
  });
});

test("unrelated PR never becomes a candidate", () => {
  assert.equal(evaluate({ ...pull, title: "feat(other): unrelated change" }), null);
});

test("forged or incomplete merge and CI evidence is rejected", () => {
  for (const invalid of [
    { ...pull, state: "open", merged: false },
    { ...pull, head: { ...pull.head, sha: "0".repeat(40) } },
    { ...pull, head: { ...pull.head, ref: "chore/unrelated" } },
    { ...pull, head: { ...pull.head, repo: { full_name: "attacker/repo" } } },
    { ...pull, base: { ...pull.base, ref: "legacy" } },
    { ...pull, merge_commit_sha: "main" },
  ]) {
    assert.throws(() => evaluate(invalid));
  }
  const unsigned = signedStatuses();
  unsigned.statuses[0] = { ...unsigned.statuses[0]!, description: "unsigned" };
  assert.throws(() => evaluate(pull, unsigned), /signed/);
  const pending = signedStatuses();
  pending.statuses[1] = signed("CI Evidence", head, ciUrl, "pending");
  assert.throws(() => evaluate(pull, pending), /signed/);
  const failedGuard = { statuses: [signed("Main Write Guard", merge, ciUrl, "failure")] };
  assert.throws(
    () => evaluate(pull, signedStatuses(), files, manifest, failedGuard),
    /Main Write Guard/
  );
});

test("unexpected changed code, fee evidence, revocation or source mutation blocks promotion", () => {
  assert.throws(
    () =>
      evaluate(pull, signedStatuses(), [
        ...files,
        { filename: "src/execution.ts", status: "modified" },
      ]),
    /exactly/
  );
  assert.throws(
    () =>
      evaluate(pull, signedStatuses(), [{ filename: proposalPath, status: "modified" }, files[1]]),
    /unexpected code/
  );
  for (const invalid of [
    { ...manifest, approvalRequired: false },
    { ...manifest, autoEnabled: true },
    { ...manifest, executable: true },
    { ...manifest, state: "approved" },
    { ...manifest, source: { ...source, license: "Paid-Pro" } },
    { ...manifest, source: { ...source, commit: "main" } },
    { ...manifest, source: { ...source, sourceBlobSha: "0".repeat(40) } },
    { ...manifest, staticAudit: { ...manifest.staticAudit, riskIndicators: ["network"] } },
    { ...manifest, staticAudit: { ...manifest.staticAudit, freeUseEvidence: false } },
    { ...manifest, unexpectedData: "do not execute" },
  ]) {
    assert.throws(() => evaluate(pull, signedStatuses(), files, invalid));
  }
});

test("signed post-merge remediation never becomes a trusted source for Skill activation", async () => {
  const context = "Main Write Guard";
  const remedial = {
    ...signed(context, merge, ciUrl),
    description: signedStatusDescription({
      repository: target.repository,
      sha: merge,
      context,
      state: "success",
      targetUrl: ciUrl,
      description: "Post-merge CI remediation - display-only historical reconciliation",
    }),
  };
  const reader = {
    get: async () => {
      throw new Error("Remediation receipts must be excluded before resolving publisher runs");
    },
  } as unknown as GithubReader;
  assert.equal(
    await hasVerifiedMainWriteGuard(reader, { statuses: [remedial] }, target.repository, merge),
    false
  );
});

test("owner-bound transport rejects other repositories, wrong account and unsigned endpoints", async () => {
  class ApiError extends Error {
    constructor(_status: number, _repository: string, _method: string) {
      super("API failure");
    }
  }
  const transport = makeOwnerBoundSkillTransport(
    target.repository,
    "fongap-labs",
    "read-token",
    "write-token",
    ApiError
  );
  const signal = new AbortController().signal;
  await assert.rejects(
    () =>
      transport.request({
        repository: "attacker/repo",
        account: "fongap-labs",
        path: "/repos/attacker/repo",
        method: "GET",
        signal,
      }),
    /Owner-bound/
  );
  await assert.rejects(
    () =>
      transport.request({
        repository: target.repository,
        account: "attacker",
        path: "/repos/" + target.repository,
        method: "GET",
        signal,
      }),
    /Owner-bound/
  );
  await assert.rejects(
    () =>
      transport.request({
        repository: target.repository,
        account: "fongap-labs",
        path: "/repos/" + target.repository + "/../attacker",
        method: "GET",
        signal,
      }),
    /unsafe/
  );
  await assert.rejects(
    () => transport.publicRead("https://attacker.example/skills", signal),
    /immutable anonymous/
  );
  assert.throws(
    () =>
      makeOwnerBoundSkillTransport(
        target.repository,
        "fongap-labs",
        "same-token",
        "same-token",
        ApiError
      ),
    /independent/
  );
});

test("Skill promotion reads the renamed Delta Code compiled entrypoints", () => {
  const source = readFileSync(
    new URL("../scripts/skill-proposal-advance.ts", import.meta.url),
    "utf8"
  );
  assert.ok(source.includes("packages/delta-code/lib/delta-code-repository/github-operations.js"));
  assert.ok(source.includes("packages/delta-code/lib/delta-code-adapter/contracts/github.js"));
  assert.ok(!source.includes("packages/dsh-delta-code/"));
});

test("central Skill admission policy matches renamed plugins source paths", () => {
  const policy = JSON.parse(
    readFileSync(new URL("../policies/skill-admission.json", import.meta.url), "utf8")
  ) as unknown;
  assert.deepEqual(parseSkillAdmissionPolicy(policy), [target]);
  assert.equal(target.repository, "fongap-labs/plugins");
  assert.ok(!JSON.stringify(policy).includes("dsh-delta-code"));
});
