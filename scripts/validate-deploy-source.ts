import {
  GithubReader,
  getJsonArray,
  getJsonString,
  isJsonRecord,
} from "./github-api.ts";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
  parseJson,
} from "./runtime-command.ts";

export type DeployRequest = {
  schema_version: "1";
  request_id: string;
  source_repository: string;
  source_sha: string;
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

export function parseDeployRequest(value: unknown, expectedRepository: string): DeployRequest {
  if (!isJsonRecord(value)
    || !exactKeys(value, ["request_id", "schema_version", "source_repository", "source_sha"])
    || value.schema_version !== "1"
    || typeof value.request_id !== "string" || !requestPattern.test(value.request_id)
    || typeof value.source_repository !== "string" || !repositoryPattern.test(value.source_repository)
    || value.source_repository !== expectedRepository
    || typeof value.source_sha !== "string" || !shaPattern.test(value.source_sha)
  ) {
    throw new CliError("::error::Deploy request is invalid.", 64);
  }
  return value as DeployRequest;
}

export function hasTrustedCiEvidence(value: unknown): boolean {
  const statuses = getJsonArray(value, "statuses");
  return statuses.some((item) => (
    isJsonRecord(item)
    && getJsonString(item, "context") === "CI Evidence"
    && getJsonString(item, "state") === "success"
    && getJsonString(item, "target_url").startsWith(controlRunPrefix)
  ));
}

async function main(): Promise<void> {
  const [expectedRepository = "", requireDefaultHeadRaw = "true"] = process.argv.slice(2);
  if (!repositoryPattern.test(expectedRepository) || !["true", "false"].includes(requireDefaultHeadRaw)) {
    throw new CliError("Usage: validate-deploy-source.ts <expected-repository> <require-default-head>", 64);
  }

  const token = process.env.AW_CONTROL_TOKEN ?? "";
  const rawRequest = process.env.DEPLOY_REQUEST_JSON ?? "";
  if (!token) {
    throw new CliError("::error::AW_CONTROL_TOKEN is unavailable.", 77);
  }
  if (!rawRequest) {
    throw new CliError("::error::DEPLOY_REQUEST_JSON is unavailable.", 64);
  }

  const request = parseDeployRequest(
    parseJson(rawRequest, "::error::DEPLOY_REQUEST_JSON must be valid JSON.", 64),
    expectedRepository,
  );

  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
  const repository = await reader.get(`repos/${request.source_repository}`);
  const defaultBranch = getJsonString(repository, "default_branch");
  const defaultCommit = await reader.get(`repos/${request.source_repository}/commits/${defaultBranch}`);
  const defaultSha = getJsonString(defaultCommit, "sha");
  if (!shaPattern.test(defaultSha)) {
    throw new CliError("::error::Deploy source default HEAD is invalid.", 65);
  }

  const commit = await reader.get(`repos/${request.source_repository}/commits/${request.source_sha}`);
  const resolvedSha = getJsonString(commit, "sha");
  if (resolvedSha !== request.source_sha) {
    throw new CliError("::error::Deploy source commit could not be resolved exactly.", 65);
  }
  if (requireDefaultHeadRaw === "true" && resolvedSha !== defaultSha) {
    throw new CliError(
      `::error::Deploy source is stale; default HEAD moved: expected=${defaultSha} actual=${resolvedSha}.`,
      75,
    );
  }

  const status = await reader.get(`repos/${request.source_repository}/commits/${resolvedSha}/status`);
  if (!hasTrustedCiEvidence(status)) {
    throw new CliError("::error::Deploy source has no successful Action Worker CI Evidence.", 65);
  }

  await appendLines(process.env.GITHUB_OUTPUT, [
    `source_repository=${request.source_repository}`,
    `source_sha=${resolvedSha}`,
    `default_branch=${defaultBranch}`,
  ]);

  await appendLines(process.env.GITHUB_STEP_SUMMARY, [
    "## Deploy source gate",
    "",
    `- Repository: ${request.source_repository}`,
    `- Commit: ${resolvedSha}`,
    `- Default branch: ${defaultBranch}`,
    `- Require default HEAD: ${requireDefaultHeadRaw}`,
    "- CI Evidence: trusted Action Worker success",
  ]);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
