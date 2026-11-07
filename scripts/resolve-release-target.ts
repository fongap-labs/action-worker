import { join } from "node:path";
import { getGithubJson, getJsonArray, getJsonString, isJsonRecord } from "./github-api.ts";
import { resolveGithubApiScope } from "./resolve-github-api-scope.ts";
import {
  appendLines,
  CliError,
  handleError,
  isMain,
  parseJson,
  readJson,
} from "./runtime-command.ts";
import { validateRelease, validateReleaseProvenance } from "./validate-release-request.ts";
import { readRepositoryPolicyText } from "./repository-policy.ts";

export function releaseTargetFromArtifact(
  request: unknown,
  manifest: unknown,
  provenance: unknown,
  policy: unknown,
  controlRepository: string
): { owner: string; repository_name: string; target_repository: string } {
  validateRelease(request, manifest, policy);
  validateReleaseProvenance(request, provenance);
  if (!isJsonRecord(manifest) || typeof manifest.target_repository !== "string") {
    throw new CliError("::error::Release manifest has no target repository.", 65);
  }
  const target = manifest.target_repository;
  const scope = resolveGithubApiScope(target, controlRepository, policy, "release-target");
  return {
    owner: scope.owner,
    repository_name: scope.repository_name,
    target_repository: target,
  };
}

async function main(): Promise<void> {
  const policy = parseJson(
    readRepositoryPolicyText() ?? "",
    "AW_REPOSITORY_POLICY must be valid JSON.",
    65
  );
  const request = parseJson(
    process.env.RELEASE_REQUEST_JSON ?? "",
    "RELEASE_REQUEST_JSON must be valid JSON.",
    64
  );
  validateRelease(request, undefined, policy);
  if (!isJsonRecord(request)) {
    throw new CliError("::error::Release request is invalid.", 64);
  }
  const source = String(request.source_repository ?? "");
  const artifactRepository = String(request.artifact_repository ?? "");
  const controlRepository = process.env.GITHUB_REPOSITORY ?? "";
  if (artifactRepository !== source && artifactRepository !== controlRepository) {
    throw new CliError("::error::Release artifact repository is not an approved source.", 77);
  }

  const readToken = process.env.AW_CONTROL_TOKEN ?? "";
  if (!readToken) {
    throw new CliError("::error::Release App read token is required.", 77);
  }
  const runId = request.artifact_run_id as number;
  const run = await getGithubJson(`repos/${artifactRepository}/actions/runs/${runId}`, readToken);
  if (
    !isJsonRecord(run) ||
    getJsonString(run, "status") !== "completed" ||
    getJsonString(run, "conclusion") !== "success" ||
    getJsonString(run.repository, "full_name") !== artifactRepository
  ) {
    throw new CliError(
      "::error::Release artifact run is not successful or does not match its repository.",
      75
    );
  }
  const artifactList = await getGithubJson(
    `repos/${artifactRepository}/actions/runs/${runId}/artifacts?per_page=100`,
    readToken
  );
  const matching = getJsonArray(artifactList, "artifacts").filter(
    (item) => isJsonRecord(item) && item.name === request.artifact_name && item.expired === false
  );
  if (matching.length !== 1) {
    throw new CliError("::error::Release artifact must be unique and unexpired.", 66);
  }

  const artifactRoot = process.env.RELEASE_ARTIFACT_DIR ?? "";
  if (!artifactRoot) {
    throw new CliError("::error::RELEASE_ARTIFACT_DIR is required.", 64);
  }
  const manifest = await readJson(join(artifactRoot, "release-manifest.json"));
  const provenance = await readJson(join(artifactRoot, "release-provenance.json"));
  const target = releaseTargetFromArtifact(
    request,
    manifest,
    provenance,
    policy,
    controlRepository
  );
  await appendLines(process.env.GITHUB_OUTPUT, [
    `owner=${target.owner}`,
    `repository_name=${target.repository_name}`,
    `target_repository=${target.target_repository}`,
  ]);
  console.log("Verified release target scope from the approved artifact and repository policy.");
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
