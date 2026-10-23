import { bumpForChanges, loadReleaseSpan, nextVersion } from "./compute-release-version.ts";
import { GithubReader, getJsonString, isJsonRecord } from "./github-api.ts";
import { validateRepositoryCapability } from "./repository-policy.ts";
import { appendLines, CliError, handleError, isMain, parseJson } from "./runtime-command.ts";
import {
  normalizeReleaseVersion,
  parseReleaseBuildRequest,
  resolveReleaseBuildProduct,
} from "./validate-release-build-request.ts";

type GithubGet = {
  get(path: string): Promise<unknown>;
};

/**
 * Resolves one manual release launch. An empty requested version proposes the next stable SemVer
 * from the Conventional Commits of the release span, which runs from the last published release of
 * the release key to the current default-branch head. The version stays an input of the release
 * request, never a fact the source repository states (01_SHARED_GOVERNANCE.md §3). When the
 * product manifest leaves release_notes empty, the same span also proposes the release notes.
 */
export async function resolveManualReleaseBuild(
  repository: string,
  requestedVersionRaw: string,
  policy: unknown,
  reader: GithubGet,
  runId: string,
  runAttempt: string,
  product = ""
): Promise<ReturnType<typeof parseReleaseBuildRequest>> {
  validateRepositoryCapability(repository, policy, "release-source");
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
  const request = {
    schema_version: "1",
    request_id: `manual:${repository.replace("/", "-")}:${runId}:${runAttempt}`,
    source_repository: repository,
    source_sha: sourceSha,
    // The placeholder only lets product resolution read the manifest; a computed or entered
    // version replaces it before the request parses.
    requested_version:
      requestedVersionRaw === "" ? "0.0.0" : normalizeReleaseVersion(requestedVersionRaw),
    // An empty product is left out, so a single-product request keeps its existing shape.
    ...(product === "" ? {} : { product }),
  };

  const { manifest } = await resolveReleaseBuildProduct(reader, request);
  const span = await loadReleaseSpan(reader, {
    target_repository: manifest.target_repository,
    source_repository: repository,
    source_sha: sourceSha,
    default_branch: defaultBranch,
    release_key: manifest.release_key,
    root: manifest.root ?? "",
  });

  if (requestedVersionRaw === "") {
    const bump = bumpForChanges(span.changes);
    if (bump === null) {
      const base = span.base_version
        ? `release ${manifest.release_key}-v${span.base_version}`
        : "the first release";
      throw new CliError(
        `::error::No release-worthy Conventional Commits since ${base}. Cut a change or enter an explicit requested_version.`,
        65
      );
    }
    request.requested_version = nextVersion(span.base_version, bump);
  }

  // Empty release notes are filled at publication from the changelog version section, so no
  // commit-span notes are proposed here.
  return parseReleaseBuildRequest(request);
}

async function main(): Promise<void> {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  let request: ReturnType<typeof parseReleaseBuildRequest>;

  if (eventName === "repository_dispatch") {
    request = parseReleaseBuildRequest(
      parseJson(
        process.env.RELEASE_DISPATCH_JSON ?? "",
        "Release build dispatch payload must be valid JSON.",
        64
      )
    );
  } else if (eventName === "workflow_dispatch") {
    const token = process.env.AW_CONTROL_TOKEN ?? "";
    const policy = parseJson(
      process.env.AW_REPOSITORY_POLICY ?? "",
      "AW_REPOSITORY_POLICY must be valid JSON.",
      65
    );
    if (!token) {
      throw new CliError("AW_CONTROL_TOKEN is required.", 77);
    }
    request = await resolveManualReleaseBuild(
      process.env.RELEASE_SOURCE_REPOSITORY ?? "",
      process.env.RELEASE_REQUESTED_VERSION ?? "",
      policy,
      new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token),
      process.env.GITHUB_RUN_ID ?? "",
      process.env.GITHUB_RUN_ATTEMPT ?? "1",
      process.env.RELEASE_PRODUCT ?? ""
    );
  } else {
    throw new CliError(`Unsupported release ingress event: ${eventName}.`, 64);
  }

  const encoded = JSON.stringify(request);
  const outputs = [
    `request_json=${encoded}`,
    `source_repository=${request.source_repository}`,
    `source_sha=${request.source_sha}`,
  ];
  const notes = request.release_notes ?? "";
  // GitHub output values that hold newlines need the heredoc form; the notes are the only value
  // the release request carries that spans lines.
  if (notes.includes("\n")) {
    outputs.push("release_notes<<RELEASE_NOTES_EOF", ...notes.split("\n"), "RELEASE_NOTES_EOF");
  } else {
    outputs.push(`release_notes=${notes}`);
  }
  await appendLines(process.env.GITHUB_OUTPUT, outputs);
  console.log(encoded);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
