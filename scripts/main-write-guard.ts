import {
  controlRepositoryOf,
  hasVerifiedCiEvidence,
  hasVerifiedControlStatus,
  mainWriteGuardWorkflowPaths,
  prGateWorkflowPaths,
  trustedControlRunId,
  type VerificationTrace,
  verificationRecorder,
} from "./ci-evidence.ts";
import {
  GithubReader,
  getJsonArray,
  getJsonNumber,
  getJsonString,
  isJsonRecord,
  type JsonRecord,
  runGithubCli,
} from "./github-api.ts";
import { assertNoOpenMainWriteIncidents } from "./main-write-incidents.ts";
import { validateRepositoryCapability } from "./repository-policy.ts";
import { appendLines, CliError, handleError, isMain, parseJson } from "./runtime-command.ts";

export type MainWriteRequest = {
  schema_version: "1";
  request_id: string;
  repository: string;
  before_sha: string;
  head_sha: string;
  event: "push";
};

export type MainWriteProvenance = {
  repository: string;
  main_sha: string;
  pr_number: number;
  pr_head_sha: string;
};

/**
 * A valid status can be published before its Action Worker run finishes.
 * This is not yet trusted, but it is also not evidence of an untrusted write.
 */
export class MainWriteVerificationPendingError extends CliError {}

export function mainWriteEvidenceError(
  context: "PR Governance" | "CI Evidence" | "validate-merge",
  reason: string
): CliError {
  const message = `::error::Merged PR head has no successful Action Worker ${context} status (${reason}).`;
  return reason === "run-still-running"
    ? new MainWriteVerificationPendingError(message, 75)
    : new CliError(message, 65);
}

const requestPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;

function getControlRepository(): string {
  // The control plane runs this script, so the repository it runs in is the control repository.
  return controlRepositoryOf();
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length && actual.every((item, index) => item === expected[index])
  );
}

export function parseMainWriteRequest(value: unknown): MainWriteRequest {
  if (
    !isJsonRecord(value) ||
    !exactKeys(value, [
      "before_sha",
      "event",
      "head_sha",
      "repository",
      "request_id",
      "schema_version",
    ]) ||
    value.schema_version !== "1" ||
    typeof value.request_id !== "string" ||
    !requestPattern.test(value.request_id) ||
    typeof value.repository !== "string" ||
    !repositoryPattern.test(value.repository) ||
    typeof value.before_sha !== "string" ||
    !shaPattern.test(value.before_sha) ||
    typeof value.head_sha !== "string" ||
    !shaPattern.test(value.head_sha) ||
    value.event !== "push" ||
    value.before_sha === value.head_sha
  ) {
    throw new CliError("::error::Main write request is invalid.", 64);
  }
  return value as MainWriteRequest;
}

function baseRef(value: unknown): string {
  return isJsonRecord(value) ? getJsonString(value.base, "ref") : "";
}

function headSha(value: unknown): string {
  return isJsonRecord(value) ? getJsonString(value.head, "sha") : "";
}

function appSlug(value: unknown): string {
  return isJsonRecord(value) ? getJsonString(value.app, "slug") : "";
}

/**
 * The run id of the workflow that is asking, when it runs inside GitHub Actions.
 */
