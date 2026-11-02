import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getGithubJson,
  getJsonArray,
  getJsonString,
  isJsonRecord,
  runGithubCli,
} from "./github-api.ts";
import { configureNpmAuth, npmRegistry, publishNpmTarball } from "./npm-publish.ts";
import { validateRepositoryCapability } from "./repository-policy.ts";
import {
  appendLines,
  CliError,
  handleError,
  isMain,
  parseJson,
  runCommand,
  runText,
} from "./runtime-command.ts";

type NpmPackageManifest = {
  name: string;
  version: string;
};

type NpmReleaseAsset = {
  tarballName: string;
  checksumName: string;
  version: string;
  digest: string;
};

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const tagPattern =
  /^[a-z0-9]+(?:-[a-z0-9]+)*-v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const packageNamePattern = /^@fongap-labs\/[a-z0-9][a-z0-9._-]*$/;
const packageVersionPattern =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function validateNpmRepublishRequest(
  repository: string,
  tag: string,
  controlRepository: string,
  policy: unknown
): void {
  if (
    !repositoryPattern.test(repository) ||
    !tagPattern.test(tag) ||
    !repositoryPattern.test(controlRepository)
  ) {
    throw new CliError("::error::npm republish request is invalid.", 64);
  }
  validateRepositoryCapability(repository, policy, "release-target");
}

export function validateNpmRelease(
  repository: string,
  tag: string,
  controlRepository: string,
  release: unknown,
  policy: unknown
): NpmReleaseAsset {
  if (
    !isJsonRecord(release) ||
    release.draft !== false ||
    release.tag_name !== tag ||
    typeof release.prerelease !== "boolean" ||
    !/^[0-9a-f]{40}$/.test(getJsonString(release, "target_commitish")) ||
    getJsonString(release, "html_url") !== `https://github.com/${repository}/releases/tag/${tag}`
  ) {
    throw new CliError("::error::npm republish requires the exact published GitHub Release.", 66);
  }

  const version = tag.slice(tag.lastIndexOf("-v") + 2);
  if (release.prerelease !== version.includes("-")) {
    throw new CliError("::error::Release prerelease status does not match its version tag.", 66);
  }

  const body = getJsonString(release, "body");
  const sourceMatch =
    /^Source: https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/commit\/[0-9a-f]{40}$/m.exec(
      body
    );
  const artifactMatch =
    /^Artifact run: https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/actions\/runs\/[1-9][0-9]*$/m.exec(
      body
    );
  if (
    !sourceMatch ||
    !artifactMatch ||
    artifactMatch[1] !== controlRepository ||
    !/^Central CI Evidence: success$/m.test(body) ||
    !/^Main Write Guard: success via PR #[1-9][0-9]*$/m.test(body)
  ) {
    throw new CliError(
      "::error::Release provenance is incomplete or does not match Action Worker.",
      66
    );
  }
  validateRepositoryCapability(sourceMatch[1] ?? "", policy, "release-source");

  const assetValues = getJsonArray(release, "assets");
  const assets = assetValues.filter(isJsonRecord);
  if (assets.length !== assetValues.length) {
    throw new CliError("::error::Release assets are invalid.", 66);
  }
  const tarballs = assets.filter(
    (asset) => asset.state === "uploaded" && getJsonString(asset, "name").endsWith(".tgz")
  );
  if (tarballs.length !== 1) {
    throw new CliError("::error::Release must contain exactly one uploaded npm tarball.", 66);
  }
  const tarball = tarballs[0];
  if (!tarball) {
    throw new CliError("::error::Release npm tarball is missing.", 66);
  }
  const tarballName = getJsonString(tarball, "name");
  const checksumName = `${tarballName}.sha256`;
  if (
    assets.filter(
      (asset) => asset.state === "uploaded" && getJsonString(asset, "name") === checksumName
    ).length !== 1 ||
    !/^sha256:[0-9a-f]{64}$/.test(getJsonString(tarball, "digest"))
  ) {
    throw new CliError("::error::Release npm tarball does not have a valid SHA256 asset.", 66);
  }
  return {
    tarballName,
    checksumName,
    version,
    digest: getJsonString(tarball, "digest").slice("sha256:".length),
  };
}

export function parseNpmChecksum(value: string, expectedName: string): string {
  const match = /^([0-9a-fA-F]{64})\s+\*?([A-Za-z0-9._-]+)\s*$/.exec(value.trim());
  if (!match || match[2] !== expectedName) {
    throw new CliError("::error::Release npm tarball checksum file is invalid.", 66);
  }
  return match[1]!.toLowerCase();
}

export function validateNpmPackageManifest(
  value: unknown,
  expectedVersion: string
): NpmPackageManifest {
  if (
    !isJsonRecord(value) ||
    typeof value.name !== "string" ||
    !packageNamePattern.test(value.name) ||
    typeof value.version !== "string" ||
    !packageVersionPattern.test(value.version) ||
    value.version !== expectedVersion ||
    value.private === true
  ) {
    throw new CliError(
      "::error::Release tarball must contain a public @fongap-labs package matching its tag.",
      66
    );
  }
  if (
    isJsonRecord(value.publishConfig) &&
    typeof value.publishConfig.registry === "string" &&
    value.publishConfig.registry.replace(/\/+$/, "") !== npmRegistry.replace(/\/+$/, "")
  ) {
    throw new CliError("::error::Release package is configured for a different npm registry.", 66);
  }
  return { name: value.name, version: value.version };
}

