import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GithubReader,
  getJsonArray,
  getJsonString,
  githubExists,
  isJsonRecord,
} from "./github-api.ts";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
  readJson,
} from "./runtime-command.ts";

type ToolMetadata = {
  schema_version: "1";
  release_key: string;
  source_repository: string;
  release_channel: "stable";
  platform: string;
  arch: string;
  upstream_asset: string;
  checksum_asset: string;
  license_path: string;
  license_expression: string;
};

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

export function parseToolMetadata(value: unknown): ToolMetadata {
  const keys = [
    "arch",
    "checksum_asset",
    "license_expression",
    "license_path",
    "platform",
    "release_channel",
    "release_key",
    "schema_version",
    "source_repository",
    "upstream_asset",
  ] as const;
  if (!isJsonRecord(value)
    || !exactKeys(value, keys)
    || value.schema_version !== "1"
    || value.release_channel !== "stable"
    || typeof value.release_key !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.release_key)
    || typeof value.source_repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.source_repository)
    || typeof value.platform !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value.platform)
    || typeof value.arch !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value.arch)
    || typeof value.upstream_asset !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.upstream_asset)
    || typeof value.checksum_asset !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.checksum_asset)
    || typeof value.license_path !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value.license_path)
    || value.license_path.includes("..")
    || typeof value.license_expression !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.+() -]*$/.test(value.license_expression)
  ) {
    throw new CliError("tool distribution metadata is invalid.", 65);
  }
  return value as ToolMetadata;
}

export function selectStableRelease(value: unknown): Record<string, unknown> {
  for (const release of getJsonArray(value)) {
    if (!isJsonRecord(release) || release.draft === true || release.prerelease === true) {
      continue;
    }
    const tag = getJsonString(release, "tag_name");
    if (/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag)) {
      return release;
    }
  }
  throw new CliError("No stable upstream release was found.", 66);
}

export function checksumForAsset(text: string, asset: string): string {
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Fa-f0-9]{64})\s+\*?(.+)$/);
    if (match && match[2] === asset) {
      return (match[1] ?? "").toLowerCase();
    }
  }
  throw new CliError(`No valid upstream SHA256 was found for ${asset}.`, 66);
}

function decodeGithubContent(value: unknown): string {
  if (!isJsonRecord(value)
    || value.encoding !== "base64"
    || typeof value.content !== "string"
  ) {
    throw new CliError("GitHub contents response is invalid.", 65);
  }
  return Buffer.from(value.content.replace(/\s+/g, ""), "base64").toString("utf8");
}

async function repositoryJson(
  reader: GithubReader,
  repository: string,
  path: string,
  ref: string,
): Promise<unknown> {
  const response = await reader.get(
    `repos/${repository}/contents/${path}?ref=${encodeURIComponent(ref)}`,
  );
  try {
    return JSON.parse(decodeGithubContent(response)) as unknown;
  } catch {
    throw new CliError(`Repository JSON is invalid: ${repository}/${path}.`, 65);
  }
}

