import { requireToken } from "./control-token.ts";
import { verifyAuthorizedDevBootstrap } from "./dev-bootstrap-authorization.ts";
import {
  DevWritePendingError,
  hasVerifiedDevWriteGuard,
  verifyRecordedDevWrite,
} from "./dev-write-guard.ts";
import {
  getGithubJsonIfExists,
  getJsonString,
  isJsonRecord,
  runGithubCli,
  statusAwareReader,
} from "./github-api.ts";
import {
  assertNoOpenManagedWriteIncidents,
  IncidentAccessError,
  incidentTitle,
  shouldCreateIncident,
} from "./main-write-incidents.ts";
import { managedBranchWriteContext } from "./managed-branch-provenance.ts";
import {
  ProtectionReadError,
  takeProtectionReadToken,
  withProtectionReads,
} from "./protection-read-scope.ts";
import { readRepositoryPolicyText, repositoriesForCapability } from "./repository-policy.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";
import { latestAttestedStatus, signedStatusDescription } from "./status-attestation.ts";
import { postGithubCommitStatus } from "./status-write-retry.ts";

const shaPattern = /^[0-9a-f]{40}$/;

async function main(): Promise<void> {
  const protectionToken = takeProtectionReadToken();
  const controlRepository = process.env.GITHUB_REPOSITORY ?? "";
  const runUrl = process.env.DEV_WRITE_AUDIT_RUN_URL ?? "";
  if (!runUrl.startsWith(`https://github.com/${controlRepository}/actions/runs/`)) {
    throw new CliError("Invalid development audit publisher.", 65);
  }
  const statusToken = requireToken("status");
  const issueToken = requireToken("issue");
  const repositories = repositoriesForCapability(JSON.parse(readRepositoryPolicyText()), "pr");
  const reader = withProtectionReads(
    statusAwareReader(
      process.env.GITHUB_API_URL ?? "https://api.github.com",
      requireToken("control"),
      statusToken
    ),
    protectionToken,
    repositories
  );
  const context = managedBranchWriteContext("dev");
  for (const repository of repositories) {
    const repo = await reader.get(`repos/${repository}`);
    if (!isJsonRecord(repo) || repo.full_name !== repository) {
      throw new CliError("Development audit repository identity is invalid.", 65);
    }
    const branch = await getGithubJsonIfExists(`repos/${repository}/branches/dev`, (path) =>
      reader.get(path)
    );
    if (branch === undefined) continue;
    const sha = isJsonRecord(branch) ? getJsonString(branch.commit, "sha") : "";
    if (!shaPattern.test(sha)) throw new CliError("Invalid development branch identity.", 65);
    const statuses = await reader.get(`repos/${repository}/commits/${sha}/status`);
    let description: string;
    let state: "success" | "failure" | "pending";
    try {
      await assertNoOpenManagedWriteIncidents(reader, repository, "dev");
      if (await hasVerifiedDevWriteGuard(reader, repository, sha, statuses, controlRepository)) {
        continue;
      }
      const bootstrap = await verifyAuthorizedDevBootstrap(
        reader,
        repository,
        sha,
        statuses,
        controlRepository
      );
      description =
        bootstrap ??
        (await verifyRecordedDevWrite(reader, repository, sha, controlRepository)).description;
      state = "success";
    } catch (error) {
      if (error instanceof DevWritePendingError) {
        description = "Development write verification pending";
        state = "pending";
      } else if (
        error instanceof CliError &&
        !(error instanceof IncidentAccessError) &&
        !(error instanceof ProtectionReadError)
      ) {
        description = "Untrusted development write";
        state = "failure";
        if (
          !error.message.startsWith("::error::Unresolved dev write incident(s)") &&
          (await shouldCreateIncident(reader, repository, sha, "dev"))
        ) {
          await runGithubCli(
            [
              "api",
              "--method",
              "POST",
              `repos/${repository}/issues`,
              "-f",
              `title=${incidentTitle(sha, "dev")}`,
              "-f",
              `body=Dev Write Audit rejected ${repository}@${sha}. Review the immutable merge evidence.\n\nRun: ${runUrl}`,
            ],
            issueToken
          );
        }
      } else {
        // API, permission and transport failures do not prove an unauthorized write.
        throw error;
      }
    }
    const existing = latestAttestedStatus(statuses, { repository, sha, context });
    if (state !== "success" && existing?.state === state) continue;
    const status = { repository, sha, state, context, description, targetUrl: runUrl };
    await postGithubCommitStatus({
      ...status,
      token: statusToken,
      description: signedStatusDescription(status),
    });
    console.log(`Dev write audit: ${repository}@${sha} ${state}`);
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
