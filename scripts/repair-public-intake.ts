import { requireToken } from "./control-token.ts";
import { GithubReader } from "./github-api.ts";
import { admitRepairFinding, type RepairFinding } from "./repair-finding-admission.ts";
import { resolveRepairIssue } from "./repair-issue-binding.ts";
import { createScopedRepairLedgerStore } from "./repair-ledger-store.ts";
import { CliError, isMain } from "./runtime-command.ts";

const CONTROL_REPOSITORY = "fongap-labs/action-worker";
const TRUSTED_WORKFLOW_REF =
  "fongap-labs/action-worker/.github/workflows/repair-public-intake.yml@refs/heads/main";
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const SHA = /^[a-f0-9]{40}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/**
 * Public control-repository pilot only. Do not accept a repository name or a
 * private source identity in a public workflow_dispatch input or public log.
 * This creates a discovered task, NOT a verified root cause or repair approval.
 */
export type PublicRepairIntakeInput = Omit<RepairFinding, "issue_number"> & {
  readonly issue_number: number | null;
};

export function parsePublicRepairIntake(
  env: NodeJS.ProcessEnv,
  now: string
): PublicRepairIntakeInput {
  if (
    env.GITHUB_REPOSITORY !== CONTROL_REPOSITORY ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_WORKFLOW_REF !== TRUSTED_WORKFLOW_REF
  ) {
    throw new CliError("Public repair admission requires its trusted control-main workflow.", 77);
  }
  const issue = env.AW_REPAIR_ISSUE_NUMBER ?? "";
  const run = env.AW_REPAIR_FAILURE_RUN_ID ?? "";
  const headSha = env.AW_REPAIR_FAILURE_HEAD_SHA ?? "";
  const fingerprint = env.AW_REPAIR_ROOT_CAUSE_SHA256 ?? "";
  // Empty or zero selects exact existing-Issue lookup; a positive number
  // keeps the original explicit operator-controlled admission path.
  const issueNumber = issue === "" || issue === "0" ? null : Number(issue);
  const runId = Number(run);
  if (
    (issueNumber !== null &&
      (!POSITIVE_INTEGER.test(issue) || !Number.isSafeInteger(issueNumber))) ||
    !POSITIVE_INTEGER.test(run) ||
    !Number.isSafeInteger(runId) ||
    !SHA.test(headSha) ||
    !FINGERPRINT.test(fingerprint) ||
    !UTC_TIME.test(now) ||
    !Number.isFinite(Date.parse(now))
  ) {
    throw new CliError("Public repair admission requires bounded issue/run/SHA identifiers.", 65);
  }
  return {
    repository: CONTROL_REPOSITORY,
    issue_number: issueNumber,
    failure_run_id: runId,
    failure_head_sha: headSha,
    root_cause_sha256: fingerprint,
    now,
  };
}

async function main(): Promise<void> {
  const finding = parsePublicRepairIntake(process.env, new Date().toISOString());
  const readToken = process.env.AW_REPAIR_READ_TOKEN ?? "";
  if (!readToken) {
    throw new CliError("Public repair admission requires a scoped read token.", 77);
  }
  requireToken("branch");
  const store = createScopedRepairLedgerStore(CONTROL_REPOSITORY);
  const reader = new GithubReader(
    process.env.GITHUB_API_URL ?? "https://api.github.com",
    readToken,
    { attemptLimit: 2 }
  );
  const issueNumber =
    finding.issue_number ??
    (await resolveRepairIssue(
      reader,
      finding.repository,
      finding.failure_run_id,
      finding.failure_head_sha
    ));
  if (issueNumber === null) {
    throw new CliError("No uniquely bound open Issue was found for this failure.", 75);
  }
  const admitted = await admitRepairFinding(
    store,
    reader,
    { ...finding, issue_number: issueNumber },
    null,
    finding.issue_number === null
  );
  console.log(
    JSON.stringify({
      schema_version: "1",
      outcome: admitted.outcome,
      task_id: admitted.task_id,
      stage: admitted.stage,
    })
  );
}

if (isMain(import.meta.url)) {
  main().catch(() => {
    // No raw GitHub API errors, source identifiers or secrets in public logs.
    console.error("::error::Public repair admission failed closed; no success certified.");
    process.exitCode = 1;
  });
}