export function npmPackageIntegrity(tarball: Uint8Array): string {
  return `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
}

async function readPublishedIntegrity(
  packageName: string,
  version: string,
  workingDirectory: string,
  env: NodeJS.ProcessEnv
): Promise<string | undefined> {
  try {
    const output = await runText(
      "npm",
      ["view", `${packageName}@${version}`, "dist.integrity", "--json", "--registry", npmRegistry],
      { cwd: workingDirectory, env, timeoutMs: 30_000 }
    );
    let value: unknown = output;
    try {
      value = JSON.parse(output) as unknown;
    } catch {
      // npm versions differ in whether a scalar JSON value is quoted.
    }
    if (typeof value !== "string" || !value.startsWith("sha512-")) {
      throw new CliError("npm registry returned no integrity for the requested version.", 65);
    }
    return value;
  } catch (error) {
    if (error instanceof CliError && /\bE404\b|HTTP 404|404 Not Found/i.test(error.message)) {
      return undefined;
    }
    throw error;
  }
}

async function waitForPublishedIntegrity(
  packageName: string,
  version: string,
  workingDirectory: string,
  env: NodeJS.ProcessEnv
): Promise<string | undefined> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const integrity = await readPublishedIntegrity(packageName, version, workingDirectory, env);
    if (integrity) return integrity;
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  return undefined;
}

async function ensureDistTag(
  packageName: string,
  version: string,
  workingDirectory: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const distTagsText = await runText(
    "npm",
    ["view", packageName, "dist-tags", "--json", "--registry", npmRegistry],
    { cwd: workingDirectory, env, timeoutMs: 30_000 }
  );
  let distTags: unknown;
  try {
    distTags = JSON.parse(distTagsText) as unknown;
  } catch {
    throw new CliError("npm registry returned invalid dist-tags.", 65);
  }
  const tag = version.includes("-beta.") ? "beta" : "latest";
  if (isJsonRecord(distTags) && distTags[tag] === version) return;
  await runCommand("npm", ["dist-tag", "add", `${packageName}@${version}`, tag], {
    cwd: workingDirectory,
    env,
    timeoutMs: 30_000,
  });
}

async function main(): Promise<void> {
  const controlToken = process.env.AW_CONTROL_TOKEN?.trim();
  const npmToken = (process.env.AW_NPM_TOKEN ?? process.env.NPM_TOKEN)?.trim();
  const repository = process.env.NPM_REPUBLISH_REPOSITORY?.trim() ?? "";
  const tag = process.env.NPM_REPUBLISH_TAG?.trim() ?? "";
  const controlRepository = process.env.AW_CONTROL_REPOSITORY?.trim() ?? "";
  const rawPolicy = process.env.AW_REPOSITORY_POLICY;
  if (!controlToken || !npmToken || !rawPolicy) {
    throw new CliError("::error::Missing npm republish credentials or repository policy.", 65);
  }
  const policy = parseJson(rawPolicy, "::error::AW_REPOSITORY_POLICY must be valid JSON.", 65);
  validateNpmRepublishRequest(repository, tag, controlRepository, policy);

  const release = await getGithubJson(
    `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    controlToken
  );
  const releaseAsset = validateNpmRelease(repository, tag, controlRepository, release, policy);
  const workDir = await mkdtemp(join(tmpdir(), "action-worker-npm-republish-"));
  try {
    await runGithubCli(
      [
        "release",
        "download",
        tag,
        "--repo",
        repository,
        "--dir",
        workDir,
        "--pattern",
        releaseAsset.tarballName,
        "--pattern",
        releaseAsset.checksumName,
      ],
      controlToken
    );
    const tarballPath = join(workDir, releaseAsset.tarballName);
    const tarball = await readFile(tarballPath);
    const sha256 = createHash("sha256").update(tarball).digest("hex");
    const checksum = parseNpmChecksum(
      await readFile(join(workDir, releaseAsset.checksumName), "utf8"),
      releaseAsset.tarballName
    );
    if (sha256 !== checksum || sha256 !== releaseAsset.digest) {
      throw new CliError("::error::Downloaded npm tarball failed Release SHA256 verification.", 66);
    }

    const packageJsonText = await runText("tar", ["-xOf", tarballPath, "package/package.json"], {
      maxBuffer: 1024 * 1024,
      timeoutMs: 30_000,
    });
    const packageJson = parseJson(
      packageJsonText,
      "::error::Release npm tarball has invalid package metadata.",
      66
    );
    const packageManifest = validateNpmPackageManifest(packageJson, releaseAsset.version);
    const npmEnv = await configureNpmAuth(workDir, npmToken);
    const expectedIntegrity = npmPackageIntegrity(tarball);
    const publishedIntegrity = await readPublishedIntegrity(
      packageManifest.name,
      packageManifest.version,
      workDir,
      npmEnv
    );
    let status: string;
    if (publishedIntegrity === undefined) {
      await publishNpmTarball(tarballPath, workDir, npmToken, packageManifest.version);
      const verifiedIntegrity = await waitForPublishedIntegrity(
        packageManifest.name,
        packageManifest.version,
        workDir,
        npmEnv
      );
      if (verifiedIntegrity !== expectedIntegrity) {
        throw new CliError(
          "::error::Published npm package integrity does not match the verified Release asset.",
          65
        );
      }
      status = "published";
    } else {
      if (publishedIntegrity !== expectedIntegrity) {
        throw new CliError(
          "::error::npm version already exists with different tarball integrity.",
          65
        );
      }
      status = "already published";
    }
    await ensureDistTag(packageManifest.name, packageManifest.version, workDir, npmEnv);
    await appendLines(process.env.GITHUB_STEP_SUMMARY, [
      "## npm Release Republish",
      "",
      `- Repository: ${repository}`,
      `- Release tag: ${tag}`,
      `- Package: ${packageManifest.name}@${packageManifest.version}`,
      `- Result: ${status}`,
    ]);
    console.log(
      `Verified npm package release: ${packageManifest.name}@${packageManifest.version}.`
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
