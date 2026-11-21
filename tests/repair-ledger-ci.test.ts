import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedRepairCiDigest } from "../scripts/repair-ledger-ci.ts";
import {
  applyRepairLedgerEvent,
  createRepairLedgerEntry,
} from "../scripts/repair-lifecycle-ledger.ts";
import { prTitleFingerprint } from "../scripts/pr-title-fingerprint.ts";
import { attestFixtureStatuses } from "./attested-status-fixtures.ts";

const repository = "fongap-labs/action-worker";
const controlRepository = "fongap-labs/action-worker";
const now = "2026-11-21T11:00:00Z";
const head = "d".repeat(40);
const base = "e".repeat(40);
const rootEvidence = "b".repeat(64);
const title = "fix(task): repair current head";
const ciUrl = "https://github.com/fongap-labs/action-worker/actions/runs/42";
const governanceUrl = "https://github.com/fongap-labs/action-worker/actions/runs/43";

function repairDocument() {
  const first = createRepairLedgerEntry(repository, "a".repeat(64), now);
  const diagnosed = applyRepairLedgerEvent(
    first,
    0,
    { kind: "root-cause-verified", evidenceSha256: rootEvidence },
    now
  );
  const repairing = applyRepairLedgerEvent(
    diagnosed,
    1,
    { kind: "repair-created", headSha: head, prNumber: 17 },
    now
  );
  const verifying = applyRepairLedgerEvent(
    repairing,
    2,
    { kind: "ci-started", headSha: head, runId: 42 },
    now
  );
  return {
    schema_version: "1" as const,
    repository,
    issue_number: 77,
    entry: verifying,
  };
}

function fixture() {
  const raw = {
    statuses: [
      {
        id: 101,
        context: "CI Evidence",
        state: "success",
        target_url: ciUrl,
        description: "Central CI passed",
        created_at: "2026-11-21T11:05:00Z",
      },
      ...["PR Governance", "validate-merge"].map((context, index) => ({
        id: 102 + index,
        context,
        state: "success",
        target_url: governanceUrl,
        description: ["title-sha256=", prTitleFingerprint(title), " Central CI gate verdict"].join(""),
        created_at: "2026-11-21T11:05:00Z",
      })),
    ],
  };
  const pr = {
    number: 17,
    title,
    state: "open",
    merged: false,
    head: { sha: head },
    base: { ref: "main", sha: base },
  };
  const run = (id: number, path: string) => ({
    id,
    path,
    repository: { full_name: controlRepository },
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    run_started_at: "2026-11-21T11:02:00Z",
    updated_at: "2026-11-21T11:09:00Z",
  });
  const ciRun = run(42, ".github/workflows/central-ci-dispatch.yml");
  const governanceRun = run(43, ".github/workflows/handle-pr-dispatch.yml");
  return { raw, pr, ciRun, governanceRun };
}

function fixtureReader(options: {
  missingGate?: boolean;
  wrongHead?: boolean;
  changedTitle?: boolean;
  forgedCi?: boolean;
  skippedCi?: boolean;
  failedGovernance?: boolean;
  untrustedRun?: boolean;
  incompleteRun?: boolean;
} = {}) {
  const { raw, pr, ciRun, governanceRun } = fixture();
  if (options.missingGate) raw.statuses.pop();
  if (options.skippedCi) raw.statuses[0]!.description = "CI not run: policy skip";
  if (options.failedGovernance) raw.statuses[1]!.state = "failure";
  const statuses = attestFixtureStatuses(
    raw,
    options.forgedCi ? "different/repository" : repository,
    head
  );
  let pullReads = 0;
  return {
    async get(path: string): Promise<unknown> {
      if (path.endsWith("/pulls/17")) {
        pullReads += 1;
        return {
          ...pr,
          title: options.changedTitle && pullReads > 1 ? "changed PR title" : pr.title,
          head: options.wrongHead ? { sha: "f".repeat(40) } : pr.head,
        };
      }
      if (path.endsWith("/status")) return statuses;
      if (path.endsWith("/runs/42")) {
        return {
          ...ciRun,
          path: options.untrustedRun ? ".github/workflows/untrusted.yml" : ciRun.path,
          status: options.incompleteRun ? "in_progress" : ciRun.status,
          conclusion: options.incompleteRun ? null : ciRun.conclusion,
        };
      }
      if (path.endsWith("/runs/43")) return governanceRun;
      throw new Error("Unexpected GitHub read.");
    },
  };
}

test("only fully signed and successful current PR head evidence produces a digest", async () => {
  const digest = await verifiedRepairCiDigest(fixtureReader(), repairDocument(), controlRepository);
  assert.match(digest, /^[0-9a-f]{64}$/);
});

test("stale, changed or forged PR evidence cannot complete a repair", async () => {
  for (const scenario of [
    { wrongHead: true },
    { changedTitle: true },
    { forgedCi: true },
    { skippedCi: true },
    { failedGovernance: true },
    { missingGate: true },
    { untrustedRun: true },
    { incompleteRun: true },
  ]) {
    await assert.rejects(
      verifiedRepairCiDigest(fixtureReader(scenario), repairDocument(), controlRepository),
      Error,
      JSON.stringify(scenario)
    );
  }
});

test("the pending CI run ID must match the status-linked central run", async () => {
  const original = repairDocument();
  const mismatched = {
    ...original,
    entry: { ...original.entry, ci_run_id: 999 },
  };
  await assert.rejects(
    verifiedRepairCiDigest(fixtureReader(), mismatched, controlRepository),
    /does not match/
  );
});
