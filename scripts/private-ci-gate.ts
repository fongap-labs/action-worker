import { GithubReader } from "./github-api.ts";
import {
  fetchAndVerifyPrivateCiForPull,
  type NativePrivateCiRequest,
} from "./private-ci-evidence.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

const shaPattern = /^[0-9a-f]{40}$/;
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function parseNativePrivateCiArgs(args: readonly string[]): NativePrivateCiRequest {
  if (args.length !== 7) {
    throw new CliError(
      "Usage: private-ci-gate.ts <owner/repository> <pr> <base-sha> <head-sha> <merge-sha> <linux-shards-json> <has-windows>",
      64
    );
  }
  const [
    repository = "",
    pr = "",
    baseSha = "",
    headSha = "",
    mergeSha = "",
    rawShards = "",
    windows = "",
  ] = args;
  if (
    !repoPattern.test(repository) ||
    !/^[1-9][0-9]*$/.test(pr) ||
    !Number.isSafeInteger(Number(pr)) ||
    !shaPattern.test(baseSha) ||
    !shaPattern.test(headSha) ||
    !shaPattern.test(mergeSha) ||
    (windows !== "true" && windows !== "false")
  ) {
    throw new CliError("Invalid native private CI identity arguments.", 64);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawShards) as unknown;
  } catch {
    throw new CliError("Invalid native private CI Linux shard manifest.", 64);
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length < 1 ||
    decoded.length > 8 ||
    !decoded.every((item) => typeof item === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(item)) ||
    new Set(decoded).size !== decoded.length
  ) {
    throw new CliError("Invalid native private CI Linux shard manifest.", 64);
  }
  return {
    repository,
    prNumber: Number(pr),
    baseSha,
    headSha,
    mergeSha,
    linuxShards: decoded as string[],
    hasWindows: windows === "true",
  };
}

async function main(): Promise<void> {
  const token = process.env.AW_NATIVE_PRIVATE_CI_READ_TOKEN ?? "";
  if (!token) {
    throw new CliError("Native private CI requires a narrowly scoped source-read token.", 77);
  }
  const request = parseNativePrivateCiArgs(process.argv.slice(2));
  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
  const result = await fetchAndVerifyPrivateCiForPull(reader, request);
  await appendLines(process.env.GITHUB_OUTPUT, [
    `native_private_ci_verified=true`,
    `native_private_ci_run_id=${result.runId}`,
    `native_private_ci_attempt=${result.runAttempt}`,
  ]);
  console.log(JSON.stringify({ verified: true, runId: result.runId, attempt: result.runAttempt }));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
