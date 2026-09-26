import {
  GithubReader,
  getJsonString,
  runGithubCli,
} from "./github-api.ts";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
  parseJson,
} from "./runtime-command.ts";
import { repositoriesForCapability } from "./repository-policy.ts";
import { validateMainWriteProvenance } from "./main-write-guard.ts";

type AuditResult = {
  repository: string;
  main_sha: string;
  state: "success" | "failure";
  detail: string;
};

const shaPattern = /^[0-9a-f]{40}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

async function publishGuardStatus(
  repository: string,
  sha: string,
  token: string,
  state: "success" | "failure",
  description: string,
  runUrl: string,
): Promise<void> {
  const args = [
    "api", "--method", "POST",
    `repos/${repository}/statuses/${sha}`,
    "-f", `state=${state}`,
    "-f", "context=Main Write Guard",
    "-f", `description=${description}`,
  ];
  if (runUrl) {
    args.push("-f", `target_url=${runUrl}`);
  }
  await runGithubCli(args, token);
}

export async function auditRepositoryMain(
  reader: GithubReader,
  repository: string,
  isCentralStatusRequired = true,
): Promise<{ main_sha: string; pr_number: number }> {
  const repositoryValue = await reader.get(`repos/${repository}`);
  const defaultBranch = getJsonString(repositoryValue, "default_branch");
  if (defaultBranch !== "main") {
    throw new CliError(`::error::Managed repository default branch must be main: ${repository}.`, 65);
  }
  const mainCommit = await reader.get(`repos/${repository}/commits/main`);
  const mainSha = getJsonString(mainCommit, "sha");
  if (!shaPattern.test(mainSha)) {
    throw new CliError(`::error::Managed repository main SHA is invalid: ${repository}.`, 65);
  }
  const provenance = await validateMainWriteProvenance(
    reader,
    repository,
    mainSha,
    isCentralStatusRequired,
  );
  return { main_sha: mainSha, pr_number: provenance.pr_number };
}

async function main(): Promise<void> {
  const token = process.env.AW_CONTROL_TOKEN ?? "";
  const rawPolicy = process.env.AW_REPOSITORY_POLICY ?? "";
  const runUrl = process.env.MAIN_WRITE_AUDIT_RUN_URL ?? "";
  const controlRepository = process.env.GITHUB_REPOSITORY ?? "";
  if (!token) {
    throw new CliError("::error::AW_CONTROL_TOKEN is required.", 77);
  }
  if (!rawPolicy) {
    throw new CliError("::error::AW_REPOSITORY_POLICY is required.", 65);
  }
  if (!repositoryPattern.test(controlRepository)) {
    throw new CliError("::error::GITHUB_REPOSITORY is required for Main Write Audit.", 65);
  }

  const policy = parseJson(rawPolicy, "::error::AW_REPOSITORY_POLICY must be valid JSON.", 65);
  const repositories = repositoriesForCapability(policy, "pr");
  if (repositories.length === 0) {
    throw new CliError("::error::No managed PR repositories are configured.", 65);
  }

  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
  const results: AuditResult[] = [];

  for (const repository of repositories) {
    let mainSha = "";
    try {
      const repositoryValue = await reader.get(`repos/${repository}`);
      const defaultBranch = getJsonString(repositoryValue, "default_branch");
      if (defaultBranch !== "main") {
        throw new CliError(`::error::Managed repository default branch must be main: ${repository}.`, 65);
      }
      const mainCommit = await reader.get(`repos/${repository}/commits/main`);
      mainSha = getJsonString(mainCommit, "sha");
      if (!shaPattern.test(mainSha)) {
        throw new CliError(`::error::Managed repository main SHA is invalid: ${repository}.`, 65);
      }

      const provenance = await validateMainWriteProvenance(
        reader,
        repository,
        mainSha,
        repository !== controlRepository,
      );
      await publishGuardStatus(
        repository,
        mainSha,
        token,
        "success",
        `Trusted main write via PR #${provenance.pr_number}`,
        runUrl,
      );
      results.push({
        repository,
        main_sha: mainSha,
        state: "success",
        detail: `PR #${provenance.pr_number}`,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message.replace(/^::error::/, "") : String(error);
      if (shaPattern.test(mainSha)) {
        try {
          await publishGuardStatus(repository, mainSha, token, "failure", "Untrusted main write", runUrl);
        } catch {
          // Keep the provenance failure authoritative.
        }
      }
      results.push({
        repository,
        main_sha: mainSha || "unknown",
        state: "failure",
        detail,
      });
    }
  }

  await appendLines(process.env.GITHUB_STEP_SUMMARY, [
    "## Main Write Audit",
    "",
    "| Repository | Main SHA | Result | Detail |",
    "|---|---|---|---|",
    ...results.map((item) =>
      `| ${item.repository} | ${item.main_sha} | ${item.state} | ${item.detail.replace(/\|/g, "\\|")} |`),
  ]);

  const failures = results.filter((item) => item.state === "failure");
  if (failures.length > 0) {
    throw new CliError(
      `::error::Main Write Audit failed for ${failures.length} repository/repositories: ${failures.map((item) => item.repository).join(", ")}.`,
      1,
    );
  }

  console.log(`Main Write Audit passed for ${results.length} repositories.`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
