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
  readJson,
} from "./runtime-command.ts";
import { validateRepositoryCapability } from "./repository-policy.ts";

type BuildEntry = {
  id: string;
  runner: string;
  target: string;
  script: string;
  assets: string[];
};

type ReleaseBuildEntry = {
  artifact_name: string;
  target_repository: string;
  release_key: string;
  release_name: string;
  release_notes: string;
  license_expression: string;
  version_source: {
    type: "cargo-workspace";
    path: string;
  };
  builds: BuildEntry[];
};

type ReleaseBuildPolicy = {
  schema_version: 1;
  repositories: Record<string, ReleaseBuildEntry>;
};

function exactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  return actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

function decodeContent(value: unknown): string {
  if (!isJsonRecord(value) || value.encoding !== "base64" || typeof value.content !== "string") {
    throw new CliError("GitHub contents response is invalid.", 65);
  }
  return Buffer.from(value.content.replace(/\s+/g, ""), "base64").toString("utf8");
}

export function parseCargoWorkspaceVersion(content: string): string {
  const section = content.match(/\[workspace\.package\]([\s\S]*?)(?=\r?\n\[|$)/);
  const version = section?.[1]?.match(/^\s*version\s*=\s*"([^"]+)"\s*$/m)?.[1] ?? "";
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    throw new CliError("Release version source does not contain stable SemVer.", 65);
  }
  return version;
}

export function parseReleaseBuildPolicy(value: unknown): ReleaseBuildPolicy {
  if (!isJsonRecord(value)
    || value.schema_version !== 1
    || !isJsonRecord(value.repositories)
    || Object.keys(value.repositories).length === 0
  ) {
    throw new CliError("Release build policy is invalid.", 65);
  }
  for (const [repository, raw] of Object.entries(value.repositories)) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
      || !isJsonRecord(raw)
      || !exactKeys(raw, [
        "artifact_name",
        "builds",
        "license_expression",
        "release_key",
        "release_name",
        "release_notes",
        "target_repository",
        "version_source",
      ])
      || typeof raw.artifact_name !== "string" || !/^[A-Za-z0-9._-]+$/.test(raw.artifact_name)
      || typeof raw.target_repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw.target_repository)
      || typeof raw.release_key !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw.release_key)
      || typeof raw.release_name !== "string" || raw.release_name.length < 1
      || typeof raw.release_notes !== "string"
      || typeof raw.license_expression !== "string" || raw.license_expression.length < 1
      || !isJsonRecord(raw.version_source)
      || raw.version_source.type !== "cargo-workspace"
      || typeof raw.version_source.path !== "string" || raw.version_source.path.includes("..")
      || !Array.isArray(raw.builds) || raw.builds.length < 1
    ) {
      throw new CliError(`Release build policy entry is invalid: ${repository}.`, 65);
    }
    const ids = new Set<string>();
    const assets = new Set<string>();
    for (const build of raw.builds) {
      if (!isJsonRecord(build)
        || !exactKeys(build, ["assets", "id", "runner", "script", "target"])
        || typeof build.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(build.id)
        || typeof build.runner !== "string" || !/^windows-[A-Za-z0-9.-]+$/.test(build.runner)
        || typeof build.target !== "string" || !/^[A-Za-z0-9_.-]+$/.test(build.target)
        || typeof build.script !== "string" || !/^\.github\/scripts\/[A-Za-z0-9._-]+\.ps1$/.test(build.script)
        || !Array.isArray(build.assets) || build.assets.length < 1
        || !build.assets.every((asset) => typeof asset === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset))
      ) {
        throw new CliError(`Release build matrix entry is invalid: ${repository}.`, 65);
      }
      if (ids.has(build.id)) {
        throw new CliError(`Duplicate release build id: ${build.id}.`, 65);
      }
      ids.add(build.id);
      for (const asset of build.assets) {
        if (assets.has(asset)) {
          throw new CliError(`Duplicate release asset name: ${asset}.`, 65);
        }
        assets.add(asset);
      }
    }
  }
  return value as ReleaseBuildPolicy;
}