async function sha256File(path: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

async function downloadFile(url: string, path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(url, { redirect: "follow", signal: controller.signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      await writeFile(path, Buffer.from(await response.arrayBuffer()));
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 2_000));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function main(): Promise<void> {
  const policyPath = process.argv[2] ?? "policies/review.json";
  const artifactDir = process.argv[3] ?? "";
  if (!artifactDir) {
    throw new CliError("Usage: sync-tool-release.ts <review-policy> <artifact-dir>", 64);
  }

  const controlToken = process.env.AW_CONTROL_TOKEN ?? "";
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const artifactRepository = process.env.GITHUB_REPOSITORY ?? "";
  const artifactRunId = Number(process.env.GITHUB_RUN_ID ?? "");
  if (!controlToken
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(artifactRepository)
    || !Number.isInteger(artifactRunId) || artifactRunId < 1
  ) {
    throw new CliError("Tool sync runtime identity is invalid.", 77);
  }

  const policy = await readJson(policyPath);
  const engine = isJsonRecord(policy) && isJsonRecord(policy.engine) ? policy.engine : {};
  const distributionRepository = getJsonString(engine, "repository");
  const toolKey = getJsonString(engine, "name");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(distributionRepository)
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(toolKey)
  ) {
    throw new CliError("Review engine catalog location is invalid.", 65);
  }

  const reader = new GithubReader(apiUrl, controlToken);
  const repository = await reader.get(`repos/${distributionRepository}`);
  const defaultBranch = getJsonString(repository, "default_branch");
  const commit = await reader.get(`repos/${distributionRepository}/commits/${defaultBranch}`);
  const sourceSha = getJsonString(commit, "sha");
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new CliError("Distribution repository default HEAD is invalid.", 65);
  }

  const status = await reader.get(`repos/${distributionRepository}/commits/${sourceSha}/status`);
  const ciEvidence = getJsonArray(status, "statuses").find(
    (item) => isJsonRecord(item) && getJsonString(item, "context") === "CI Evidence",
  );
  if (!isJsonRecord(ciEvidence) || getJsonString(ciEvidence, "state") !== "success") {
    await appendLines(process.env.GITHUB_OUTPUT, [
      "publish=false",
      `source_repository=${distributionRepository}`,
      `source_sha=${sourceSha}`,
    ]);
    await appendLines(process.env.GITHUB_STEP_SUMMARY, [
      "## Tool distribution sync",
      "",
      `- source: ${distributionRepository}@${sourceSha}`,
      "- result: deferred until CI Evidence is successful",
    ]);
    return;
  }

  const catalog = await repositoryJson(reader, distributionRepository, "tools/catalog.json", sourceSha);
  const tools = getJsonArray(catalog, "tools");
  const entry = tools.find((item) => isJsonRecord(item) && getJsonString(item, "key") === toolKey);
  if (!isJsonRecord(entry)) {
    throw new CliError(`Tool is not registered in the distribution catalog: ${toolKey}.`, 66);
  }
  const metadataPath = getJsonString(entry, "metadata");
  const catalogSource = getJsonString(entry, "source_repository");
  if (!/^tools\/[a-z0-9-]+\/[A-Za-z0-9._-]+$/.test(metadataPath)) {
    throw new CliError("Tool metadata path is invalid.", 65);
  }

  const metadata = parseToolMetadata(
    await repositoryJson(reader, distributionRepository, metadataPath, sourceSha),
  );
  if (metadata.source_repository !== catalogSource) {
    throw new CliError("Tool catalog and metadata source repositories disagree.", 65);
  }

  const releases = await reader.get(`repos/${metadata.source_repository}/releases?per_page=30`);
  const release = selectStableRelease(releases);
  const upstreamTag = getJsonString(release, "tag_name");
  const version = upstreamTag.slice(1);
  const targetTag = `${metadata.release_key}-v${version}`;
  const artifactName = `${metadata.release_key}-release`;

  if (await githubExists(
    `repos/${distributionRepository}/releases/tags/${targetTag}`,
    controlToken,
  )) {
    await appendLines(process.env.GITHUB_OUTPUT, [
      "publish=false",
      `source_repository=${distributionRepository}`,
      `source_sha=${sourceSha}`,
      `artifact_name=${artifactName}`,
    ]);
    await appendLines(process.env.GITHUB_STEP_SUMMARY, [
      "## Tool distribution sync",
      "",
      `- upstream: ${metadata.source_repository}@${upstreamTag}`,
      `- target: ${distributionRepository}@${targetTag}`,
      "- result: already published",
    ]);
    return;
  }

  const assets = getJsonArray(release, "assets");
  const upstreamAsset = assets.find(
    (item) => isJsonRecord(item) && getJsonString(item, "name") === metadata.upstream_asset,
  );
  const checksumAsset = assets.find(
    (item) => isJsonRecord(item) && getJsonString(item, "name") === metadata.checksum_asset,
  );
  if (!isJsonRecord(upstreamAsset) || !isJsonRecord(checksumAsset)) {
    throw new CliError(`${upstreamTag} is missing required distribution assets.`, 66);
  }

  const assetUrl = getJsonString(upstreamAsset, "browser_download_url");
  const checksumUrl = getJsonString(checksumAsset, "browser_download_url");
  const assetDigest = getJsonString(upstreamAsset, "digest");
  if (!assetUrl || !checksumUrl) {
    throw new CliError("Upstream distribution URLs are missing.", 66);
  }

  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });
  const assetName = `${metadata.release_key}-${metadata.platform}-${metadata.arch}`;
  const assetPath = join(artifactDir, assetName);
  const checksumPath = join(artifactDir, "upstream-sha256sum.txt");
  const licenseName = `LICENSE.${metadata.release_key}`;
  const licensePath = join(artifactDir, licenseName);

  await downloadFile(assetUrl, assetPath);
  await downloadFile(checksumUrl, checksumPath);
  await downloadFile(
    `https://raw.githubusercontent.com/${metadata.source_repository}/${upstreamTag}/${metadata.license_path}`,
    licensePath,
  );

  const expectedChecksum = checksumForAsset(
    await readFile(checksumPath, "utf8"),
    metadata.upstream_asset,
  );
  const actualChecksum = await sha256File(assetPath);
  if (actualChecksum !== expectedChecksum) {
    throw new CliError(`${upstreamTag} checksum verification failed.`, 66);
  }
  if (assetDigest && actualChecksum !== assetDigest.replace(/^sha256:/, "").toLowerCase()) {
    throw new CliError(`${upstreamTag} GitHub asset digest mismatch.`, 66);
  }
  await rm(checksumPath, { force: true });

  const licenseChecksum = await sha256File(licensePath);
  const manifest = {
    schema_version: "1",
    target_repository: distributionRepository,
    release_key: metadata.release_key,
    version,
    release_name: `${getJsonString(entry, "name") || metadata.release_key} ${version}`,
    release_notes: `Verified mirror of ${metadata.source_repository} ${upstreamTag}.`,
    prerelease: false,
    license: {
      expression: metadata.license_expression,
      file: licenseName,
    },
    assets: [
      { name: assetName, sha256: actualChecksum },
      { name: licenseName, sha256: licenseChecksum },
    ],
  };
  const provenance = {
    schema_version: "1",
    source_repository: distributionRepository,
    source_sha: sourceSha,
    artifact_repository: artifactRepository,
    artifact_run_id: artifactRunId,
  };

  await writeFile(
    join(artifactDir, "release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(artifactDir, "release-provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
    "utf8",
  );

  await appendLines(process.env.GITHUB_OUTPUT, [
    "publish=true",
    `source_repository=${distributionRepository}`,
    `source_sha=${sourceSha}`,
    `artifact_name=${artifactName}`,
  ]);
  await appendLines(process.env.GITHUB_STEP_SUMMARY, [
    "## Tool distribution sync",
    "",
    `- upstream: ${metadata.source_repository}@${upstreamTag}`,
    `- source metadata: ${distributionRepository}@${sourceSha}`,
    `- artifact: ${artifactRepository}@run-${artifactRunId}/${artifactName}`,
    `- target: ${distributionRepository}@${targetTag}`,
  ]);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
