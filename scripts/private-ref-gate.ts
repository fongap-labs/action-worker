import { GithubReader } from "./github-api.ts";
import {
  fetchAndVerifyPrivateRef,
  type PrivateRefIdentity,
} from "./private-ref-evidence.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;
const shardPattern = /^[a-z][a-z0-9-]{0,31}$/;

export function parsePrivateRefArgs(args: readonly string[]): PrivateRefIdentity {
  if (args.length !== 5) {
    throw new CliError(
      "Usage: private-ref-gate.ts <owner/repo> <before-sha> <head-sha> <linux-shards-json> <has-windows>",
      64
    );
  }
  const [repository = "", beforeSha = "", headSha = "", shardsRaw = "", windows = ""] = args;
  if (
    !repositoryPattern.test(repository) ||
    !shaPattern.test(beforeSha) ||
    !shaPattern.test(headSha) ||
    beforeSha === headSha ||
    (windows !== "true" && windows !== "false")
  ) {
    throw new CliError("Invalid private main CI identity.", 64);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(shardsRaw) as unknown;
  } catch {
    throw new CliError("Invalid private main Linux shard declaration.", 64);
  }
  if (
    !Array.isArray(raw) ||
    raw.length < 1 ||
    raw.length > 8 ||
    !raw.every((item) => typeof item === "string" && shardPattern.test(item)) ||
    new Set(raw).size !== raw.length
  ) {
    throw new CliError("Invalid private main Linux shard declaration.", 64);
  }
  return {
    repository,
    headSha,
    beforeSha,
    linuxShards: raw as string[],
    hasWindows: windows === "true",
  };
}

async function main(): Promise<void> {
  const token = process.env.AW_NATIVE_PRIVATE_CI_READ_TOKEN ?? "";
  if (!token) throw new CliError("Private main CI requires a scoped read token.", 77);
  const request = parsePrivateRefArgs(process.argv.slice(2));
  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
  const result = await fetchAndVerifyPrivateRef(reader, request);
  await appendLines(process.env.GITHUB_OUTPUT, [
    "native_private_ref_verified=true",
    `native_private_ref_run_id=${result.runId}`,
    `native_private_ref_attempt=${result.runAttempt}`,
  ]);
  console.log(JSON.stringify({ verified: true, runId: result.runId, attempt: result.runAttempt }));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
