import { githubExists } from "./github-api.ts";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
} from "./runtime-command.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const refPattern = /^(?:[0-9a-f]{40}|[A-Za-z0-9._/-]+)$/;

export async function resolveCiCapabilities(
  repository: string,
  controlRef: string,
  token: string,
): Promise<{ has_windows: boolean }> {
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
    token,
  );
  return { has_windows: hasWindows };
}

async function main(): Promise<void> {
  const [repository = "", controlRef = ""] = process.argv.slice(2);
  const token = process.env.AW_CONTROL_TOKEN ?? "";
  const capabilities = await resolveCiCapabilities(repository, controlRef, token);
  await appendLines(process.env.GITHUB_OUTPUT, [
    `has_windows=${capabilities.has_windows}`,
  ]);
  console.log(JSON.stringify(capabilities));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
