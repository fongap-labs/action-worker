import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { publishChangelogRelease, type ReleasePolicy } from "./changelog-release-pr.ts";
import { controlRepositoryOf, hasVerifiedCiEvidence } from "./ci-evidence.ts";
import {
  GithubReader,
  getGithubJson,
  getJsonArray,
  getJsonNumber,
  getJsonString,
  githubEnvironment,
  githubExists,
  isJsonRecord,
  runGithubCli,
} from "./github-api.ts";
import { assertTrustedMainWrite } from "./main-write-guard.ts";
import {
  appendLines,
  CliError,
  handleError,
  isMain,
  readJson,
  runCommand,
  runText,
} from "./runtime-command.ts";
import { validateReleaseProvenance } from "./validate-release-request.ts";

type ReleaseRequest = {
  source_repository: string;
  source_sha: string;
  artifact_repository: string;
  artifact_run_id: number;
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
  // The release's own changelog entries. A release that carries them owns them: it does not
  // consume the shared [Unreleased] section or the fragments of other releases.
  changelog_entries?: string[];
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
  env: NodeJS.ProcessEnv
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
      let stderrSize = 0;
      let isSettled = false;
      const finish = (error?: unknown): void => {
        if (isSettled) {
          return;
        }
        isSettled = true;
        clearTimeout(timer);
        if (error !== undefined) {
          reject(error);
        } else {
          resolve();
        }
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new CliError(`${command} timed out after 300000 ms.`, 124));
      }, 300_000);
      child.stderr!.on("data", (chunk: Buffer) => {
        stderrSize += chunk.length;
        if (stderrSize > 1024 * 1024) {
          child.kill();
          finish(new CliError(`${command} error output exceeded 1048576 bytes.`));
          return;
        }
        stderr.push(chunk);
      });
      child.on("error", finish);
      child.on("close", (code) => {
        if (isSettled) {
          return;
        }
        if (code === 0) {
          finish();
          return;
        }
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        finish(new CliError(detail || `${command} exited with status ${code ?? 1}.`, code ?? 1));
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
    throw error;
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
      found.push(...(await listNested(root, path)));
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
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

export function buildTag(releaseKey: string, version: string): string {
  return `${releaseKey}-v${version}`;
}

export function buildReleaseTitle(releaseName: string | undefined, version: string): string {
  const versionLabel = `v${version}`;
  return releaseName ? `${releaseName} ${versionLabel}` : versionLabel;
}

export function validateArchive(entries: string): string[] {
  const names = entries.split(/\r?\n/).filter(Boolean);
  if (names.length === 0) {
    throw new CliError("::error::Release artifact is empty.", 66);
  }
  const unique = new Set(names);
  if (
    unique.size !== names.length ||
    names.some((name) => name === "." || name === ".." || name.includes("/") || name.includes("\\"))
  ) {
    throw new CliError("::error::Release artifact must contain unique root-level files.", 66);
  }
  return names;
}

function asRequest(value: unknown): ReleaseRequest {
  return value as ReleaseRequest;
}

function asManifest(value: unknown): ReleaseManifest {
  return value as ReleaseManifest;
}

async function validateRequest(requestPath: string, manifestPath?: string): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const args = [join(scriptDir, "validate-release-request.ts"), requestPath];
  if (manifestPath) {
    args.push(manifestPath);
  }
  await runCommand(process.execPath, args);
}

async function waitForCompletedRun(
  repository: string,
  runId: number,
  token: string
): Promise<unknown> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const runJson = await getGithubJson(`repos/${repository}/actions/runs/${runId}`, token);
    const status = getJsonString(runJson, "status");
    if (status === "completed") {
      return runJson;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new CliError(
    `::error::Artifact run did not complete before release validation: repository=${repository} run=${runId}.`,
    75
  );
}

// The changelog file and fragment directory come from the control repository's release policy,
// the same policy the change record validator enforces.
async function readReleasePolicy(): Promise<ReleasePolicy> {
  const value = await readJson(
    join(dirname(fileURLToPath(import.meta.url)), "..", "policies", "release.json")
  );
  if (
    !isJsonRecord(value) ||
    typeof value.changelog_file !== "string" ||
    typeof value.changelog_fragment_dir !== "string" ||
    !Array.isArray(value.changelog_categories)
  ) {
    throw new CliError("::error::Invalid release policy for the changelog release.", 65);
  }
  return {
    changelog_file: value.changelog_file,
    changelog_fragment_dir: value.changelog_fragment_dir,
    changelog_categories: value.changelog_categories.filter(
      (item): item is string => typeof item === "string"
    ),
  };
}

// Only an unpublished draft is ever rolled back: no tag exists until the Release is published.
async function rollbackRelease(
  repository: string,
  tag: string,
  releaseId: string,
  isReleaseCreated: boolean,
  token: string
): Promise<void> {
  if (isReleaseCreated && releaseId) {
    console.log(`::warning::Release publication failed; rolling back draft Release: ${tag}.`);
    try {
      await runGithubCli(
        ["api", "--method", "DELETE", `repos/${repository}/releases/${releaseId}`],
        token
      );
    } catch {
      // Rollback is best effort and the original publication error remains authoritative.
    }
  }
}

// Whether a mirror's source commit still stands for the default branch: the commit is an ancestor
// of the default-branch head, and nothing under the mirror's own tools/<release_key>/ directory
// changed since, so the pins it publishes are the ones on the default branch. A comparison that
// lists too few files to show that is refused.
export function mirrorSourceIsCurrent(comparison: unknown, releaseKey: string): boolean {
  const status = getJsonString(comparison, "status");
  if (status !== "ahead" && status !== "identical") {
    return false;
  }
  const files =
    isJsonRecord(comparison) && Array.isArray(comparison.files) ? comparison.files : null;
  if (files === null || files.length >= 300) {
    return false;
  }
  return files.every((file) => !getJsonString(file, "filename").startsWith(`tools/${releaseKey}/`));
}

// The source must be the default-branch head, except for a mirror. Other releases merge their
// changelog commits to the default branch while a sync batch runs, so a mirror's source goes stale
// as soon as the first of them publishes. The pins must still be unchanged, so that is allowed.
async function assertSourceCurrent(
  sourceRepository: string,
  sourceSha: string,
  defaultSha: string,
  manifest: ReleaseManifest,
  token: string
): Promise<void> {
  if (sourceSha === defaultSha) {
    return;
  }
  if (manifest.changelog_entries === undefined) {
    throw new CliError(
      `::error::Release source must be the current default-branch HEAD: expected=${defaultSha} actual=${sourceSha}.`,
      65
    );
  }
  const comparison = await getGithubJson(
    `repos/${sourceRepository}/compare/${sourceSha}...${defaultSha}`,
    token
  );
  if (!mirrorSourceIsCurrent(comparison, manifest.release_key)) {
    throw new CliError(
      `::error::Mirror source ${sourceSha} is not behind ${defaultSha} with ${manifest.release_key} unchanged.`,
      65
    );
  }
}

async function main(): Promise<void> {
  const requestPath =
    process.argv[2] ??
    (process.env.RUNNER_TEMP ? join(process.env.RUNNER_TEMP, "release-request.json") : "");
  if (!requestPath) {
    throw new CliError("release request file is required.", 64);
  }
  if (process.env.RELEASE_REQUEST_JSON) {
    await writeFile(requestPath, `${process.env.RELEASE_REQUEST_JSON}\n`, "utf8");
  }
  try {
    await readFile(requestPath);
  } catch {
    throw new CliError("release request file is required.", 64);
  }

  await requireCommand("gh", ["--version"]);
  await requireCommand("unzip", ["-v"]);

  const controlToken = process.env.AW_CONTROL_TOKEN ?? "";
  if (!controlToken) {
    throw new CliError("AW_CONTROL_TOKEN is required.", 77);
  }

  await validateRequest(requestPath);
  const request = asRequest(await readJson(requestPath));
  const sourceRepository = request.source_repository;
  const sourceSha = request.source_sha;
  const artifactRepository = request.artifact_repository;
  const artifactRunId = request.artifact_run_id;
  const artifactName = request.artifact_name;
  const requestId = request.request_id;

  const controlRepository = process.env.GITHUB_REPOSITORY ?? "";
  if (artifactRepository !== sourceRepository && artifactRepository !== controlRepository) {
    throw new CliError(
      `::error::Artifact repository must be the source repository or the Action Worker control repository: ${artifactRepository}.`,
      77
    );
  }

  const sourceRepoJson = await getGithubJson(`repos/${sourceRepository}`, controlToken);
  const defaultBranch = getJsonString(sourceRepoJson, "default_branch");
  const defaultCommit = await getGithubJson(
    `repos/${sourceRepository}/commits/${defaultBranch}`,
    controlToken
  );
  const defaultSha = getJsonString(defaultCommit, "sha");

  const sourceReader = new GithubReader(
    process.env.GITHUB_API_URL ?? "https://api.github.com",
    controlToken
  );
  const mainWrite = await assertTrustedMainWrite(sourceReader, sourceRepository, sourceSha, true);

  const runJson = await waitForCompletedRun(artifactRepository, artifactRunId, controlToken);
  const runRepository = isJsonRecord(runJson) ? getJsonString(runJson.repository, "full_name") : "";
  const runConclusion = getJsonString(runJson, "conclusion");
  if (runRepository !== artifactRepository) {
    throw new CliError("::error::Artifact run does not belong to the requested repository.", 65);
  }
  if (runConclusion !== "success") {
    throw new CliError(
      `::error::Artifact run must complete successfully: repository=${artifactRepository} run=${artifactRunId} conclusion=${runConclusion || "missing"}.`,
      65
    );
  }

  const ciJson = JSON.parse(
    await runGithubCli(
      [
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
      ],
      controlToken
    )
  ) as unknown;
  const ciRuns = getJsonArray(ciJson)
    .filter(
      (run) =>
        isJsonRecord(run) &&
        run.headSha === sourceSha &&
        run.status === "completed" &&
        run.conclusion === "success"
    )
    .sort((left, right) => getJsonNumber(right, "databaseId") - getJsonNumber(left, "databaseId"));
  const ciRunId = getJsonNumber(ciRuns[0], "databaseId") ?? 0;

  const statusJson = await getGithubJson(
    `repos/${sourceRepository}/commits/${sourceSha}/status`,
    controlToken
  );
  if (
    !(await hasVerifiedCiEvidence(sourceReader, statusJson, {
      controlRepository: controlRepositoryOf(),
    }))
  ) {
    throw new CliError(
      `::error::Central CI Evidence is not successful for source commit: sha=${sourceSha}. The status must come from a successful Action Worker CI run; open that run to see why, or merge a new commit so central CI runs again.`,
      65
    );
  }

  const artifactJson = await getGithubJson(
    `repos/${artifactRepository}/actions/runs/${artifactRunId}/artifacts?per_page=100`,
    controlToken
  );
  const artifacts = getJsonArray(artifactJson, "artifacts").filter(
    (artifact) =>
      isJsonRecord(artifact) && artifact.name === artifactName && artifact.expired === false
  );
  if (artifacts.length !== 1) {
    throw new CliError(
      `::error::Expected exactly one non-expired artifact named ${artifactName}; found ${artifacts.length}.`,
      66
    );
  }
  const artifactId = getJsonNumber(artifacts[0], "id");

  const workDir = await mkdtemp(join(tmpdir(), "action-worker-release-"));
  const archivePath = join(workDir, "artifact.zip");
  const artifactDir = join(workDir, "artifact");
  await mkdir(artifactDir);

  let isReleaseCreated = false;
  let releaseId = "";
  let targetRepository = "";
  let tag = "";
  try {
    await writeCommand(
      "gh",
      ["api", `repos/${artifactRepository}/actions/artifacts/${artifactId}/zip`],
      archivePath,
      githubEnvironment(controlToken)
    );
    validateArchive(
      await runText("unzip", ["-Z1", archivePath], {
        maxBuffer: 1024 * 1024,
        timeoutMs: 30_000,
      })
    );
    await runCommand("unzip", ["-q", archivePath, "-d", artifactDir], {
      maxBuffer: 1024 * 1024,
      timeoutMs: 300_000,
    });

    const manifestPath = join(artifactDir, "release-manifest.json");
    const provenancePath = join(artifactDir, "release-provenance.json");
    await validateRequest(requestPath, manifestPath);
    validateReleaseProvenance(request, await readJson(provenancePath));
    const nestedFiles = await listNested(artifactDir);
    if (nestedFiles.length > 0) {
      throw new CliError("::error::Release artifact must contain only root-level files.", 66);
    }

    const manifest = asManifest(await readJson(manifestPath));
    await assertSourceCurrent(sourceRepository, sourceSha, defaultSha, manifest, controlToken);
    const actualFiles = await listRootFiles(artifactDir, [
      "release-manifest.json",
      "release-provenance.json",
    ]);
    const expectedFiles = manifest.assets.map((asset) => asset.name).sort();
    if (!sameNames(actualFiles, expectedFiles)) {
      throw new CliError(
        `::error::Artifact files do not match release-manifest.json.\nexpected: ${expectedFiles.join(" ")}\nactual:   ${actualFiles.join(" ")}`,
        66
      );
    }

    for (const asset of manifest.assets) {
      const assetPath = join(artifactDir, asset.name);
      const actualHash = await sha256File(assetPath);
      if (actualHash !== asset.sha256) {
        throw new CliError(`::error::Artifact SHA256 verification failed: ${asset.name}.`, 66);
      }
      await writeFile(
        join(artifactDir, `${asset.name}.sha256`),
        `${asset.sha256}  ${asset.name}\n`,
        "utf8"
      );
    }

    targetRepository = manifest.target_repository;
    tag = buildTag(manifest.release_key, manifest.version);
    const name = buildReleaseTitle(manifest.release_name, manifest.version);
    const isPrerelease = manifest.prerelease ?? false;
    const licenseExpression = manifest.license?.expression ?? "Apache-2.0";
    const licenseFile = manifest.license?.file ?? "";

    const targetRepoJson = await getGithubJson(`repos/${targetRepository}`, controlToken);
    const targetBranch = getJsonString(targetRepoJson, "default_branch");
    const targetCommit = await getGithubJson(
      `repos/${targetRepository}/commits/${targetBranch}`,
      controlToken
    );
    const targetSha = getJsonString(targetCommit, "sha");
    if (await githubExists(`repos/${targetRepository}/git/ref/tags/${tag}`, controlToken)) {
      throw new CliError(`::error::Tag already exists in ${targetRepository}: ${tag}.`, 65);
    }
    if (await githubExists(`repos/${targetRepository}/releases/tags/${tag}`, controlToken)) {
      throw new CliError(`::error::Release already exists in ${targetRepository}: ${tag}.`, 65);
    }

    // The changelog version section is merged first; the tag then points at its merge commit.
    const changelogRelease = await publishChangelogRelease({
      repository: targetRepository,
      defaultBranch: targetBranch,
      baseSha: targetSha,
      tag,
      version: manifest.version,
      date: new Date().toISOString().slice(0, 10),
      releaseUrl: `https://github.com/${targetRepository}/releases/tag/${tag}`,
      policy: await readReleasePolicy(),
      token: controlToken,
      entries: manifest.changelog_entries,
    });
    const releaseSha = changelogRelease.mergeSha;
    const releaseNotes = manifest.release_notes || changelogRelease.notes;

    const provenance = [
      `Source: https://github.com/${sourceRepository}/commit/${sourceSha}`,
      `Artifact run: https://github.com/${artifactRepository}/actions/runs/${artifactRunId}`,
      ...(ciRunId
        ? [`CI dispatch run: https://github.com/${sourceRepository}/actions/runs/${ciRunId}`]
        : []),
      `Central CI Evidence: success`,

      `Main Write Guard: success via PR #${mainWrite.pr_number}`,
      `Request: ${requestId}`,
      `License: ${licenseExpression}`,
      ...(licenseFile ? [`License file: ${licenseFile}`] : []),
    ].join("\n");
    const body = releaseNotes ? `${releaseNotes}\n\n${provenance}` : provenance;

    // A draft Release holds no Git tag. The tag is created from target_commitish only when the
    // verified draft is published below, so a failed release leaves no formal tag behind.
    const releaseJson = JSON.parse(
      await runGithubCli(
        [
          "api",
          "--method",
          "POST",
          `repos/${targetRepository}/releases`,
          "-f",
          `tag_name=${tag}`,
          "-f",
          `target_commitish=${releaseSha}`,
          "-f",
          `name=${name}`,
          "-f",
          `body=${body}`,
          "-F",
          `prerelease=${isPrerelease}`,
          "-F",
          "draft=true",
        ],
        controlToken
      )
    ) as unknown;
    releaseId = String(getJsonNumber(releaseJson, "id"));
    const releaseUrl = getJsonString(releaseJson, "html_url");
    isReleaseCreated = true;

    const uploadFiles = (
      await listRootFiles(artifactDir, ["release-manifest.json", "release-provenance.json"])
    ).map((file) => join(artifactDir, file));
    await runGithubCli(
      ["release", "upload", tag, ...uploadFiles, "--repo", targetRepository],
      controlToken
    );

    const expectedReleaseNames = manifest.assets
      .flatMap((asset) => [asset.name, `${asset.name}.sha256`])
      .sort();
    const publishedJson = await getGithubJson(
      `repos/${targetRepository}/releases/${releaseId}/assets?per_page=100`,
      controlToken
    );
    const actualReleaseNames = getJsonArray(publishedJson)
      .map((asset) => getJsonString(asset, "name"))
      .sort();
    if (!sameNames(actualReleaseNames, expectedReleaseNames)) {
      throw new CliError(
        "::error::Published Release assets do not match the validated manifest.",
        66
      );
    }

    const verifyDir = join(workDir, "verify");
    await mkdir(verifyDir);
    await runGithubCli(
      ["release", "download", tag, "--repo", targetRepository, "--dir", verifyDir],
      controlToken
    );
    for (const asset of manifest.assets) {
      const downloaded = join(verifyDir, asset.name);
      const checksumPath = join(verifyDir, `${asset.name}.sha256`);
      let checksum = "";
      try {
        checksum =
          (await readFile(checksumPath, "utf8")).trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
        await access(downloaded);
      } catch {
        throw new CliError(
          `::error::Downloaded Release is missing asset or checksum: ${asset.name}.`,
          66
        );
      }
      const actualHash = await sha256File(downloaded);
      if (actualHash !== asset.sha256 || checksum !== asset.sha256) {
        throw new CliError(
          `::error::Published Release checksum verification failed: ${asset.name}.`,
          66
        );
      }
    }

    // Publishing the verified draft is the only step that creates the tag, at releaseSha.
    await runGithubCli(
      [
        "api",
        "--method",
        "PATCH",
        `repos/${targetRepository}/releases/${releaseId}`,
        "-F",
        "draft=false",
      ],
      controlToken
    );

    isReleaseCreated = false;

    const npmToken = (process.env.AW_NPM_TOKEN ?? process.env.NPM_TOKEN)?.trim();
    const tgzAsset = manifest.assets.find((a) => a.name.endsWith(".tgz"));
    let npmPublishStatus = "skipped";
    if (npmToken && tgzAsset) {
      const tgzPath = join(verifyDir, tgzAsset.name);
      const isBeta = manifest.version.includes("-beta.");
      const publishArgs = ["publish", tgzPath, "--access", "public"];
      if (isBeta) {
        publishArgs.push("--tag", "beta");
      }
      try {
        await runCommand("npm", publishArgs, {
          env: {
            ...process.env,
            NODE_AUTH_TOKEN: npmToken,
            npm_config_registry: "https://registry.npmjs.org/",
            npm_config__authToken: npmToken,
          },
        });
        npmPublishStatus = `published (${tgzAsset.name})`;
      } catch (err) {
        console.warn(
          `::warning::npm publish failed: ${err instanceof Error ? err.message : String(err)}`
        );
        npmPublishStatus = "failed";
      }
    }

    await appendLines(process.env.GITHUB_OUTPUT, [
      `tag=${tag}`,
      `release_url=${releaseUrl}`,
      `target_repository=${targetRepository}`,
      `release_key=${manifest.release_key}`,
      `version=${manifest.version}`,
    ]);
    await appendLines(process.env.GITHUB_STEP_SUMMARY, [
      "## Release Governance",
      "",
      `- Source: ${sourceRepository}@${sourceSha}`,
      `- Artifact: ${artifactRepository}@run-${artifactRunId}`,
      ...(ciRunId ? [`- CI dispatch run: ${ciRunId}`] : []),
      `- Central CI Evidence: success`,

      `- Main Write Guard: success via PR #${mainWrite.pr_number}`,
      `- Target: ${targetRepository}@${releaseSha}`,
      `- Tag: ${tag}`,
      `- License: ${licenseExpression}`,
      ...(licenseFile ? [`- License file: ${licenseFile}`] : []),
      `- URL: ${releaseUrl}`,
      ...(npmPublishStatus !== "skipped" ? [`- npm publish: ${npmPublishStatus}`] : []),
    ]);
  } catch (error) {
    await rollbackRelease(targetRepository, tag, releaseId, isReleaseCreated, controlToken);
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