export function parseReleaseBuildRequest(value: unknown): {
  request_id: string;
  source_repository: string;
  source_sha: string;
  requested_version: string;
} {
  if (!isJsonRecord(value)
    || !exactKeys(value, ["request_id", "requested_version", "schema_version", "source_repository", "source_sha"])
    || value.schema_version !== "1"
    || typeof value.request_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.request_id)
    || typeof value.source_repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.source_repository)
    || typeof value.source_sha !== "string" || !/^[0-9a-f]{40}$/.test(value.source_sha)
    || typeof value.requested_version !== "string" || value.requested_version.length > 64
  ) {
    throw new CliError("Release build dispatch payload is invalid.", 64);
  }
  return value as {
    request_id: string;
    source_repository: string;
    source_sha: string;
    requested_version: string;
  };
}

async function main(): Promise<void> {
  const request = parseReleaseBuildRequest(
    parseJson(process.env.RELEASE_BUILD_REQUEST_JSON ?? "", "Release build request must be valid JSON.", 64),
  );
  const policy = parseReleaseBuildPolicy(await readJson(process.argv[2] ?? "policies/release-build.json"));
  const repositoryPolicy = parseJson(
    process.env.AW_REPOSITORY_POLICY ?? "",
    "::error::AW_REPOSITORY_POLICY must be valid JSON.",
    65,
  );
  const token = process.env.AW_CONTROL_TOKEN ?? "";
  if (!token) {
    throw new CliError("AW_CONTROL_TOKEN is required.", 77);
  }

  validateRepositoryCapability(request.source_repository, repositoryPolicy, "release-source");
  const entry = policy.repositories[request.source_repository];
  if (!entry) {
    throw new CliError(`Repository has no central release build policy: ${request.source_repository}.`, 77);
  }
  validateRepositoryCapability(entry.target_repository, repositoryPolicy, "release-target");

  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
  const repository = await reader.get(`repos/${request.source_repository}`);
  const defaultBranch = getJsonString(repository, "default_branch");
  const commit = await reader.get(`repos/${request.source_repository}/commits/${defaultBranch}`);
  const defaultSha = getJsonString(commit, "sha");
  if (request.source_sha !== defaultSha) {
    throw new CliError(
      `Release build source must be the current default-branch HEAD: expected=${defaultSha} actual=${request.source_sha}.`,
      65,
    );
  }

  const status = await reader.get(`repos/${request.source_repository}/commits/${request.source_sha}/status`);
  const evidence = getJsonArray(status, "statuses").find(
    (item) => isJsonRecord(item) && getJsonString(item, "context") === "CI Evidence",
  );
  const targetUrl = isJsonRecord(evidence) ? getJsonString(evidence, "target_url") : "";
  if (!isJsonRecord(evidence)
    || getJsonString(evidence, "state") !== "success"
    || !/^https:\/\/github\.com\/fongap-labs\/action-worker\/actions\/runs\/\d+$/.test(targetUrl)
  ) {
    throw new CliError("Release build source has no trusted successful CI Evidence.", 65);
  }

  const contentResponse = await reader.get(
    `repos/${request.source_repository}/contents/${entry.version_source.path}?ref=${request.source_sha}`,
  );
  const version = parseCargoWorkspaceVersion(decodeContent(contentResponse));
  const requestedVersion = request.requested_version.replace(/^v/, "");
  if (requestedVersion && requestedVersion !== version) {
    throw new CliError(
      `Requested release version does not match source version: requested=${requestedVersion} source=${version}.`,
      65,
    );
  }

  const matrix = entry.builds.map(({ id, runner, target, script }) => ({ id, runner, target, script }));
  await appendLines(process.env.GITHUB_OUTPUT, [
    `source_repository=${request.source_repository}`,
    `source_sha=${request.source_sha}`,
    `version=${version}`,
    `artifact_name=${entry.artifact_name}`,
    `target_repository=${entry.target_repository}`,
    `matrix=${JSON.stringify({ include: matrix })}`,
  ]);
  console.log(
    JSON.stringify({
      source_repository: request.source_repository,
      source_sha: request.source_sha,
      version,
      artifact_name: entry.artifact_name,
      target_repository: entry.target_repository,
      builds: matrix.map((item) => item.id),
    }),
  );
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
