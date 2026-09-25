import {
  GithubReader,
  getJsonString,
  isJsonRecord,
} from "./github-api.ts";
import { validateRepositoryCapability } from "./repository-policy.ts";
import {
  parseReleaseBuildRequest,
} from "./validate-release-build-request.ts";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
  parseJson,
} from "./runtime-command.ts";

function normalizeVersion(value: string): string {
  const version = value.replace(/^v/, "");
  if (version && !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    throw new CliError("Requested release version must be stable SemVer.", 64);
  }
  return version;
}

async function manualRequest(): Promise<ReturnType<typeof parseReleaseBuildRequest>> {
  const repository = process.env.RELEASE_SOURCE_REPOSITORY ?? "";
  const requestedVersion = normalizeVersion(process.env.RELEASE_REQUESTED_VERSION ?? "");
  const token = process.env.AW_CONTROL_TOKEN ?? "";
  const policy = parseJson(
    process.env.AW_REPOSITORY_POLICY ?? "",
    "AW_REPOSITORY_POLICY must be valid JSON.",
    65,
  );
  if (!token) {
    throw new CliError("AW_CONTROL_TOKEN is required.", 77);
  }
  validateRepositoryCapability(repository, policy, "release-source");

  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
  const repo = await reader.get(`repos/${repository}`);
  if (!isJsonRecord(repo)) {
    throw new CliError("GitHub repository response is invalid.", 65);
  }
  const defaultBranch = getJsonString(repo, "default_branch");
  if (!defaultBranch) {
    throw new CliError("Repository default branch is unavailable.", 65);
  }
  const commit = await reader.get(`repos/${repository}/commits/${defaultBranch}`);
  const sourceSha = getJsonString(commit, "sha");
  const runId = process.env.GITHUB_RUN_ID ?? "";
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";

  return parseReleaseBuildRequest({
    schema_version: "1",
    request_id: `manual:${repository.replace("/", "-")}:${runId}:${runAttempt}`,
    source_repository: repository,
    source_sha: sourceSha,
    requested_version: requestedVersion,
  });
}

async function main(): Promise<void> {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  let request: ReturnType<typeof parseReleaseBuildRequest>;

  if (eventName === "repository_dispatch") {
    request = parseReleaseBuildRequest(
      parseJson(
        process.env.RELEASE_DISPATCH_JSON ?? "",
        "Release build dispatch payload must be valid JSON.",
        64,
      ),
    );
  } else if (eventName === "workflow_dispatch") {
    request = await manualRequest();
  } else {
    throw new CliError(`Unsupported release ingress event: ${eventName}.`, 64);
  }

  const encoded = JSON.stringify(request);
  await appendLines(process.env.GITHUB_OUTPUT, [
    `request_json=${encoded}`,
    `source_repository=${request.source_repository}`,
    `source_sha=${request.source_sha}`,
  ]);
  console.log(encoded);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
