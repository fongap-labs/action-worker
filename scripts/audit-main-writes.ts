import { GithubReader, getJsonString, runGithubCli } from "./github-api.ts";
import {
  MainWriteVerificationPendingError,
  validateMainWriteProvenance,
} from "./main-write-guard.ts";
import {
  assertNoOpenMainWriteIncidents,
  closeExpiredIncidents,
  IncidentAccessError,
  incidentTitle,
  shouldCreateIncident,
} from "./main-write-incidents.ts";
import { repositoriesForCapability } from "./repository-policy.ts";
import { appendLines, CliError, handleError, isMain, parseJson } from "./runtime-command.ts";

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
  state: "success" | "failure" | "pending",
  description: string,
  runUrl: string
): Promise<void> {
  const args = [
    "api",
    "--method",
    "POST",
    `repos/${repository}/statuses/${sha}`,
    "-f",
    `state=${state}`,
    "-f",
    "context=Main Write Guard",
    "-f",
    `description=${description}`,
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
  isIncidentBypassEnabled = false
): Promise<{ main_sha: string; pr_number: number }> {
  const repositoryValue = await reader.get(`repos/${repository}`);
  const defaultBranch = getJsonString(repositoryValue, "default_branch");
  if (defaultBranch !== "main") {
    throw new CliError(
      `::error::Managed repository default branch must be main: ${repository}.`,
      65
    );
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
    isCentralStatusRequired
  );
  if (!isIncidentBypassEnabled) {
    await assertNoOpenMainWriteIncidents(reader, repository);
  }
  return { main_sha: mainSha, pr_number: provenance.pr_number };
}

export function requireAuditCredential(
  name: "AW_STATUS_TOKEN" | "AW_ISSUE_TOKEN" | "AW_CONTROL_TOKEN",
  permission: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const token = env[name] ?? "";
  if (!token) {
    throw new CliError(
      `::error::Missing required secret ${name}. Configure it in fongap-labs/action-worker → Settings → Secrets and variables → Actions. Required permissions: ${permission} on each managed repository. No token fallback is allowed.`,
      77
    );
  }
  return token;
}

async function main(): Promise<void> {
  const statusToken = requireAuditCredential(
    "AW_STATUS_TOKEN",
    "Commit statuses: Read and write"
  );
  const issueToken = requireAuditCredential("AW_ISSUE_TOKEN", "Issues: Read and write");
  const controlToken = requireAuditCredential("AW_CONTROL_TOKEN", "managed repository reads");
  const rawPolicy = process.env.AW_REPOSITORY_POLICY ?? "";
  const runUrl = process.env.MAIN_WRITE_AUDIT_RUN_URL ?? "";
  const controlRepository = process.env.GITHUB_REPOSITORY ?? "";
  if (!controlToken) {
    throw new CliError("::error::AW_CONTROL_TOKEN is required.", 77);
  }
  if (!rawPolicy) {
    throw new CliError("::error::AW_REPOSITORY_POLICY is required.", 65);
  }
  if (!repositoryPattern.test(controlRepository)) {
    throw new CliError("::error::GITHUB_REPOSITORY is required for Main Write Audit.", 65);
  }

  const policy = parseJson(rawPolicy, "::error::AW_REPOSITORY_POLICY must be valid JSON.", 65);
  const managedRepositories = repositoriesForCapability(policy, "pr");
  if (managedRepositories.length === 0) {
    throw new CliError("::error::No managed PR repositories are configured.", 65);
  }

  const requestedRepository = (process.env.MAIN_WRITE_AUDIT_REPOSITORY ?? "").trim();
  if (requestedRepository && !repositoryPattern.test(requestedRepository)) {
    throw new CliError("::error::MAIN_WRITE_AUDIT_REPOSITORY is invalid.", 64);
  }
  if (requestedRepository && !managedRepositories.includes(requestedRepository)) {
    throw new CliError(
      `::error::MAIN_WRITE_AUDIT_REPOSITORY is not a managed PR repository: ${requestedRepository}.`,
      77
    );
  }
  const repositories = requestedRepository ? [requestedRepository] : managedRepositories;

  // Reads span pull requests, commit statuses and issues, so the reader keeps the control token.
  // Writes are scoped: statuses use the status token, incidents use the issue token.
  const reader = new GithubReader(
    process.env.GITHUB_API_URL ?? "https://api.github.com",
    controlToken
  );
  const results: AuditResult[] = [];

  for (const repository of repositories) {
    let mainSha = "";
    try {
      // Auto-close expired incidents before auditing, so they don't block the pipeline.
      try {
        // Close expired incidents needs issue write permission
        await closeExpiredIncidents(reader, repository, issueToken);
      } catch {
        // Non-fatal: the audit continues even if cleanup fails.
      }
      const repositoryValue = await reader.get(`repos/${repository}`);
      const defaultBranch = getJsonString(repositoryValue, "default_branch");
      if (defaultBranch !== "main") {
        throw new CliError(
          `::error::Managed repository default branch must be main: ${repository}.`,
          65
        );
      }
      const mainCommit = await reader.get(`repos/${repository}/commits/main`);
      mainSha = getJsonString(mainCommit, "sha");
      if (!shaPattern.test(mainSha)) {
        throw new CliError(`::error::Managed repository main SHA is invalid: ${repository}.`, 65);
      }

      const bypassIncidents = process.env.MAIN_WRITE_GUARD_BYPASS === "true";
      const provenance = await auditRepositoryMain(
        reader,
        repository,
        repository !== controlRepository,
        bypassIncidents
      );
      await publishGuardStatus(
        repository,
        mainSha,
        statusToken,
        "success",
        bypassIncidents
          ? `Trusted main write via PR #${provenance.pr_number} (incident check bypassed)`
          : `Trusted main write via PR #${provenance.pr_number}`,
        runUrl
      );
      results.push({
        repository,
        main_sha: mainSha,
        state: "success",
        detail: `PR #${provenance.pr_number}`,
      });
    } catch (error) {
      const detail =
        error instanceof Error ? error.message.replace(/^::error::/, "") : String(error);
      // Record immutable evidence privately. A later clean merge must not silently close it.
      if (
        shaPattern.test(mainSha) &&
        !(error instanceof IncidentAccessError) &&
        !(error instanceof MainWriteVerificationPendingError) &&
        !detail.startsWith("Unresolved main write incident(s)")
      ) {
        try {
          if (await shouldCreateIncident(reader, repository, mainSha)) {
            const summary = detail.slice(0, 700);
            await runGithubCli(
              [
                "api",
                "--method",
                "POST",
                `repos/${repository}/issues`,
                "-f",
                `title=${incidentTitle(mainSha)}`,
                "-f",
                `body=Main Write Audit rejected ${repository}@${mainSha}.\\n\\nReason: ${summary}\\n\\nRun: ${runUrl}\\n\\nKeep this issue open until a trusted remediation PR is verified and a maintainer accepts the historical incident. A newer successful merge does not retroactively approve this write.`,
              ],
              issueToken
            );
          }
        } catch (reportError) {
          console.error(
            `::error::Could not record main write incident in ${repository}: ${reportError instanceof Error ? reportError.message : String(reportError)}. Check AW_ISSUE_TOKEN Issues: Read and write permission for this repository.`
          );
        }
      }
      if (shaPattern.test(mainSha)) {
        try {
          await publishGuardStatus(
            repository,
            mainSha,
            statusToken,
            error instanceof MainWriteVerificationPendingError ? "pending" : "failure",
            error instanceof MainWriteVerificationPendingError
              ? "Central PR evidence is still running"
              : "Untrusted main write",
            runUrl
          );
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
    ...results.map(
      (item) =>
        `| ${item.repository} | ${item.main_sha} | ${item.state} | ${item.detail.replace(/\|/g, "\\|")} |`
    ),
  ]);

  const failures = results.filter((item) => item.state === "failure");
  if (failures.length > 0) {
    throw new CliError(
      `::error::Main Write Audit failed for ${failures.length} repository/repositories: ${failures.map((item) => `${item.repository} (${item.detail})`).join("; ")}.`,
      1
    );
  }

  console.log(`Main Write Audit passed for ${results.length} repositories.`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
