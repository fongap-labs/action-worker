import {
  GithubReader,
  getJsonArray,
  getJsonNumber,
  getJsonString,
  isJsonRecord,
  runGithubCli,
} from "./github-api.ts";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
  parseJson,
} from "./runtime-command.ts";
import { validateRepositoryCapability } from "./repository-policy.ts";

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

const requestPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;
const controlRunPrefix = "https://github.com/fongap-labs/action-worker/actions/runs/";

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

export function parseMainWriteRequest(value: unknown): MainWriteRequest {
  if (
    !isJsonRecord(value)
    || !exactKeys(value, ["before_sha", "event", "head_sha", "repository", "request_id", "schema_version"])
    || value.schema_version !== "1"
    || typeof value.request_id !== "string" || !requestPattern.test(value.request_id)
    || typeof value.repository !== "string" || !repositoryPattern.test(value.repository)
    || typeof value.before_sha !== "string" || !shaPattern.test(value.before_sha)
    || typeof value.head_sha !== "string" || !shaPattern.test(value.head_sha)
    || value.event !== "push"
    || value.before_sha === value.head_sha
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

function successfulStatus(value: unknown, context: string): boolean {
  return getJsonArray(value, "statuses").some((item) => (
    isJsonRecord(item)
    && getJsonString(item, "context") === context
    && getJsonString(item, "state") === "success"
    && getJsonString(item, "target_url").startsWith(controlRunPrefix)
  ));
}

export function hasTrustedMainWriteGuard(value: unknown): boolean {
  return successfulStatus(value, "Main Write Guard");
}

async function requireCentralPrEvidence(
  reader: GithubReader,
  repository: string,
  prHeadSha: string,
): Promise<void> {
  const status = await reader.get(`repos/${repository}/commits/${prHeadSha}/status`);
  if (!successfulStatus(status, "PR Governance")) {
    throw new CliError("::error::Merged PR head has no successful Action Worker PR Governance status.", 65);
  }
  if (!successfulStatus(status, "CI Evidence")) {
    throw new CliError("::error::Merged PR head has no successful Action Worker CI Evidence status.", 65);
  }
}

export async function validateMainWriteProvenance(
  reader: GithubReader,
  repository: string,
  mainSha: string,
  requireCentralStatuses: boolean,
): Promise<MainWriteProvenance> {
  if (!repositoryPattern.test(repository) || !shaPattern.test(mainSha)) {
    throw new CliError("::error::Main write provenance input is invalid.", 64);
  }

  const repositoryValue = await reader.get(`repos/${repository}`);
  const defaultBranch = getJsonString(repositoryValue, "default_branch");
  if (defaultBranch !== "main") {
    throw new CliError(`::error::Managed repository default branch must be main: ${repository}.`, 65);
  }

  const commit = await reader.get(`repos/${repository}/commits/${mainSha}`);
  if (getJsonString(commit, "sha") !== mainSha) {
    throw new CliError("::error::Main write commit could not be resolved exactly.", 65);
  }

  const associated = getJsonArray(await reader.get(
    `repos/${repository}/commits/${mainSha}/pulls?per_page=100`,
  ));
  const candidates = associated.filter((item) => (
    isJsonRecord(item)
    && getJsonString(item, "merged_at") !== ""
    && getJsonString(item, "merge_commit_sha") === mainSha
    && baseRef(item) === "main"
    && getJsonNumber(item, "number") > 0
  ));
  if (candidates.length !== 1) {
    throw new CliError(
      `::error::Main SHA is not uniquely attributable to a merged pull request: ${repository}@${mainSha}.`,
      65,
    );
  }

  const prNumber = getJsonNumber(candidates[0], "number");
  const pr = await reader.get(`repos/${repository}/pulls/${prNumber}`);
  const prHeadSha = headSha(pr);
  if (
    getJsonString(pr, "merged_at") === ""
    || getJsonString(pr, "merge_commit_sha") !== mainSha
    || baseRef(pr) !== "main"
    || !shaPattern.test(prHeadSha)
  ) {
    throw new CliError("::error::Merged pull request facts do not match the main write.", 65);
  }

  const checks = getJsonArray(
    await reader.get(`repos/${repository}/commits/${prHeadSha}/check-runs?filter=latest&per_page=100`),
    "check_runs",
  );
  const mergeGatePassed = checks.some((item) => (
    isJsonRecord(item)
    && getJsonString(item, "name") === "validate-merge"
    && getJsonString(item, "status") === "completed"
    && getJsonString(item, "conclusion") === "success"
    && appSlug(item) === "github-actions"
  ));
  if (!mergeGatePassed) {
    throw new CliError("::error::Merged PR head has no successful validate-merge check.", 65);
  }

  if (requireCentralStatuses) {
    await requireCentralPrEvidence(reader, repository, prHeadSha);
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
  requireCentralStatuses = true,
): Promise<MainWriteProvenance> {
  const provenance = await validateMainWriteProvenance(reader, repository, mainSha, requireCentralStatuses);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const status = await reader.get(`repos/${repository}/commits/${mainSha}/status`);
    if (hasTrustedMainWriteGuard(status)) {
      return provenance;
    }
    const guardStates = getJsonArray(status, "statuses")
      .filter((item) => isJsonRecord(item) && getJsonString(item, "context") === "Main Write Guard")
      .map((item) => getJsonString(item, "state"));
    if (guardStates.includes("failure") || guardStates.includes("error")) {
      throw new CliError("::error::Source SHA failed Main Write Guard.", 65);
    }
    if (attempt + 1 < 12) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  throw new CliError("::error::Source SHA has no successful Main Write Guard status.", 65);
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
  description: string,
): Promise<void> {
  const runUrl = process.env.MAIN_WRITE_RUN_URL ?? "";
  const args = [
    "api", "--method", "POST",
    `repos/${request.repository}/statuses/${request.head_sha}`,
    "-f", `state=${state}`,
    "-f", "context=Main Write Guard",
    "-f", `description=${description}`,
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
      "pr",
    );
  }

  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
  try {
    const provenance = await validateMainWriteProvenance(
      reader,
      request.repository,
      request.head_sha,
      process.env.MAIN_WRITE_REQUIRE_CENTRAL_STATUSES !== "false",
    );
    await publishStatus(request, token, "success", `Trusted main write via PR #${provenance.pr_number}`);
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
      "- validate-merge: success",
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
