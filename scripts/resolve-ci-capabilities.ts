import { parseExecutionManifest } from "./execution-contract.ts";
import { getGithubJson, getJsonString, githubExists, isGithubMissing } from "./github-api.ts";
import { appendLines, CliError, handleError, isMain, parseJson } from "./runtime-command.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const refPattern = /^(?:[0-9a-f]{40}|[A-Za-z0-9._/-]+)$/;
const shardPattern = /^[a-z][a-z0-9-]{0,31}$/;
const maxLinuxShards = 8;

// The value the workflow uses when the trusted manifest declares no shards: one Linux job that
// runs the whole project script without a shard argument.
export const unshardedLinuxCi = "all";

export function resolveLinuxShards(manifestValue: unknown): string[] {
  const manifest = parseExecutionManifest(manifestValue);
  const job = manifest.operations.ci?.jobs.find((item) => item.id === "linux");
  const matrix = job?.matrix;
  if (!matrix) {
    return [unshardedLinuxCi];
  }
  const shards = matrix.shard;
  if (Object.keys(matrix).some((key) => key !== "shard") || !shards) {
    throw new CliError("The Linux CI job matrix supports only the shard key.", 65);
  }
  if (shards.length > maxLinuxShards) {
    throw new CliError(`The Linux CI job declares more than ${maxLinuxShards} shards.`, 65);
  }
  for (const shard of shards) {
    if (!shardPattern.test(shard) || shard === unshardedLinuxCi) {
      throw new CliError(`Invalid Linux CI shard name: ${shard}.`, 65);
    }
  }
  return shards;
}

async function readTrustedManifest(
  repository: string,
  encodedRef: string,
  token: string
): Promise<unknown> {
  let response: unknown;
  try {
    response = await getGithubJson(
      `repos/${repository}/contents/.github/execution-manifest.json?ref=${encodedRef}`,
      token
    );
  } catch (error) {
    if (isGithubMissing(error)) {
      return undefined;
    }
    throw error;
  }
  return parseJson(
    Buffer.from(getJsonString(response, "content"), "base64").toString("utf8"),
    "The trusted Execution Manifest is not valid JSON.",
    65
  );
}

export async function resolveCiCapabilities(
  repository: string,
  controlRef: string,
  token: string
): Promise<{ has_windows: boolean; linux_shards: string[] }> {
  if (!repositoryPattern.test(repository)) {
    throw new CliError(`Invalid repository: ${repository}.`, 64);
  }
  if (!controlRef || !refPattern.test(controlRef) || controlRef.includes("..")) {
    throw new CliError("Invalid trusted control ref.", 64);
  }
  if (!token) {
    throw new CliError("AW_CONTROL_TOKEN is required.", 64);
  }

  const ref = encodeURIComponent(controlRef);
  const hasWindows = await githubExists(
    `repos/${repository}/contents/.github/scripts/central-ci.ps1?ref=${ref}`,
    token
  );
  const manifest = await readTrustedManifest(repository, ref, token);
  return {
    has_windows: hasWindows,
    linux_shards: manifest === undefined ? [unshardedLinuxCi] : resolveLinuxShards(manifest),
  };
}

async function main(): Promise<void> {
  const [repository = "", controlRef = ""] = process.argv.slice(2);
  const token = process.env.AW_CONTROL_TOKEN ?? "";
  const capabilities = await resolveCiCapabilities(repository, controlRef, token);
  await appendLines(process.env.GITHUB_OUTPUT, [
    `has_windows=${capabilities.has_windows}`,
    `linux_shards=${JSON.stringify(capabilities.linux_shards)}`,
  ]);
  console.log(JSON.stringify(capabilities));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
