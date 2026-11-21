import assert from "node:assert/strict";
import { test } from "node:test";
import { prTitleFingerprint } from "../scripts/pr-title-fingerprint.ts";
import { RepairLedgerStore } from "../scripts/repair-ledger-store.ts";
import {
  applyRepairLedgerEvent,
  createRepairLedgerEntry,
} from "../scripts/repair-lifecycle-ledger.ts";
import { verifiedRepairPostMergeDigest } from "../scripts/repair-main-ci.ts";
import { attestFixtureStatuses } from "./attested-status-fixtures.ts";

const repository = "fongap-labs/target";
const controlRepository = "fongap-labs/action-worker";
const now = "2026-11-21T11:00:00Z";
const head = "d".repeat(40);
const base = "e".repeat(40);
const merge = "f".repeat(40);
const title = "fix(task): verified post-merge repair";
const rootEvidence = "b".repeat(64);

function document(source = repository) {
  const found = createRepairLedgerEntry(source, "a".repeat(64), now);
  const diagnosed = applyRepairLedgerEvent(
    found,
    0,
    { kind: "root-cause-verified", evidenceSha256: rootEvidence },
    now
  );
  const repairing = applyRepairLedgerEvent(
    diagnosed,
    1,
    { kind: "repair-created", headSha: head, baseSha: base, prNumber: 17 },
    now
  );
  const verifying = applyRepairLedgerEvent(
    repairing,
    2,
    { kind: "ci-started", headSha: head, baseSha: base, runId: 42 },
    now
  );
  return {
    schema_version: "1" as const,
    repository: source,
    issue_number: 77,
    entry: verifying,
  };
}

function status(id: number, context: string, url: string, description: string, state = "success") {
  return {
    id,
    context,
    target_url: url,
    description,
    state,
    created_at: "2026-11-21T11:05:00Z",
  };
}

type Scenario = {
  merged?: boolean;
  staleHead?: boolean;
  wrongMerge?: boolean;
  changedPr?: boolean;
  staleMain?: boolean;
  movedMain?: boolean;
  skipMainCi?: boolean;
  missingMainCi?: boolean;
  failedMainCi?: boolean;
  forgedMainCi?: boolean;
  badCiWorkflow?: boolean;
  missingGuard?: boolean;
  failedGuard?: boolean;
  remediatedGuard?: boolean;
  badGuardWorkflow?: boolean;
  differentPrRun?: boolean;
  localControl?: boolean;
  invalidLocalCi?: boolean;
};

function reader(options: Scenario = {}) {
  const source = options.localControl ? controlRepository : repository;
  const statusesForPr = attestFixtureStatuses(
    {
      statuses: [
        status(
          101,
          "CI Evidence",
          "https://github.com/fongap-labs/action-worker/actions/runs/42",
          "Central CI passed"
        ),
        status(
          102,
          "PR Governance",
          "https://github.com/fongap-labs/action-worker/actions/runs/43",
          ["title-sha256=", prTitleFingerprint(title), " approved"].join("")
        ),
        status(
          103,
          "validate-merge",
          "https://github.com/fongap-labs/action-worker/actions/runs/43",
          ["title-sha256=", prTitleFingerprint(title), " approved"].join("")
        ),
      ],
    },
    source,
    head
  );
  const mainCi = status(
    201,
    "CI Evidence",
    "https://github.com/fongap-labs/action-worker/actions/runs/44",
    options.skipMainCi ? "CI not run: policy skip" : "Central CI passed",
    options.failedMainCi ? "failure" : "success"
  );
  const guard = status(
    202,
    "Main Write Guard",
    "https://github.com/fongap-labs/action-worker/actions/runs/45",
    options.remediatedGuard ? "Post-merge CI remediation: display updated" : "Main write verified",
    options.failedGuard ? "failure" : "success"
  );
  const main = attestFixtureStatuses(
    {
      statuses: [
        ...(!options.localControl && !options.missingMainCi ? [mainCi] : []),
        ...(!options.missingGuard ? [guard] : []),
      ],
    },
    options.forgedMainCi ? "different/repository" : source,
    merge
  );
  const mergedPr = {
    number: 17,
    title,
    state: options.merged === false ? "open" : "closed",
    merged: options.merged !== false,
    merged_at: options.merged === false ? null : "2026-11-21T11:01:00Z",
    merge_commit_sha: options.wrongMerge ? "9".repeat(40) : merge,
    head: { sha: options.staleHead ? "8".repeat(40) : head },
    base: { ref: "main", sha: base },
  };
  const runs = new Map([
    [42, ".github/workflows/central-ci-dispatch.yml"],
    [43, ".github/workflows/handle-pr-dispatch.yml"],
    [44, ".github/workflows/central-ci-dispatch.yml"],
    [45, ".github/workflows/main-write-guard.yml"],
    [
      46,
      options.invalidLocalCi ? ".github/workflows/untrusted.yml" : ".github/workflows/intake.yml",
    ],
  ]);
  let prReads = 0;
  let branchReads = 0;
  return {
    async get(path: string): Promise<unknown> {
      if (path === ["repos", source].join("/")) {
        return { full_name: source, default_branch: "main" };
      }
      if (path === ["repos", source, "pulls/17"].join("/")) {
        prReads += 1;
        return {
          ...mergedPr,
          title: options.changedPr && prReads > 1 ? "changed PR title" : title,
        };
      }
      if (path === ["repos", source, "branches/main"].join("/")) {
        branchReads += 1;
        return {
          commit: {
            sha:
              options.staleMain || (options.movedMain && branchReads > 1) ? "7".repeat(40) : merge,
          },
        };
      }
      if (path === ["repos", source, "commits", head, "status"].join("/")) {
        return options.differentPrRun ? { statuses: [] } : statusesForPr;
      }
      if (path === ["repos", source, "commits", merge, "status"].join("/")) {
        return main;
      }
      if (path.endsWith("check-runs?filter=latest&per_page=100")) {
        return {
          check_runs: [
            {
              id: 301,
              name: "Main CI",
              head_sha: merge,
              status: "completed",
              conclusion: "success",
              details_url: "https://github.com/fongap-labs/action-worker/actions/runs/46/job/999",
              app: { slug: "github-actions" },
            },
          ],
        };
      }
      const match = /\/actions\/runs\/([0-9]+)$/.exec(path);
      if (match) {
        const runId = Number(match[1]);
        const workflow = runs.get(runId);
        if (!workflow) throw new Error("Unexpected CI run identifier.");
        return {
          id: runId,
          path:
            options.badCiWorkflow && runId === 44
              ? ".github/workflows/untrusted.yml"
              : options.badGuardWorkflow && runId === 45
                ? ".github/workflows/untrusted.yml"
                : workflow,
          repository: { full_name: controlRepository },
          head_sha: options.localControl && runId === 46 ? merge : "5".repeat(40),
          head_branch: "main",
          event: "push",
          status: "completed",
          conclusion: "success",
          run_started_at: "2026-11-21T11:02:00Z",
          updated_at: "2026-11-21T11:09:00Z",
        };
      }
      throw new Error("Unexpected GitHub read.");
    },
  };
}

