import { lstat, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { isJsonRecord } from "./github-api.ts";
import { parseRepositoryPolicy, validateRepositoryCapability } from "./repository-policy.ts";
import { CliError, appendLines, handleError, isMain, parseJson, readJson } from "./runtime-command.ts";

type Publication = {
  schema_version: "1";
  target_repository: string;
  dest_dir: string;
  delete_stale: boolean;
  commit_message: string;
};

function validateManifest(value: unknown): Publication {
  if (!isJsonRecord(value)) {
    throw new CliError("::error::Task publication manifest must be a JSON object.", 64);
  }
  const keys = Object.keys(value).sort();
  const expected = ["commit_message", "delete_stale", "dest_dir", "schema_version", "target_repository"];
  if (keys.length !== expected.length || !keys.every((key, index) => key === expected[index])) {
    throw new CliError("::error::Task publication manifest fields are invalid.", 64);
  }
  if (
    value.schema_version !== "1"
    || typeof value.target_repository !== "string"
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.target_repository)
    || typeof value.dest_dir !== "string"
    || typeof value.delete_stale !== "boolean"
    || typeof value.commit_message !== "string"
    || value.commit_message.length < 1
    || value.commit_message.length > 160
    || /[\r\n]/.test(value.commit_message)
  ) {
    throw new CliError("::error::Task publication manifest values are invalid.", 64);
  }
  const destDir = value.dest_dir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!destDir || destDir.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new CliError("::error::Task publication destination is invalid.", 64);
  }
  return {
    schema_version: "1",
    target_repository: value.target_repository,
    dest_dir: destDir,
    delete_stale: value.delete_stale,
    commit_message: value.commit_message,
  };
}

async function validatePayload(root: string, current = root): Promise<number> {
  let count = 0;
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw new CliError("::error::Task publication payload must not contain symlinks.", 66);
    }
    if (stats.isDirectory()) {
      count += await validatePayload(root, path);
    } else if (stats.isFile()) {
      const name = relative(root, path).split(sep).join("/");
      if (!name || name.startsWith("../") || stats.size > 50 * 1024 * 1024) {
        throw new CliError("::error::Task publication payload file is invalid.", 66);
      }
      count += 1;
    } else {
      throw new CliError("::error::Task publication payload contains an unsupported entry.", 66);
    }
    if (count > 2000) {
      throw new CliError("::error::Task publication payload exceeds 2000 files.", 66);
    }
  }
  return count;
}

async function main(): Promise<void> {
  const runnerTemp = process.env.RUNNER_TEMP ?? "";
  const sourceRepository = process.env.AW_EXECUTION_REPOSITORY ?? "";
  if (!runnerTemp || !sourceRepository) {
    throw new CliError("::error::Task publication runtime context is missing.", 65);
  }

  const root = join(runnerTemp, "action-worker-publication");
  const manifestPath = join(root, "manifest.json");
  try {
    await lstat(manifestPath);
  } catch {
    await appendLines(process.env.GITHUB_OUTPUT, ["staged=false"]);
    console.log("No task publication staged.");
    return;
  }

  const rawPolicy = process.env.AW_REPOSITORY_POLICY ?? "";
  if (!rawPolicy) {
    throw new CliError("::error::AW_REPOSITORY_POLICY is required for task publication.", 65);
  }
  const policy = parseRepositoryPolicy(
    parseJson(rawPolicy, "::error::AW_REPOSITORY_POLICY must be valid JSON.", 65),
  );
  const manifest = validateManifest(await readJson(manifestPath));
  validateRepositoryCapability(sourceRepository, policy, "release-source");
  validateRepositoryCapability(manifest.target_repository, policy, "release-target");

  const payloadDir = join(root, "payload");
  const payloadStats = await lstat(payloadDir).catch(() => null);
  if (!payloadStats?.isDirectory() || payloadStats.isSymbolicLink()) {
    throw new CliError("::error::Task publication payload directory is missing.", 66);
  }
  const fileCount = await validatePayload(payloadDir);
  if (fileCount < 1) {
    throw new CliError("::error::Task publication payload is empty.", 66);
  }

  await appendLines(process.env.GITHUB_OUTPUT, [
    "staged=true",
    `target_repository=${manifest.target_repository}`,
    `dest_dir=${manifest.dest_dir}`,
    `delete_stale=${manifest.delete_stale}`,
    `commit_message=${manifest.commit_message}`,
    `payload_dir=${payloadDir}`,
  ]);
  console.log(`Task publication validated: ${sourceRepository} -> ${manifest.target_repository}/${manifest.dest_dir}`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
