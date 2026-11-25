import { join } from "node:path";
import {
  assertBetaProducer,
  readBetaReleasePolicy,
  verifyBetaReleaseSource,
} from "./beta-release-authorization.ts";
import {
  assertBranchReleaseVersion,
  assertMainPublicationBranch,
} from "./branch-publication-policy.ts";
import {
  getGithubJson,
  getJsonArray,
  getJsonString,
  isJsonRecord,
  statusAwareReader,
} from "./github-api.ts";
import { isStableNpmRelease } from "./release-npm-gate.ts";
import { readRepositoryPolicyText } from "./repository-policy.ts";
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
  assertBranchReleaseVersion(
    isJsonRecord(request) ? String(request.source_branch ?? "main") : "main",
    getJsonString(manifest, "version"),
    manifest.prerelease === true
  );
  const target = manifest.target_repository;
  const scope = resolveGithubApiScope(target, controlRepository, policy, "release-target");
  return {
    owner: scope.owner,
    repository_name: scope.repository_name,
    target_repository: target,
  };
}

// The artifact is uploaded before the producing workflow has necessarily finished.
// Release dispatch can start during that small window; do not turn an in-progress
// producer into a permanent failure. Repository identity and unsuccessful terminal
// runs still fail closed. Tests inject a pause to cover the race without waiting.
export async function waitForSuccessfulArtifactRun(
  readRun: () => Promise<unknown>,
  artifactRepository: string,
  maxAttempts = 30,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<void> {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new CliError("::error::Release artifact run poll budget is invalid.", 64);
  }
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const run = await readRun();
    if (!isJsonRecord(run) || getJsonString(run.repository, "full_name") !== artifactRepository) {
      throw new CliError("::error::Release artifact run repository does not match.", 75);
    }
    const status = getJsonString(run, "status");
    if (status === "completed") {
      if (getJsonString(run, "conclusion") !== "success") {
        throw new CliError("::error::Release artifact producer run did not succeed.", 75);
      }
      return;
    }
    if (!["queued", "requested", "waiting", "pending", "in_progress"].includes(status)) {
      throw new CliError("::error::Release artifact producer run status is invalid.", 75);
    }
    if (attempt + 1 < maxAttempts) {
      await pause(5_000);
    }
  }
  throw new CliError("::error::Release artifact producer run did not complete in time.", 75);
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
  await waitForSuccessfulArtifactRun(
    () => getGithubJson(`repos/${artifactRepository}/actions/runs/${runId}`, readToken),
    artifactRepository
  );
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
  for (const repository of new Set([source, target.target_repository])) {
    const value = await getGithubJson(`repos/${repository}`, readToken);
    assertMainPublicationBranch(getJsonString(value, "default_branch"));
  }
  const isBeta = request.source_branch === "dev";
  if (isBeta) {
    const run = await getGithubJson(`repos/${artifactRepository}/actions/runs/${runId}`, readToken);
    assertBetaProducer(request, run, controlRepository);
    const statusToken = process.env.AW_STATUS_API_TOKEN ?? "";
    if (!statusToken) throw new CliError("Beta release status read token required.", 77);
    await verifyBetaReleaseSource(
      statusAwareReader(
        process.env.GITHUB_API_URL ?? "https://api.github.com",
        readToken,
        statusToken
      ),
      source,
      String(request.source_sha),
      controlRepository,
      readBetaReleasePolicy()
    );
  }
  await appendLines(process.env.GITHUB_OUTPUT, [
    `source_branch=${isBeta ? "dev" : "main"}`,
    `owner=${target.owner}`,
    `repository_name=${target.repository_name}`,
    `target_repository=${target.target_repository}`,
    `npm_required=${
      source === "fongap-labs/plugins" &&
      target.target_repository === "fongap-labs/plugins" &&
      isStableNpmRelease(
        isJsonRecord(manifest) ? getJsonString(manifest, "version") : "",
        isJsonRecord(manifest) && manifest.prerelease === true
      )
        ? "true"
        : "false"
    }`,
  ]);
  console.log("Verified release target scope from the approved artifact and repository policy.");
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
