import { hasVerifiedCiEvidence } from "./ci-evidence.ts";
import { statusAwareReader } from "./github-api.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";
import { requireStatusToken } from "./status-attestation.ts";

async function main(): Promise<void> {
  const [repository = "", sha = ""] = process.argv.slice(2);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new CliError("Usage: should-run-central-ci.ts <repository> <sha>", 64);
  }
  const controlToken = process.env.AW_CONTROL_TOKEN ?? "";
  const controlRepository = process.env.GITHUB_REPOSITORY ?? "";
  const statusToken = requireStatusToken();
  if (!controlToken || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(controlRepository)) {
    throw new CliError("AW_CONTROL_TOKEN and GITHUB_REPOSITORY are required.", 77);
  }
  const reader = statusAwareReader(
    process.env.GITHUB_API_URL ?? "https://api.github.com",
    controlToken,
    statusToken
  );
  const response = await reader.get(`repos/${repository}/commits/${sha}/status`);
  const alreadyPassed = await hasVerifiedCiEvidence(reader, response, {
    controlRepository,
    targetRepository: repository,
    targetSha: sha,
    statusToken,
    runAttempts: 1,
    retryDelayMs: 0,
  });
  console.log(alreadyPassed ? "false" : "true");
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
