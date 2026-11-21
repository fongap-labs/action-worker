import { readFileSync } from "node:fs";
import { isJsonRecord } from "./github-api.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const workflowPath = ".github/workflows/private-ref-ci.yml";

export function resolveNativeRefEnrollment(
  policy: unknown,
  repository: string,
  privateFlag: string,
  eventAction: string,
  prNumber: string
): boolean {
  if (
    !repositoryPattern.test(repository) ||
    repository.split("/").some((segment) => segment === "." || segment.includes("..")) ||
    (privateFlag !== "true" && privateFlag !== "false") ||
    !/^(?:0|[1-9][0-9]*)$/.test(prNumber)
  ) {
    throw new CliError("Invalid private main CI enrollment identity.", 65);
  }
  if (
    !isJsonRecord(policy) ||
    policy.schema_version !== 1 ||
    !Array.isArray(policy.callers) ||
    policy.callers.length > 20
  ) {
    throw new CliError("Invalid private main CI enrollment policy.", 65);
  }
  const seen = new Set<string>();
  for (const item of policy.callers) {
    if (
      !isJsonRecord(item) ||
      typeof item.repository !== "string" ||
      !repositoryPattern.test(item.repository) ||
      item.repository.split("/").some((segment) => segment === "." || segment.includes("..")) ||
      item.path !== workflowPath ||
      typeof item.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(item.sha256) ||
      seen.has(item.repository)
    ) {
      throw new CliError("Private main CI caller allowlist is invalid.", 65);
    }
    seen.add(item.repository as string);
  }
  return (
    privateFlag === "true" &&
    eventAction === "run-central-ci-ref" &&
    prNumber === "0" &&
    seen.has(repository)
  );
}

async function main(): Promise<void> {
  const [repository = "", privateFlag = "", eventAction = "", prNumber = ""] =
    process.argv.slice(2);
  const policy: unknown = JSON.parse(
    readFileSync("policies/private-ref-callers.json", "utf8")
  ) as unknown;
  const enabled = resolveNativeRefEnrollment(
    policy,
    repository,
    privateFlag,
    eventAction,
    prNumber
  );
  await appendLines(process.env.GITHUB_OUTPUT, [`enabled=${enabled}`]);
  console.log(`Private source-owned main evidence enrolled: ${enabled}`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
