import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getGithubJson,
  getJsonArray,
  getJsonNumber,
  getJsonString,
  githubEnvironment,
  githubExists,
  isJsonRecord,
  runGithubCli,
} from "./github-api.ts";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
  readJson,
  runCommand,
} from "./runtime-command.ts";

type ReleaseRequest = {
  repository: string;
  source_sha: string;
  source_run_id: number;
  artifact_name: string;
  request_id: string;
};

type ReleaseAsset = {
  name: string;
  sha256: string;
};

type ReleaseManifest = {
  target_repository: string;
  release_key: string;
  version: string;
  release_name?: string;
  release_notes?: string;
  prerelease?: boolean;
  assets: ReleaseAsset[];
  license?: {
    expression?: string;
    file?: string;
  };
};

async function writeCommand(
  command: string,
  args: readonly string[],
  path: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const output = await open(path, "w");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        env,
        stdio: ["ignore", output.fd, "pipe"],
        windowsHide: true,
      });
      const stderr: Buffer[] = [];
      child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        reject(new CliError(detail || `${command} exited with status ${code ?? 1}.`, code ?? 1));
      });
    });
  } finally {
    await output.close();
  }
}

async function requireCommand(command: string, versionArgs: readonly string[]): Promise<void> {
  try {
    await runCommand(command, versionArgs, { maxBuffer: 1024 * 1024 });
  } catch (error) {
    const code = isJsonRecord(error) ? error.code : undefined;
    if (code === "ENOENT") {
      throw new CliError(`${command} is required.`, 69);
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new CliError(`${command} is required.`, 69);
    }
  }
}

export async function sha256File(path: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

async function listNested(root: string, current = root): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      found.push(...await listNested(root, path));
    } else if (entry.isFile() && current !== root) {
      found.push(path);
    }
  }
  return found;
}

async function listRootFiles(root: string, excluded: string[] = []): Promise<string[]> {
  const files = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !excluded.includes(entry.name))
    .map((entry) => entry.name)
    .sort();
  return files;
}

function sameNames(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export function buildTag(releaseKey: string, version: string): string {
  return `${releaseKey}-v${version}`;
}

function asRequest(value: unknown): ReleaseRequest {
  return value as ReleaseRequest;
}

function asManifest(value: unknown): ReleaseManifest {
  return value as ReleaseManifest;
}

async function validateRequest(requestPath: string, manifestPath?: string): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const args = [join(scriptDir, "validate-release-request.sh"), requestPath];
  if (manifestPath) {
    args.push(manifestPath);
  }
  await runCommand("bash", args);
}

async function rollbackRelease(
  repository: string,
  tag: string,
  releaseId: string,
  isReleaseCreated: boolean,
  isTagCreated: boolean,
  token: string,
): Promise<void> {
  if (isReleaseCreated && releaseId) {
    console.log(`::warning::Release publication failed; rolling back Release: ${tag}.`);
    try {
      await runGithubCli(["api", "--method", "DELETE", `repos/${repository}/releases/${releaseId}`], token);
    } catch {
      // Rollback is best effort and the original publication error remains authoritative.
    }
  }
  if (isTagCreated) {
    console.log(`::warning::Rolling back Tag: ${tag}.`);
    try {
      await runGithubCli(["api", "--method", "DELETE", `repos/${repository}/git/refs/tags/${tag}`], token);
    } catch {
      // Rollback is best effort and the original publication error remains authoritative.
    }
  }
}