function currentControlRunId(): number | null {
  const raw = process.env.GITHUB_RUN_ID ?? "";
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

/**
 * A gate status is only a claim: any account that can write commit statuses can name a run
 * that does not exist. The status counts only when the control repository really holds a
 * successful run of the workflow that publishes it, and the status was written while that run
 * was executing.
 *
 * A main write may be attested more than once (intake, central CI, a release, or the deploy
 * that is validating it). Attestations of an immutable main write are cumulative, so the
 * newest VERIFIED one wins: walk them newest first, skip the asking run's own attestation, and
 * accept the first one whose control run already ended successfully. A deploy attests its
 * source immediately before it validates it, so without this its own still-running status
 * would shadow an earlier completed attestation and every automatic deploy after a merge would
 * fail with "has not been attested yet".
 */
export async function hasVerifiedMainWriteGuard(
  reader: GithubReader,
  value: unknown,
  trace: VerificationTrace = () => undefined
): Promise<boolean> {
  const controlRepository = getControlRepository();
  const selfRunId = currentControlRunId();
  const statuses = getJsonArray(value, "statuses")
    .filter(isJsonRecord)
    .filter((item) => getJsonString(item, "context") === "Main Write Guard")
    .filter(
      (item) =>
        selfRunId === null ||
        trustedControlRunId(getJsonString(item, "target_url"), controlRepository) !== selfRunId
    )
    .sort(
      (left, right) =>
        Date.parse(getJsonString(right, "created_at")) -
        Date.parse(getJsonString(left, "created_at"))
    );
  for (const status of statuses) {
    if (
      await hasVerifiedControlStatus(reader, { statuses: [status] }, "Main Write Guard", {
        controlRepository,
        workflowPaths: mainWriteGuardWorkflowPaths,
        // The outer caller (assertTrustedMainWrite) owns the waiting window.
        runAttempts: 1,
        trace,
      })
    ) {
      return true;
    }
  }
  return false;
}

async function requireCentralPrEvidence(
  reader: GithubReader,
  repository: string,
  prHeadSha: string
): Promise<void> {
  const status = await reader.get(`repos/${repository}/commits/${prHeadSha}/status`);
  const controlRepository = getControlRepository();
  const label = `${repository}@${prHeadSha.slice(0, 12)}`;
  const governance = verificationRecorder(`PR Governance ${label}`);
  if (
    !(await hasVerifiedControlStatus(reader, status, "PR Governance", {
      controlRepository,
      workflowPaths: prGateWorkflowPaths,
      trace: governance.trace,
    }))
  ) {
    throw mainWriteEvidenceError("PR Governance", governance.lastFailure());
  }
  const evidence = verificationRecorder(`CI Evidence ${label}`);
  if (
    !(await hasVerifiedCiEvidence(reader, status, { controlRepository, trace: evidence.trace }))
  ) {
    throw mainWriteEvidenceError("CI Evidence", evidence.lastFailure());
  }
  const mergeGate = verificationRecorder(`validate-merge ${label}`);
  if (
    !(await hasVerifiedControlStatus(reader, status, "validate-merge", {
      controlRepository,
      workflowPaths: prGateWorkflowPaths,
      trace: mergeGate.trace,
    }))
  ) {
    throw mainWriteEvidenceError("validate-merge", mergeGate.lastFailure());
  }
}

async function requireLocalMergeCheck(
  reader: GithubReader,
  repository: string,
  prHeadSha: string
): Promise<void> {
  const checks = getJsonArray(
    await reader.get(
      `repos/${repository}/commits/${prHeadSha}/check-runs?filter=latest&per_page=100`
    ),
    "check_runs"
  );
  const mergeGatePassed = checks.some(
    (item) =>
      isJsonRecord(item) &&
      getJsonString(item, "name") === "validate-merge" &&
      getJsonString(item, "status") === "completed" &&
      getJsonString(item, "conclusion") === "success" &&
      appSlug(item) === "github-actions"
  );
  if (!mergeGatePassed) {
    throw new CliError("::error::PR head has no successful local validate-merge check.", 65);
  }
}

/**
 * GitHub may omit a valid squash-merge commit from commits/{sha}/pulls.
 * The final "(#number)" in the signed commit subject is only a lookup hint.
 * The referenced PR must independently prove the exact merge SHA and base branch.
 */
function mergedPrNumberHint(commit: unknown): number | null {
  const details = isJsonRecord(commit) ? commit.commit : undefined;
  const subject = getJsonString(details, "message").split("\n", 1)[0] ?? "";
  const match = /\(#([1-9][0-9]*)\)$/.exec(subject);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) ? number : null;
}

export async function validateMainWriteProvenance(
  reader: GithubReader,
  repository: string,
  mainSha: string,
  isCentralStatusRequired: boolean
): Promise<MainWriteProvenance> {
  if (!repositoryPattern.test(repository) || !shaPattern.test(mainSha)) {
    throw new CliError("::error::Main write provenance input is invalid.", 64);
  }

  const repositoryValue = await reader.get(`repos/${repository}`);
  const defaultBranch = getJsonString(repositoryValue, "default_branch");
  if (defaultBranch !== "main") {
    throw new CliError(
      `::error::Managed repository default branch must be main: ${repository}.`,
      65
    );
  }

  const commit = await reader.get(`repos/${repository}/commits/${mainSha}`);
  if (getJsonString(commit, "sha") !== mainSha) {
    throw new CliError("::error::Main write commit could not be resolved exactly.", 65);
  }

  const associated = getJsonArray(
    await reader.get(`repos/${repository}/commits/${mainSha}/pulls?per_page=100`)
  );
  const isExactMerge = (value: unknown): boolean =>
    isJsonRecord(value) &&
    getJsonString(value, "merged_at") !== "" &&
    getJsonString(value, "merge_commit_sha") === mainSha &&
    baseRef(value) === "main" &&
    getJsonNumber(value, "number") > 0;
  const candidates = associated.filter(isExactMerge);

  // The reverse association API sometimes omits freshly merged squash commits.
  // Never infer trust from the commit subject alone: verify the claimed PR via
  // its own endpoint and require an exact, immutable merge SHA match.
  let fallbackPr: unknown;
  if (associated.length === 0 && candidates.length === 0) {
    const hint = mergedPrNumberHint(commit);
    if (hint !== null) {
      fallbackPr = await reader.get(`repos/${repository}/pulls/${hint}`);
      if (isExactMerge(fallbackPr) && getJsonNumber(fallbackPr, "number") === hint) {
        candidates.push(fallbackPr);
      }
    }
  }

  if (candidates.length !== 1) {
    throw new CliError(
      `::error::Main SHA is not uniquely attributable to a merged pull request: ${repository}@${mainSha}.`,
      65
    );
  }

  const prNumber = getJsonNumber(candidates[0], "number");
  const pr = fallbackPr ?? (await reader.get(`repos/${repository}/pulls/${prNumber}`));
  const prHeadSha = headSha(pr);
  if (
    getJsonString(pr, "merged_at") === "" ||
    getJsonString(pr, "merge_commit_sha") !== mainSha ||
    baseRef(pr) !== "main" ||
    !shaPattern.test(prHeadSha)
  ) {
    throw new CliError("::error::Merged pull request facts do not match the main write.", 65);
  }

  if (isCentralStatusRequired) {
    await requireCentralPrEvidence(reader, repository, prHeadSha);
  } else {
    await requireLocalMergeCheck(reader, repository, prHeadSha);
  }

  return {
    repository,
    main_sha: mainSha,
    pr_number: prNumber,
    pr_head_sha: prHeadSha,
  };
}

export async function assertTrustedMainWrite(
  reader: GithubReader,
  repository: string,
  mainSha: string,
  isCentralStatusRequired = true,
  bypassIncidents = false
): Promise<MainWriteProvenance> {
  const provenance = await validateMainWriteProvenance(
    reader,
    repository,
    mainSha,
    isCentralStatusRequired
  );
  if (!bypassIncidents) {
    await assertNoOpenMainWriteIncidents(reader, repository);
  } else {
    console.log(
      `::warning::Main Write Guard bypassed the incident check for ${repository}@${mainSha.slice(0, 12)}. The write provenance is still verified.`
    );
  }
  const label = `Main Write Guard ${repository}@${mainSha.slice(0, 12)}`;
  const guard = verificationRecorder(label);
  let observed: JsonRecord[] = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    // The combined status endpoint keeps only the newest status per context, so a deploy's own
    // attestation would hide every earlier one. The full list keeps them all.
    const status = {
      statuses: getJsonArray(
        await reader.get(`repos/${repository}/statuses/${mainSha}?per_page=100`)
      ),
    };
    if (await hasVerifiedMainWriteGuard(reader, status, guard.trace)) {
      return provenance;
    }
    observed = getJsonArray(status, "statuses")
      .filter(isJsonRecord)
      .filter((item) => getJsonString(item, "context") === "Main Write Guard");
    const guardStates = observed.map((item) => getJsonString(item, "state"));
    if (guardStates.includes("failure") || guardStates.includes("error")) {
      throw new CliError(
        `::error::Source SHA failed Main Write Guard: ${repository}@${mainSha.slice(0, 12)} did not come from a merged pull request with passing Action Worker checks, so it is not trusted. Change main only by merging a pull request that passed validate-merge; the next such merge makes main trusted again.`,
        65
      );
    }
    if (attempt + 1 < 12) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  console.log(
    `verification ${label} observed ${JSON.stringify(
      observed.map((item) => ({
        state: getJsonString(item, "state"),
        target_url: getJsonString(item, "target_url"),
        created_at: getJsonString(item, "created_at"),
      }))
    )}`
  );
  throw new CliError(
    `::error::Source SHA has no successful Main Write Guard status: ${repository}@${mainSha.slice(0, 12)} has not been attested yet. Intake attests every managed main automatically within minutes; start this workflow again in a few minutes. If it repeats, the Main write audit job of the latest Intake run says why. Last check: ${guard.lastFailure()}.`,
    65
  );
}

function requestFromEnvironment(): MainWriteRequest {
  return parseMainWriteRequest({
    schema_version: "1",
    request_id: process.env.MAIN_WRITE_REQUEST_ID ?? "",
    repository: process.env.MAIN_WRITE_REPOSITORY ?? "",
    before_sha: process.env.MAIN_WRITE_BEFORE_SHA ?? "",
    head_sha: process.env.MAIN_WRITE_HEAD_SHA ?? "",
    event: process.env.MAIN_WRITE_EVENT ?? "",
  });
}

async function publishStatus(
  request: MainWriteRequest,
  token: string,
  state: "success" | "failure",
  description: string
): Promise<void> {
  const runUrl = process.env.MAIN_WRITE_RUN_URL ?? "";
  const args = [
    "api",
    "--method",
    "POST",
    `repos/${request.repository}/statuses/${request.head_sha}`,
    "-f",
    `state=${state}`,
    "-f",
    "context=Main Write Guard",
    "-f",
    `description=${description}`,
  ];
  if (runUrl) {
    args.push("-f", `target_url=${runUrl}`);
  }
  await runGithubCli(args, token);
}

async function main(): Promise<void> {
  const request = requestFromEnvironment();
  const token = process.env.MAIN_WRITE_TOKEN ?? "";
  if (!token) {
    throw new CliError("::error::MAIN_WRITE_TOKEN is required.", 77);
  }

  if (process.env.MAIN_WRITE_REQUIRE_POLICY !== "false") {
    const rawPolicy = process.env.AW_REPOSITORY_POLICY ?? "";
    if (!rawPolicy) {
      throw new CliError("::error::AW_REPOSITORY_POLICY is required.", 65);
    }
    validateRepositoryCapability(
      request.repository,
      parseJson(rawPolicy, "::error::AW_REPOSITORY_POLICY must be valid JSON.", 65),
      "pr"
    );
  }

  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
  try {
    const provenance = await validateMainWriteProvenance(
      reader,
      request.repository,
      request.head_sha,
      process.env.MAIN_WRITE_REQUIRE_CENTRAL_STATUSES !== "false"
    );
    await publishStatus(
      request,
      token,
      "success",
      `Trusted main write via PR #${provenance.pr_number}`
    );
    await appendLines(process.env.GITHUB_OUTPUT, [
      `repository=${provenance.repository}`,
      `main_sha=${provenance.main_sha}`,
      `pr_number=${provenance.pr_number}`,
      `pr_head_sha=${provenance.pr_head_sha}`,
    ]);
    await appendLines(process.env.GITHUB_STEP_SUMMARY, [
      "## Main Write Guard",
      "",
      `- Repository: ${provenance.repository}`,
      `- Main SHA: ${provenance.main_sha}`,
      `- Pull request: #${provenance.pr_number}`,
      `- PR head SHA: ${provenance.pr_head_sha}`,
      `- merge authority: ${process.env.MAIN_WRITE_REQUIRE_CENTRAL_STATUSES !== "false" ? "Action Worker validate-merge status" : "local validate-merge check"}`,
      "- Main Write Guard: success",
    ]);
  } catch (error) {
    try {
      await publishStatus(request, token, "failure", "Untrusted main write");
    } catch {
      // Preserve the provenance validation error as authoritative.
    }
    throw error;
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