test("post-merge completion binds exact main SHA, trusted CI and signed main guard", async () => {
  const digest = await verifiedRepairPostMergeDigest(reader(), document(), controlRepository);
  assert.match(digest, /^[0-9a-f]{64}$/);
});

test("unmerged, changed and stale commits fail before completion", async () => {
  for (const options of [
    { merged: false },
    { staleHead: true },
    { wrongMerge: true },
    { changedPr: true },
    { staleMain: true },
    { movedMain: true },
  ]) {
    await assert.rejects(
      verifiedRepairPostMergeDigest(reader(options), document(), controlRepository),
      Error,
      JSON.stringify(options)
    );
  }
});

test("missing, skipped, failing or forged main CI never completes a repair", async () => {
  for (const options of [
    { skipMainCi: true },
    { missingMainCi: true },
    { failedMainCi: true },
    { forgedMainCi: true },
    { badCiWorkflow: true },
  ]) {
    await assert.rejects(
      verifiedRepairPostMergeDigest(reader(options), document(), controlRepository),
      Error,
      JSON.stringify(options)
    );
  }
});

test("missing, failed, remediated and untrusted main guards never complete repairs", async () => {
  for (const options of [
    { missingGuard: true },
    { failedGuard: true },
    { remediatedGuard: true },
    { badGuardWorkflow: true },
  ]) {
    await assert.rejects(
      verifiedRepairPostMergeDigest(reader(options), document(), controlRepository),
      Error,
      JSON.stringify(options)
    );
  }
});

test("the control repository can prove main CI with its actual completed intake job", async () => {
  const digest = await verifiedRepairPostMergeDigest(
    reader({ localControl: true }),
    document(controlRepository),
    controlRepository
  );
  assert.match(digest, /^[0-9a-f]{64}$/);
  await assert.rejects(
    verifiedRepairPostMergeDigest(
      reader({ localControl: true, invalidLocalCi: true }),
      document(controlRepository),
      controlRepository
    ),
    /main CI is missing/
  );
});

test("the ledger completion entry point rejects a green but unmerged PR", async () => {
  const store = new RepairLedgerStore({
    async getRef() {
      throw new Error("The verifier must fail before any ledger write.");
    },
    async getCommitTree() {
      throw new Error("The verifier must fail before any ledger write.");
    },
    async getFile() {
      throw new Error("The verifier must fail before any ledger write.");
    },
    async createTree() {
      throw new Error("The verifier must fail before any ledger write.");
    },
    async createCommit() {
      throw new Error("The verifier must fail before any ledger write.");
    },
    async createRef() {
      throw new Error("The verifier must fail before any ledger write.");
    },
    async updateRef() {
      throw new Error("The verifier must fail before any ledger write.");
    },
  });
  await assert.rejects(
    store.completeWithVerifiedCi(
      {
        document: document(),
        commit_sha: "1".repeat(40),
        tree_sha: "2".repeat(40),
        is_private: false,
      },
      reader({ merged: false }),
      controlRepository,
      now,
      null
    ),
    /must be merged/
  );
});
