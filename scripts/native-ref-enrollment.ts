import { readFileSync } from "node:fs";
import { isJsonRecord } from "./github-api.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const path = ".github/workflows/private-ref-ci.yml";

export function resolveNativePrivateRef(
  policy: unknown,
  repository: string,
  privateFlag: string,
  eventAction: string,
  prNumber: string
): boolean {
  if (
    !repositoryPattern.test(repository) ||
    (privateFlag !== "true" && privateFlag !== "false") ||
    !/^(?:0|[1-9][0-9]*)$/.test(prNumber)
  ) {
    throw new CliError("Invalid private ref CI enrollment identity.", 65);
  }
  if (!isJsonRecord(policy) || policy.schema_version !== 1 || !Array.isArray(policy.callers)) {
    throw new CliError("Invalid private ref CI enrollment policy.", 65);
  }
  const names = new Set<string>();
  for (const entry of policy.callers) {
    if (
      !isJsonRecord(entry) ||
      !repositoryPattern.test(entry.repository as string) ||
      entry.path !== path ||
      typeof entry.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      names.has(entry.repository as string)
    ) {
      throw new CliError("Invalid or duplicated private ref CI caller policy.", 65);
    }
    names.add(entry.repository as string);
  }
  if (names.size === 0) throw new CliError("Private ref caller allowlist is empty.", 65);
  return (
    privateFlag === "true" &&
    eventAction === "run-central-ci-ref" &&
    prNumber === "0" &&
    names.has(repository)
  );
}

async function main(): Promise<void> {
  const [repository = "", privateFlag = "", eventAction = "", prNumber = ""] =
    process.argv.slice(2);
  const policy: unknown = JSON.parse(readFileSync("policies/private-ref-callers.json", "utf8"));
  const enabled = resolveNativePrivateRef(policy, repository, privateFlag, eventAction, prNumber);
  await appendLines(process.env.GITHUB_OUTPUT, [`enabled=${enabled}`]);
  console.log(`Private main source CI evidence enabled: ${enabled}`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