async function main(): Promise<void> {
  const requestPath = process.argv[2] ?? "";
  if (!requestPath) {
    throw new CliError("release request file is required.", 64);
  }
  try {
    await readFile(requestPath);
  } catch {
    throw new CliError("release request file is required.", 64);
  }

  await requireCommand("gh", ["--version"]);
  await requireCommand("bash", ["--version"]);
  await requireCommand("unzip", ["-v"]);

  const controlToken = process.env.GH_CONTROL_TOKEN ?? "";
  const releaseToken = process.env.GH_RELEASE_TOKEN ?? "";
  if (!controlToken) {
    throw new CliError("GH_CONTROL_TOKEN is required.", 77);
  }
  if (!releaseToken) {
    throw new CliError("GH_RELEASE_TOKEN is required.", 77);
  }

  await validateRequest(requestPath);
  const request = asRequest(await readJson(requestPath));
  const sourceRepository = request.repository;
  const sourceSha = request.source_sha;
  const sourceRunId = request.source_run_id;
  const artifactName = request.artifact_name;
  const requestId = request.request_id;

  const sourceRepoJson = await getGithubJson(`repos/${sourceRepository}`, controlToken);
  const defaultBranch = getJsonString(sourceRepoJson, "default_branch");
  const defaultCommit = await getGithubJson(`repos/${sourceRepository}/commits/${defaultBranch}`, controlToken);
  const defaultSha = getJsonString(defaultCommit, "sha");
  if (sourceSha !== defaultSha) {
    throw new CliError(
      `::error::Release source must be the current default-branch HEAD: expected=${defaultSha} actual=${sourceSha}.`,
      65,
    );
  }

  const runJson = await getGithubJson(`repos/${sourceRepository}/actions/runs/${sourceRunId}`, controlToken);
  const runRepository = isJsonRecord(runJson) ? getJsonString(runJson.repository, "full_name") : "";
  const runSha = getJsonString(runJson, "head_sha");
  const runStatus = getJsonString(runJson, "status");
  const runConclusion = getJsonString(runJson, "conclusion");
  if (runRepository !== sourceRepository || runSha !== sourceSha) {
    throw new CliError("::error::Source run does not match the requested repository and commit.", 65);
  }
  if (runStatus !== "completed" || runConclusion !== "success") {
    throw new CliError(
      `::error::Source run must be completed successfully: run=${sourceRunId} status=${runStatus} conclusion=${runConclusion}.`,
      65,
    );
  }

  const ciJson = JSON.parse(await runGithubCli([
    "run",
    "list",
    "--repo",
    sourceRepository,
    "--workflow",
    "ci.yml",
    "--commit",
    sourceSha,
    "--limit",
    "20",
    "--json",
    "status,conclusion,headSha,databaseId",
  ], controlToken)) as unknown;
  const ciRuns = getJsonArray(ciJson)
    .filter((run) => isJsonRecord(run)
      && run.headSha === sourceSha
      && run.status === "completed"
      && run.conclusion === "success")
    .sort((left, right) => getJsonNumber(right, "databaseId") - getJsonNumber(left, "databaseId"));
  const ciRunId = getJsonNumber(ciRuns[0], "databaseId");
  if (!ciRunId) {
    throw new CliError(`::error::No successful ci.yml run found for source commit: ${sourceSha}.`, 65);
  }

  const artifactJson = await getGithubJson(
    `repos/${sourceRepository}/actions/runs/${sourceRunId}/artifacts?per_page=100`,
    controlToken,
  );
  const artifacts = getJsonArray(artifactJson, "artifacts").filter(
    (artifact) => isJsonRecord(artifact) && artifact.name === artifactName && artifact.expired === false,
  );
  if (artifacts.length !== 1) {
    throw new CliError(
      `::error::Expected exactly one non-expired artifact named ${artifactName}; found ${artifacts.length}.`,
      66,
    );
  }
  const artifactId = getJsonNumber(artifacts[0], "id");

  const workDir = await mkdtemp(join(tmpdir(), "action-worker-release-"));
  const archivePath = join(workDir, "artifact.zip");
  const artifactDir = join(workDir, "artifact");
  await mkdir(artifactDir);

  let isTagCreated = false;
  let isReleaseCreated = false;
  let releaseId = "";
  let targetRepository = "";
  let tag = "";
  try {
    await writeCommand(
      "gh",
      ["api", `repos/${sourceRepository}/actions/artifacts/${artifactId}/zip`],
      archivePath,
      githubEnvironment(controlToken),
    );
    await runCommand("unzip", ["-q", archivePath, "-d", artifactDir]);

    const manifestPath = join(artifactDir, "release-manifest.json");
    await validateRequest(requestPath, manifestPath);
    const nestedFiles = await listNested(artifactDir);
    if (nestedFiles.length > 0) {
      throw new CliError("::error::Release artifact must contain only root-level files.", 66);
    }

    const manifest = asManifest(await readJson(manifestPath));
    const actualFiles = await listRootFiles(artifactDir, ["release-manifest.json"]);
    const expectedFiles = manifest.assets.map((asset) => asset.name).sort();
    if (!sameNames(actualFiles, expectedFiles)) {
      throw new CliError(
        `::error::Artifact files do not match release-manifest.json.\nexpected: ${expectedFiles.join(" ")}\nactual:   ${actualFiles.join(" ")}`,
        66,
      );
    }

    for (const asset of manifest.assets) {
      const assetPath = join(artifactDir, asset.name);
      const actualHash = await sha256File(assetPath);
      if (actualHash !== asset.sha256) {
        throw new CliError(`::error::Artifact SHA256 verification failed: ${asset.name}.`, 66);
      }
      await writeFile(join(artifactDir, `${asset.name}.sha256`), `${asset.sha256}  ${asset.name}\n`, "utf8");
    }

    targetRepository = manifest.target_repository;
    tag = buildTag(manifest.release_key, manifest.version);
    const name = manifest.release_name || tag;
    const releaseNotes = manifest.release_notes ?? "";
    const isPrerelease = manifest.prerelease ?? false;
    const licenseExpression = manifest.license?.expression ?? "Apache-2.0";
    const licenseFile = manifest.license?.file ?? "";

    const targetRepoJson = await getGithubJson(`repos/${targetRepository}`, releaseToken);
    const targetBranch = getJsonString(targetRepoJson, "default_branch");
    const targetCommit = await getGithubJson(`repos/${targetRepository}/commits/${targetBranch}`, releaseToken);
    const targetSha = getJsonString(targetCommit, "sha");
    if (await githubExists(`repos/${targetRepository}/git/ref/tags/${tag}`, releaseToken)) {
      throw new CliError(`::error::Tag already exists in ${targetRepository}: ${tag}.`, 65);
    }
    if (await githubExists(`repos/${targetRepository}/releases/tags/${tag}`, releaseToken)) {
      throw new CliError(`::error::Release already exists in ${targetRepository}: ${tag}.`, 65);
    }

    const provenance = [
      `Source: https://github.com/${sourceRepository}/commit/${sourceSha}`,
      `Source run: https://github.com/${sourceRepository}/actions/runs/${sourceRunId}`,
      `CI run: https://github.com/${sourceRepository}/actions/runs/${ciRunId}`,
      `Request: ${requestId}`,
      `License: ${licenseExpression}`,
      ...(licenseFile ? [`License file: ${licenseFile}`] : []),
    ].join("\n");
    const body = releaseNotes ? `${releaseNotes}\n\n${provenance}` : provenance;

    await runGithubCli([
      "api",
      "--method",
      "POST",
      `repos/${targetRepository}/git/refs`,
      "-f",
      `ref=refs/tags/${tag}`,
      "-f",
      `sha=${targetSha}`,
    ], releaseToken);
    isTagCreated = true;

    const releaseJson = JSON.parse(await runGithubCli([
      "api",
      "--method",
      "POST",
      `repos/${targetRepository}/releases`,
      "-f",
      `tag_name=${tag}`,
      "-f",
      `target_commitish=${targetSha}`,
      "-f",
      `name=${name}`,
      "-f",
      `body=${body}`,
      "-F",
      `prerelease=${isPrerelease}`,
      "-F",
      "draft=true",
    ], releaseToken)) as unknown;
    releaseId = String(getJsonNumber(releaseJson, "id"));
    const releaseUrl = getJsonString(releaseJson, "html_url");
    isReleaseCreated = true;

    const uploadFiles = (await listRootFiles(artifactDir, ["release-manifest.json"]))
      .map((file) => join(artifactDir, file));
    await runGithubCli(["release", "upload", tag, ...uploadFiles, "--repo", targetRepository], releaseToken);

    const expectedReleaseNames = manifest.assets
      .flatMap((asset) => [asset.name, `${asset.name}.sha256`])
      .sort();
    const publishedJson = await getGithubJson(
      `repos/${targetRepository}/releases/${releaseId}/assets?per_page=100`,
      releaseToken,
    );
    const actualReleaseNames = getJsonArray(publishedJson).map((asset) => getJsonString(asset, "name")).sort();
    if (!sameNames(actualReleaseNames, expectedReleaseNames)) {
      throw new CliError("::error::Published Release assets do not match the validated manifest.", 66);
    }

    const verifyDir = join(workDir, "verify");
    await mkdir(verifyDir);
    await runGithubCli(["release", "download", tag, "--repo", targetRepository, "--dir", verifyDir], releaseToken);
    for (const asset of manifest.assets) {
      const downloaded = join(verifyDir, asset.name);
      const checksumPath = join(verifyDir, `${asset.name}.sha256`);
      let checksum = "";
      try {
        checksum = (await readFile(checksumPath, "utf8")).trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
        await readFile(downloaded);
      } catch {
        throw new CliError(`::error::Downloaded Release is missing asset or checksum: ${asset.name}.`, 66);
      }
      const actualHash = await sha256File(downloaded);
      if (actualHash !== asset.sha256 || checksum !== asset.sha256) {
        throw new CliError(`::error::Published Release checksum verification failed: ${asset.name}.`, 66);
      }
    }

    await runGithubCli([
      "api",
      "--method",
      "PATCH",
      `repos/${targetRepository}/releases/${releaseId}`,
      "-F",
      "draft=false",
    ], releaseToken);

    isReleaseCreated = false;
    isTagCreated = false;

    await appendLines(process.env.GITHUB_OUTPUT, [
      `tag=${tag}`,
      `release_url=${releaseUrl}`,
      `target_repository=${targetRepository}`,
    ]);
    await appendLines(process.env.GITHUB_STEP_SUMMARY, [
      "## Release Governance",
      "",
      `- Source: ${sourceRepository}@${sourceSha}`,
      `- Source run: ${sourceRunId}`,
      `- CI run: ${ciRunId}`,
      `- Target: ${targetRepository}@${targetSha}`,
      `- Tag: ${tag}`,
      `- License: ${licenseExpression}`,
      ...(licenseFile ? [`- License file: ${licenseFile}`] : []),
      `- URL: ${releaseUrl}`,
    ]);
  } catch (error) {
    await rollbackRelease(
      targetRepository,
      tag,
      releaseId,
      isReleaseCreated,
      isTagCreated,
      releaseToken,
    );
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
