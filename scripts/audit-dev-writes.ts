import { readFileSync } from "node:fs";
import {
  hasBetaPushGrant,
  parseBetaDeployTargets,
  readBetaDeployPolicy,
} from "./beta-deploy-authorization.ts";
import type { JsonReader } from "./ci-evidence.ts";
import { requireToken } from "./control-token.ts";
import { deleteTemporaryDevGuard } from "./create-protected-dev.ts";
import {
  DevBootstrapPendingError,
  devBootstrapContext,
  verifyAuthorizedDevBootstrap,
  verifyAutomaticDevAdoption,
} from "./dev-bootstrap-authorization.ts";
import { recoverInterruptedDevBootstrap } from "./dev-bootstrap-recovery.ts";
import {
  DevWritePendingError,
  devMergeReceiptContext,
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
import {
  hasRepositoryCapability,
  readRepositoryPolicyText,
  repositoriesForCapability,
} from "./repository-policy.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";
import {
  latestAttestedStatus,
  originalStatusDescription,
  signedStatusDescription,
} from "./status-attestation.ts";
import { postGithubCommitStatus } from "./status-write-retry.ts";

const shaPattern = /^[0-9a-f]{40}$/;

/** A completion event selects audit subjects, never grants write authorization. */
export async function completedDevMergePublisher(
  reader: JsonReader,
  controlRepository: string,
  runId: number
): Promise<string> {
  if (!Number.isSafeInteger(runId) || runId < 1) {
    throw new CliError("Invalid development audit trigger.", 65);
  }
  const run = await reader.get(`repos/${controlRepository}/actions/runs/${runId}`);
  if (
    !isJsonRecord(run) ||
    run.id !== runId ||
    getJsonString(run.repository, "full_name") !== controlRepository ||
    run.path !== ".github/workflows/handle-pr-dispatch.yml" ||
    run.head_branch !== "main" ||
    run.event !== "repository_dispatch" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.run_attempt !== 1
  ) {
    throw new CliError("Development audit requires a trusted completed merge publisher.", 75);
  }
  return `https://github.com/${controlRepository}/actions/runs/${runId}`;
}

export function matchesCompletedDevMerge(
  statuses: unknown,
  repository: string,
  sha: string,
  publisher: string
): boolean {
  const receipt = latestAttestedStatus(statuses, {
    repository,
    sha,
    context: devMergeReceiptContext,
  });
  return (
    receipt?.state === "success" &&
    !latestAttestedStatus(statuses, { repository, sha, context: devBootstrapContext }) &&
    getJsonString(receipt, "target_url") === publisher &&
    /^merge-v1=[0-9a-f]{40}$/.test(originalStatusDescription(receipt))
  );
}

/** Only bootstrap/adoption may need live administrative ruleset reads or guard cleanup. */
export async function requiresDevBootstrapAudit(
  reader: JsonReader,
  repository: string,
  sha: string,
  statuses: unknown,
  controlRepository: string,
  isPublic: boolean,
  automatic: boolean
): Promise<boolean> {
  if (latestAttestedStatus(statuses, { repository, sha, context: devBootstrapContext })) {
    return true;
  }
  if (
    !isPublic ||
    !automatic ||
    repository === controlRepository ||
    latestAttestedStatus(statuses, { repository, sha, context: devMergeReceiptContext })
  ) {
    return false;
  }
  const main = await reader.get(`repos/${repository}/branches/main`);
  return isJsonRecord(main) && getJsonString(main.commit, "sha") === sha;
}

async function main(): Promise<void> {
  const protectionToken = takeProtectionReadToken();
  const trigger = process.env.DEV_WRITE_AUDIT_TRIGGER_RUN_ID ?? "";
  const mode = process.env.DEV_WRITE_AUDIT_MODE ?? "sweep";
  if (
    !["full", "merge", "sweep"].includes(mode) ||
    (mode === "merge" ? !trigger : Boolean(trigger)) ||
    (mode === "full" ? !protectionToken : Boolean(protectionToken))
  ) {
    throw new CliError("Development audit mode or credential boundary is invalid.", 77);
  }
  const controlRepository = process.env.GITHUB_REPOSITORY ?? "";
  const runUrl = process.env.DEV_WRITE_AUDIT_RUN_URL ?? "";
  if (!runUrl.startsWith(`https://github.com/${controlRepository}/actions/runs/`)) {
    throw new CliError("Invalid development audit publisher.", 65);
  }
  const statusToken = requireToken("status");
  const issueToken = requireToken("issue");
  const repositoryPolicy: unknown = JSON.parse(readRepositoryPolicyText());
  const repositories = repositoriesForCapability(repositoryPolicy, "pr");
  const ordinaryReader = statusAwareReader(
    process.env.GITHUB_API_URL ?? "https://api.github.com",
    requireToken("control"),
    statusToken
  );
  const reader = withProtectionReads(ordinaryReader, protectionToken, repositories);
  const publisher = trigger
    ? await completedDevMergePublisher(reader, controlRepository, Number(trigger))
    : "";
  const rulesetPolicy: unknown = JSON.parse(readFileSync("policies/rulesets.json", "utf8"));
  const automatic = isJsonRecord(rulesetPolicy) && rulesetPolicy.dev_merge_mode === "automatic";
  const context = managedBranchWriteContext("dev");
  const betaTargets = parseBetaDeployTargets(readBetaDeployPolicy());
  const wakeRepositories = new Set<string>();
  let bootstrapRequired = false;
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
    if (publisher && !matchesCompletedDevMerge(statuses, repository, sha, publisher)) continue;
    const canWakeBeta =
      publisher !== "" &&
      repo.private === false &&
      hasRepositoryCapability(repository, repositoryPolicy, "deploy") &&
      hasBetaPushGrant(betaTargets, repository);
    let description: string;
    let state: "success" | "failure" | "pending";
    try {
      await assertNoOpenManagedWriteIncidents(reader, repository, "dev");
      if (await hasVerifiedDevWriteGuard(reader, repository, sha, statuses, controlRepository)) {
        if (canWakeBeta) wakeRepositories.add(repository);
        continue;
      }
      const bootstrapCandidate =
        mode !== "merge" &&
        (await requiresDevBootstrapAudit(
          reader,
          repository,
          sha,
          statuses,
          controlRepository,
          repo.private === false,
          automatic
        ));
      if (mode === "sweep" && bootstrapCandidate) {
        bootstrapRequired = true;
        console.log("Development bootstrap requires protected reconciliation.");
        continue;
      }
      if (mode === "full" && !bootstrapCandidate) continue;
      if (mode !== "full") {
        // Both ordinary sweeps and completion events reconstruct immutable merge proof.
        description = (await verifyRecordedDevWrite(reader, repository, sha, controlRepository))
          .description;
      } else {
        const recovered = await recoverInterruptedDevBootstrap(
          reader,
          repository,
          sha,
          statuses,
          controlRepository,
          (id) =>
            deleteTemporaryDevGuard(
              process.env.GITHUB_API_URL ?? "https://api.github.com",
              protectionToken,
              repository,
              id
            )
        );
        const bootstrap =
          recovered ??
          (await verifyAuthorizedDevBootstrap(
            reader,
            repository,
            sha,
            statuses,
            controlRepository
          ));
        const adopted =
          bootstrap === undefined && automatic && repo.private === false
            ? await verifyAutomaticDevAdoption(reader, repository, sha, statuses, controlRepository)
            : undefined;
        description =
          bootstrap ??
          adopted ??
          (await verifyRecordedDevWrite(reader, repository, sha, controlRepository)).description;
      }
      state = "success";
    } catch (error) {
      if (error instanceof DevWritePendingError || error instanceof DevBootstrapPendingError) {
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
    if (canWakeBeta && state === "success") wakeRepositories.add(repository);
  }
  await appendLines(process.env.GITHUB_OUTPUT, [
    `bootstrap_required=${bootstrapRequired}`,
    `beta_push_wake=${wakeRepositories.size > 0}`,
    `beta_push_repository=${wakeRepositories.size === 1 ? [...wakeRepositories][0] : ""}`,
  ]);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
