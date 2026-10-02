import { join } from "node:path";
import { getJsonString, isJsonRecord } from "./github-api.ts";
import { appendLines, CliError, handleError, isMain, readJson } from "./runtime-command.ts";

async function main(): Promise<void> {
  const policyPath = process.argv[2] ?? "";
  const policy = await readJson(policyPath);
  const engine = isJsonRecord(policy) && isJsonRecord(policy.engine) ? policy.engine : {};
  const repository = getJsonString(engine, "repository");
  const version = getJsonString(engine, "version");
  const asset = getJsonString(engine, "asset");
  // Pinned in policy rather than read from the release, so a replaced release asset and its
  // replaced checksum file cannot vouch for each other.
  const sha256 = getJsonString(engine, "sha256");
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version) ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(asset) ||
    !/^[0-9a-f]{64}$/.test(sha256)
  ) {
    throw new CliError("::error::Invalid OCR distribution policy.", 65);
  }
  const home = process.env.HOME ?? "";
  if (!home) {
    throw new CliError("::error::HOME is required.", 65);
  }
  await appendLines(process.env.GITHUB_OUTPUT, [
    `repository=${repository}`,
    `version=${version}`,
    `asset=${asset}`,
    `sha256=${sha256}`,
    `cache_dir=${join(home, ".cache", "action-worker", "ocr", version)}`,
  ]);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
