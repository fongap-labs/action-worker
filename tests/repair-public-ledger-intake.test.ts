import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parsePublicRepairIntake } from "../scripts/repair-public-ledger-intake.ts";

const timestamp = "2026-11-22T00:00:00.000Z";
const root = "a".repeat(64);
const head = "b".repeat(40);

function trustedEnv(): NodeJS.ProcessEnv {
  return {
    GITHUB_REPOSITORY: "fongap-labs/action-worker",
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_REF:
      "fongap-labs/action-worker/.github/workflows/repair-public-ledger-intake.yml@refs/heads/main",
    AW_REPAIR_ISSUE_NUMBER: "17",
    AW_REPAIR_FAILURE_RUN_ID: "42",
    AW_REPAIR_FAILURE_HEAD_SHA: head,
    AW_REPAIR_ROOT_CAUSE_SHA256: root,
  };
}

test("admission pilot binds the operator inputs to the public control repository", () => {
  const finding = parsePublicRepairIntake(trustedEnv(), timestamp);
  assert.deepEqual(finding, {
    repository: "fongap-labs/action-worker",
    issue_number: 17,
    failure_run_id: 42,
    failure_head_sha: head,
    root_cause_sha256: root,
    now: timestamp,
  });
  assert.equal("root_cause_evidence_sha256" in finding, false);
});

test("admission pilot rejects other events, repos, branches and workflow callers", () => {
  const cases: Array<[keyof NodeJS.ProcessEnv, string]> = [
    ["GITHUB_REPOSITORY", "fongap-labs/private-repo"],
    ["GITHUB_REF", "refs/heads/feature"],
    ["GITHUB_EVENT_NAME", "repository_dispatch"],
    ["GITHUB_WORKFLOW_REF", "fongap-labs/action-worker/.github/workflows/other.yml@refs/heads/main"],
  ];
  for (const [key, value] of cases) {
    const env = trustedEnv();
    env[key] = value;
    assert.throws(() => parsePublicRepairIntake(env, timestamp), /trusted control-main workflow/);
  }
});

test("admission requires bounded numeric IDs, validated SHA and UTC time", () => {
  const cases = [
    ["AW_REPAIR_ISSUE_NUMBER", "0"],
    ["AW_REPAIR_ISSUE_NUMBER", "9007199254740992"],
    ["AW_REPAIR_ISSUE_NUMBER", "17; echo unsafe"],
    ["AW_REPAIR_FAILURE_RUN_ID", "-4"],
    ["AW_REPAIR_FAILURE_RUN_ID", "5.0"],
    ["AW_REPAIR_FAILURE_HEAD_SHA", "not-a-commit"],
    ["AW_REPAIR_ROOT_CAUSE_SHA256", "raw error message"],
  ] as const;
  for (const [key, value] of cases) {
    const env = trustedEnv();
    env[key] = value;
    assert.throws(() => parsePublicRepairIntake(env, timestamp), /bounded issue\/run\/SHA/);
  }
  assert.throws(() => parsePublicRepairIntake(trustedEnv(), "yesterday"), /bounded issue\/run\/SHA/);
});

test("workflow never accepts arbitrary repositories or exposes private inputs", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/repair-public-ledger-intake.yml", import.meta.url),
    "utf8"
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permission-contents: write/);
  assert.match(workflow, /repositories: \$\{\{ github\.event\.repository\.name \}\}/);
  assert.match(workflow, /github\.repository == 'fongap-labs\/action-worker'/);
  assert.doesNotMatch(workflow, /AW_REPAIR_SOURCE_REPOSITORY:|\bsource_repository:/);
  assert.doesNotMatch(workflow, /pull_request_target:|permissions:\s*write-all/);
});
