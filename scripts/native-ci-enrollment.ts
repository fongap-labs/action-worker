import { readFileSync } from "node:fs";
import { isJsonRecord } from "./github-api.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function resolveNativeCiPilot(
  rawPolicy: unknown,
  repository: string,
  privateFlag: string,
  eventAction: string,
  prNumber: string
): boolean {
  if (
    !repositoryPattern.test(repository) ||
    (privateFlag !== "true" && privateFlag !== "false") ||
    !/^(?:[1-9][0-9]*|0)$/.test(prNumber)
  ) {
    throw new CliError("Invalid native private CI pilot identity.", 65);
  }
  if (
    !isJsonRecord(rawPolicy) ||
    rawPolicy.schema_version !== 1 ||
    !Array.isArray(rawPolicy.repositories) ||
    rawPolicy.repositories.some(
      (name: unknown) => typeof name !== "string" || !repositoryPattern.test(name)
    ) ||
    new Set(rawPolicy.repositories).size !== rawPolicy.repositories.length
  ) {
    throw new CliError("Invalid native private CI pilot policy.", 65);
  }
  return (
    privateFlag === "true" &&
    eventAction === "run-central-ci" &&
    /^[1-9][0-9]*$/.test(prNumber) &&
    rawPolicy.repositories.includes(repository)
  );
}

async function main(): Promise<void> {
  const [repository = "", privateFlag = "", eventAction = "", prNumber = ""] =
    process.argv.slice(2);
  const raw: unknown = JSON.parse(readFileSync("policies/private-ci-pilots.json", "utf8"));
  const enabled = resolveNativeCiPilot(raw, repository, privateFlag, eventAction, prNumber);
  await appendLines(process.env.GITHUB_OUTPUT, [`enabled=${enabled}`]);
  console.log(`Private native evidence pilot enabled: ${enabled}`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
