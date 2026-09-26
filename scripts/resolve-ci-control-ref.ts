import {
  getGithubJson,
  getJsonArray,
  getJsonString,
  isJsonRecord,
} from "./github-api.ts";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
} from "./runtime-command.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;
const refPattern = /^[A-Za-z0-9._/-]+$/;

const CONTROL_PATHS = new Set([
  ".github/execution-manifest.json",
  ".github/scripts/central-ci.sh",
  ".github/scripts/central-ci.ps1",
]);

const TRUSTED_ASSOCIATIONS = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

type ControlDecision = {
  candidate_control: boolean;
  control_changed: boolean;
  control_ref: string;
};

export function resolveCiControlDecision(
  repository: string,
  expectedHeadSha: string,
  pull: unknown,
  changedFiles: readonly string[],
): ControlDecision {
  if (!repositoryPattern.test(repository)) {
    throw new CliError(`Invalid repository: ${repository}.`, 64);
  }
  if (!shaPattern.test(expectedHeadSha)) {
    throw new CliError("Expected head SHA must be a full commit SHA.", 64);
  }
  if (!isJsonRecord(pull) || pull.state !== "open") {
    throw new CliError("Target PR is not open.", 65);
  }

  const base = isJsonRecord(pull.base) ? pull.base : {};
  const head = isJsonRecord(pull.head) ? pull.head : {};
  const headRepo = isJsonRecord(head.repo) ? getJsonString(head.repo, "full_name") : "";
  const baseRef = getJsonString(base, "ref");
  const headSha = getJsonString(head, "sha");
  const association = getJsonString(pull, "author_association").toUpperCase();

  if (!refPattern.test(baseRef) || baseRef.includes("..")) {
    throw new CliError("PR base ref is invalid.", 65);
  }
  if (!shaPattern.test(headSha) || headSha !== expectedHeadSha) {
    throw new CliError("PR head changed before CI control resolution.", 75);
  }

  const controlChanged = changedFiles.some((path) => CONTROL_PATHS.has(path));
  if (!controlChanged) {
    return {
      candidate_control: false,
      control_changed: false,
      control_ref: baseRef,
    };
  }

  if (headRepo !== repository || !TRUSTED_ASSOCIATIONS.has(association)) {
    throw new CliError(
      "CI control changes require a trusted same-repository maintainer PR.",
      65,
    );
  }

  return {
    candidate_control: true,
    control_changed: true,
    control_ref: headSha,
  };
}

async function changedFiles(
  repository: string,
  prNumber: string,
  token: string,
): Promise<string[]> {
  const files: string[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await getGithubJson(
      `repos/${repository}/pulls/${prNumber}/files?per_page=100&page=${page}`,
      token,
    );
    const rows = getJsonArray(response);
    for (const row of rows) {
      if (!isJsonRecord(row)) {
        throw new CliError("GitHub API returned an invalid PR file row.", 65);
      }
      const filename = getJsonString(row, "filename");
      if (!filename) {
        throw new CliError("GitHub API returned a PR file without a filename.", 65);
      }
      files.push(filename);
    }
    if (rows.length < 100) {
      return files;
    }
  }
  throw new CliError("PR file list exceeds the supported pagination limit.", 65);
}

async function main(): Promise<void> {
  const [repository = "", prNumber = "", expectedHeadSha = ""] = process.argv.slice(2);
  const token = process.env.AW_CONTROL_TOKEN ?? "";
  if (!repository || !prNumber || !token) {
    throw new CliError(
      "Usage: resolve-ci-control-ref.ts <repository> <pr-number> <expected-head-sha>",
      64,
    );
  }

  const pull = await getGithubJson(`repos/${repository}/pulls/${prNumber}`, token);
  const decision = resolveCiControlDecision(
    repository,
    expectedHeadSha,
    pull,
    await changedFiles(repository, prNumber, token),
  );

  await appendLines(process.env.GITHUB_OUTPUT, [
    `candidate_control=${decision.candidate_control}`,
    `control_changed=${decision.control_changed}`,
    `control_ref=${decision.control_ref}`,
  ]);
  console.log(JSON.stringify(decision));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
