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
import {
  parseRunnerPolicy,
  resolveRunnerProfile,
} from "./runner-policy.ts";

type VersionSource = {
  type: "cargo-workspace" | "cargo-package";
  path: string;
};

type BuildEntry = {
  id: string;
  runner_profile: string;
  target: string;
  script: string;
  assets: string[];
  attest_asset: string;
};

export type ReleaseBuildManifest = {
  schema_version: 1;
  artifact_name: string;
  target_repository: string;
  release_key: string;
  release_name: string;
  release_notes: string;
  license_expression: string;
  node_version_file: string;
  python_version_file: string;
  sbom_asset: string;
  version_source: VersionSource;
  builds: BuildEntry[];
};

function exactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  return actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

export function decodeGithubContent(value: unknown): string {
  if (!isJsonRecord(value) || value.encoding !== "base64" || typeof value.content !== "string") {
    throw new CliError("GitHub contents response is invalid.", 65);
  }
  return Buffer.from(value.content.replace(/\s+/g, ""), "base64").toString("utf8");
}

function parseStableCargoVersion(content: string, sectionName: "workspace.package" | "package"): string {
  const escaped = sectionName.replace(".", "\\.");
  const section = content.match(new RegExp(`\\[${escaped}\\]([\\s\\S]*?)(?=\\r?\\n\\[|$)`));
  const version = section?.[1]?.match(/^\s*version\s*=\s*"([^"]+)"\s*$/m)?.[1] ?? "";
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    throw new CliError("Release version source does not contain stable SemVer.", 65);
  }
  return version;
}

export function parseCargoWorkspaceVersion(content: string): string {
  return parseStableCargoVersion(content, "workspace.package");
}

export function parseCargoPackageVersion(content: string): string {
  return parseStableCargoVersion(content, "package");
}

function isRelativePath(value: unknown): value is string {
  return typeof value === "string"
    && (value === "" || (
      /^[A-Za-z0-9._/-]+$/.test(value)
      && !value.startsWith("/")
      && !value.split("/").includes("..")
    ));
}

function isAssetName(value: unknown, isEmptyAllowed = false): value is string {
  return typeof value === "string"
    && ((isEmptyAllowed && value === "") || /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value));
}

export function parseReleaseBuildManifest(value: unknown): ReleaseBuildManifest {
  if (!isJsonRecord(value)
    || !exactKeys(value, [
      "artifact_name",
      "builds",
      "license_expression",
      "node_version_file",
      "python_version_file",
      "release_key",
      "release_name",
      "release_notes",
      "sbom_asset",
      "schema_version",
      "target_repository",
      "version_source",
    ])
    || value.schema_version !== 1
    || !isAssetName(value.artifact_name)
    || typeof value.target_repository !== "string"
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.target_repository)
    || typeof value.release_key !== "string"
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.release_key)
    || typeof value.release_name !== "string"
    || value.release_name.length < 1
    || typeof value.release_notes !== "string"
    || typeof value.license_expression !== "string"
    || value.license_expression.length < 1
    || !isRelativePath(value.node_version_file)
    || !isRelativePath(value.python_version_file)
    || !isAssetName(value.sbom_asset, true)
    || !isJsonRecord(value.version_source)
    || !exactKeys(value.version_source, ["path", "type"])
    || !["cargo-workspace", "cargo-package"].includes(String(value.version_source.type))
    || !isRelativePath(value.version_source.path)
    || value.version_source.path === ""
    || !Array.isArray(value.builds)
    || value.builds.length < 1
    || value.builds.length > 32
  ) {
    throw new CliError("Release build manifest is invalid.", 65);
  }

  const ids = new Set<string>();
  const assets = new Set<string>();
  for (const build of value.builds) {
    if (!isJsonRecord(build)
      || !exactKeys(build, ["assets", "attest_asset", "id", "runner_profile", "script", "target"])
      || typeof build.id !== "string"
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(build.id)
      || typeof build.runner_profile !== "string"
      || !/^[a-z][a-z0-9-]{0,63}$/.test(build.runner_profile)
      || typeof build.target !== "string"
      || !/^[A-Za-z0-9_.-]+$/.test(build.target)
      || typeof build.script !== "string"
      || !/^\.github\/scripts\/[A-Za-z0-9._-]+\.ps1$/.test(build.script)
      || !Array.isArray(build.assets)
      || build.assets.length < 1
      || !build.assets.every((asset) => isAssetName(asset))
      || new Set(build.assets).size !== build.assets.length
      || !isAssetName(build.attest_asset, true)
      || (build.attest_asset !== "" && !build.assets.includes(build.attest_asset))
    ) {
      throw new CliError("Release build matrix entry is invalid.", 65);
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

  if (value.sbom_asset !== "" && assets.has(value.sbom_asset)) {
    throw new CliError(`SBOM asset duplicates a build asset: ${value.sbom_asset}.`, 65);
  }

  return value as unknown as ReleaseBuildManifest;
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
    || typeof value.request_id !== "string"
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.request_id)
    || typeof value.source_repository !== "string"
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.source_repository)
    || typeof value.source_sha !== "string"
    || !/^[0-9a-f]{40}$/.test(value.source_sha)
    || typeof value.requested_version !== "string"
    || value.requested_version.length > 64
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

  const manifestResponse = await reader.get(
    `repos/${request.source_repository}/contents/.github/release.manifest.json?ref=${request.source_sha}`,
  );
  const manifest = parseReleaseBuildManifest(
    parseJson(decodeGithubContent(manifestResponse), "Release build manifest must be valid JSON.", 65),
  );
  validateRepositoryCapability(manifest.target_repository, repositoryPolicy, "release-target");

  const versionResponse = await reader.get(
    `repos/${request.source_repository}/contents/${manifest.version_source.path}?ref=${request.source_sha}`,
  );
  const versionContent = decodeGithubContent(versionResponse);
  const version = manifest.version_source.type === "cargo-workspace"
    ? parseCargoWorkspaceVersion(versionContent)
    : parseCargoPackageVersion(versionContent);

  const requestedVersion = request.requested_version.replace(/^v/, "");
  if (requestedVersion && requestedVersion !== version) {
    throw new CliError(
      `Requested release version does not match source version: requested=${requestedVersion} source=${version}.`,
      65,
    );
  }

  const runnerPolicy = parseRunnerPolicy(
    await readJson(process.argv[2] ?? "policies/runner.json"),
  );
  const matrix = manifest.builds.map((build) => {
    const resolved = resolveRunnerProfile(runnerPolicy, build.runner_profile);
    if (resolved.profile.trust_domain !== "sandbox") {
      throw new CliError(
        `Release build runner profile must use the sandbox trust domain: ${build.runner_profile}.`,
        77,
      );
    }
    return {
      id: build.id,
      runner_profile: resolved.name,
      runner_labels_json: JSON.stringify(resolved.profile.labels),
      target: build.target,
      script: build.script,
      attest_asset: build.attest_asset,
    };
  });

  await appendLines(process.env.GITHUB_OUTPUT, [
    `source_repository=${request.source_repository}`,
    `source_sha=${request.source_sha}`,
    `version=${version}`,
    `artifact_name=${manifest.artifact_name}`,
    `target_repository=${manifest.target_repository}`,
    `node_version_file=${manifest.node_version_file}`,
    `python_version_file=${manifest.python_version_file}`,
    `sbom_asset=${manifest.sbom_asset}`,
    `matrix=${JSON.stringify({ include: matrix })}`,
  ]);

  console.log(
    JSON.stringify({
      source_repository: request.source_repository,
      source_sha: request.source_sha,
      version,
      artifact_name: manifest.artifact_name,
      target_repository: manifest.target_repository,
      node_version_file: manifest.node_version_file,
      python_version_file: manifest.python_version_file,
      sbom_asset: manifest.sbom_asset,
      builds: matrix.map((item) => item.id),
    }),
  );
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
