import { readFileSync } from "node:fs";
import { isDevEnabled, readBranchPolicy } from "./branch-publication-policy.ts";
import { trustedControlRunId } from "./ci-evidence.ts";
import {
  devGovernanceReceipt,
  type PrCiScope,
  prCiScopeDescription,
  readCurrentPrCiScope,
} from "./ci-scope-receipt.ts";
import {
  decodeGithubContent,
  parseDependencyRepairManifest,
  resolveDependencyRepairFacts,
  selectDependencyRepair,
} from "./dependency-repair.ts";
import { devMergePolicyEnabled } from "./dev-merge-execution.ts";
import { hasVerifiedDevWriteGuard } from "./dev-write-guard.ts";
import { getJsonString, githubEnvironment, isJsonRecord, statusAwareReader } from "./github-api.ts";
import { gateContextsForBranch, loadGateContract } from "./governance-gate-contract.ts";
import { trustedIntakeTarget } from "./intake-event-scope.ts";
import { requireIntakeStatusToken, reserveIntakeCommitStatus } from "./intake-status-token.ts";
import { findActiveIncidents } from "./main-write-incidents.ts";
import { hasApprovedPrivateCiCaller } from "./private-ci-evidence.ts";
import { prTitleFingerprint } from "./pr-title-fingerprint.ts";
import { evaluatePrTrust } from "./pr-trust.ts";
import { readRepositoryPolicyText, repositoriesForCapability } from "./repository-policy.ts";
import { isReservedMergeSourceRef } from "./resolve-pr-facts.ts";
import { CliError, handleError, isMain, parseJson, runCommand } from "./runtime-command.ts";
import {
  hasValidStatusAttestation,
  latestAttestedStatus,
  originalStatusDescription,
} from "./status-attestation.ts";

type GithubGet = {
  get(path: string): Promise<unknown>;
};

type Dispatch = (
  repository: string,
  prNumber: number,
  headSha: string,
  targetBranch?: "main" | "dev"
) => Promise<void>;
type Reserve = (
  repository: string,
  headSha: string,
  context: "PR Governance" | "Dependency Repair" | "Dev PR Governance",
  description: string
) => Promise<void>;

export type IntakeResult = {
  repositories: number;
  open_pull_requests: number;
  dispatched: number;
  repair_dispatched: number;
  repair_blocked: number;
  in_flight: number;
  already_processed: number;
  blocked_unauthorized: number;
  blocked_status_capacity?: number;
};

const shaPattern = /^[0-9a-f]{40}$/;

type StatusFact = {
  state: string;
  run_id: number;
  updated_at: string;
  description: string;
};

type PullFacts = { number: number; headSha: string; pull: Record<string, unknown> };

export function isCommitStatusCapacityError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /This SHA and context has reached the maximum number of statuses/i.test(error.message)
  );
}

// A status-exhausted head cannot receive another trusted reservation. Do not dispatch
// it without a lease, and do not let one permanently exhausted head block other PRs.
async function reserveOrBlock(
  reserve: Reserve | undefined,
  result: IntakeResult,
  repository: string,
  headSha: string,
  context: "PR Governance" | "Dependency Repair" | "Dev PR Governance",
  description: string
): Promise<boolean> {
  if (!reserve) return true;
  try {
    await reserve(repository, headSha, context, description);
    return true;
  } catch (error) {
    if (!isCommitStatusCapacityError(error)) throw error;
    result.blocked_status_capacity = (result.blocked_status_capacity ?? 0) + 1;
    console.warn(
      `::warning::Status capacity exhausted for ${repository}@${headSha} ${context}; dispatch withheld. A new PR head SHA is required before governance can resume.`
    );
    return false;
  }
}

export const PENDING_STATUS_LEASE_MS = 120_000;

// Workflows whose run carries out a pull request verdict: governance and central CI.
const verdictWorkflowPaths = new Set([
  ".github/workflows/handle-pr-dispatch.yml",
  ".github/workflows/central-ci-dispatch.yml",
]);

function pendingLeaseActive(fact: StatusFact, nowMs = Date.now()): boolean {
  const updatedAtMs = Date.parse(fact.updated_at);
  return (
    Number.isFinite(updatedAtMs) &&
    nowMs >= updatedAtMs &&
    nowMs - updatedAtMs < PENDING_STATUS_LEASE_MS
  );
}

function statusMap(
  value: unknown,
  controlRepository: string,
  repository: string,
  sha: string
): Map<string, StatusFact> {
  if (!isJsonRecord(value) || !Array.isArray(value.statuses)) {
    throw new CliError("GitHub commit status response is invalid.", 65);
  }
  const statuses = new Map<string, StatusFact>();
  for (const item of value.statuses) {
    if (!isJsonRecord(item)) continue;
    const context = typeof item.context === "string" ? item.context : "";
    const state = typeof item.state === "string" ? item.state : "";
    const targetUrl = typeof item.target_url === "string" ? item.target_url : "";
    const updatedAt = typeof item.updated_at === "string" ? item.updated_at : "";
    const description = originalStatusDescription(item);
    const runId = trustedControlRunId(targetUrl, controlRepository);
    if (!runId || !hasValidStatusAttestation(item, { repository, sha, context })) continue;
    if (context && state && !statuses.has(context)) {
      statuses.set(context, { state, run_id: runId, updated_at: updatedAt, description });
    }
  }
  return statuses;
}

function pullFacts(value: unknown): PullFacts {
  if (
    !isJsonRecord(value) ||
    typeof value.number !== "number" ||
    !Number.isInteger(value.number) ||
    value.number < 1 ||
    !isJsonRecord(value.head)
  ) {
    throw new CliError("GitHub pull request response is invalid.", 65);
  }
  const headSha = typeof value.head.sha === "string" ? value.head.sha : "";
  if (!shaPattern.test(headSha)) {
    throw new CliError("GitHub pull request head SHA is invalid.", 65);
  }
  return { number: value.number, headSha, pull: value };
}

async function openPullRequests(reader: GithubGet, repository: string): Promise<PullFacts[]> {
  const pulls: PullFacts[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = await reader.get(
      `repos/${repository}/pulls?state=open&per_page=100&page=${page}`
    );
    if (!Array.isArray(response)) {
      throw new CliError("GitHub API returned an invalid response.", 65);
    }
    pulls.push(...response.map(pullFacts));
    if (response.length < 100) break;
  }
  return pulls;
}

async function needsDispatch(
  statuses: Map<string, StatusFact>,
  reader: GithubGet,
  controlRepository: string,
  currentTitle: string,
  targetBranch = "main"
): Promise<"dispatch" | "in-flight" | "processed"> {
  const contexts = gateContextsForBranch(loadGateContract(), targetBranch);
  const governance = statuses.get(contexts.pr_governance);
  const evidence = statuses.get(contexts.ci_evidence);
  const mergeGate = statuses.get(contexts.merge_validation);
  const facts = [governance, evidence, mergeGate].filter(
    (item): item is StatusFact => item !== undefined
  );

  const pendingRunIds = [
    ...new Set(facts.filter((item) => item.state === "pending").map((item) => item.run_id)),
  ];
  const cancelledPendingRun = new Set<number>();
  for (const runId of pendingRunIds) {
    const run = await reader.get(`repos/${controlRepository}/actions/runs/${runId}`);
    const runStatus = isJsonRecord(run) && typeof run.status === "string" ? run.status : "";
    if (["queued", "in_progress", "pending", "waiting", "requested"].includes(runStatus)) {
      return "in-flight";
    }
    // Only a run that carries out a verdict counts. A reservation written by an intake run names
    // that intake run, and a cancelled intake run must let its reservation expire and be retried.
    if (
      isJsonRecord(run) &&
      run.conclusion === "cancelled" &&
      typeof run.path === "string" &&
      verdictWorkflowPaths.has(run.path)
    ) {
      cancelledPendingRun.add(runId);
    }
  }
  if (facts.some((item) => item.state === "pending" && pendingLeaseActive(item))) {
    return "in-flight";
  }
  // A cancelled verdict run was stopped on purpose, usually by a newer dispatch for the same PR.
  // Retrying it here would cancel the job that is running for this head, so the head is left alone.
  if (cancelledPendingRun.size > 0) {
    return "processed";
  }
  if (pendingRunIds.length > 0) {
    return "dispatch";
  }

  // A PR title can change without changing its head SHA. Successful and title-bound failure
  // verdicts carry the exact title fingerprint; stale verdicts must be recomputed.
  if (governance && currentTitle && targetBranch === "main") {
    const fingerprintPrefix = /^title-sha256=[0-9a-f]{64} /.exec(governance.description)?.[0];
    const expectedPrefix = "title-sha256=" + prTitleFingerprint(currentTitle) + " ";
    if (
      (fingerprintPrefix && fingerprintPrefix !== expectedPrefix) ||
      (governance.state === "success" && !fingerprintPrefix)
    ) {
      return "dispatch";
    }
  }

  // A complete set of statuses is the verdict for this head. The control revision (main) is not
  // part of the trigger: when main moves, a finished verdict is not recomputed for the same head.
  if (governance && evidence && mergeGate) {
    return "processed";
  }
  return "dispatch";
}

function isMissingManifest(error: unknown): boolean {
  return error instanceof Error && /HTTP 404\b/.test(error.message);
}

export async function needsDependencyRepair(
  reader: GithubGet,
  repository: string,
  prNumber: number,
  headSha: string
): Promise<boolean> {
  const request = {
    schema_version: "1" as const,
    request_id: `intake-repair:${repository.replace(/[^A-Za-z0-9_.-]/g, "-")}:${prNumber}:${headSha.slice(0, 12)}`,
    repository,
    pr_number: prNumber,
    head_sha: headSha,
  };
  let facts: Awaited<ReturnType<typeof resolveDependencyRepairFacts>>;
  try {
    facts = await resolveDependencyRepairFacts(reader, request);
  } catch (error) {
    // A PR that touches a path outside the safe alphabet (for example a non-ASCII file name)
    // can never be repaired automatically. It must not abort reconciliation of every other PR.
    if (
      error instanceof CliError &&
      error.exitCode === 65 &&
      /invalid file path/.test(error.message)
    ) {
      return false;
    }
    throw error;
  }
  let manifestResponse: unknown;
  try {
    manifestResponse = await reader.get(
      `repos/${repository}/contents/.github/dependency-repair.json?ref=${facts.base_sha}`
    );
  } catch (error) {
    if (isMissingManifest(error)) return false;
    throw error;
  }
  const manifest = parseDependencyRepairManifest(
    parseJson(
      decodeGithubContent(manifestResponse),
      "Dependency repair manifest must be valid JSON.",
      65
    )
  );
  return selectDependencyRepair(manifest, facts) !== null;
}

async function repairState(
  statuses: Map<string, StatusFact>,
  reader: GithubGet,
  controlRepository: string
): Promise<"dispatch" | "in-flight" | "ready" | "blocked"> {
  const repair = statuses.get("Dependency Repair");
  if (!repair) return "dispatch";
  if (repair.state === "success") return "ready";
  if (repair.state === "failure" || repair.state === "error") return "blocked";
  if (repair.state !== "pending") return "dispatch";

  const run = await reader.get(`repos/${controlRepository}/actions/runs/${repair.run_id}`);
  const runStatus = isJsonRecord(run) && typeof run.status === "string" ? run.status : "";
  if (["queued", "in_progress", "pending", "waiting", "requested"].includes(runStatus)) {
    return "in-flight";
  }
  if (pendingLeaseActive(repair)) {
    return "in-flight";
  }
  return "dispatch";
}

/** Retry an incomplete operational merge only after a different trusted control revision. */
export async function shouldRetryDevOperation(
  reader: GithubGet,
  controlRepository: string,
  runId: number,
  run: unknown
): Promise<boolean> {
  if (
    !isJsonRecord(run) ||
    run.id !== runId ||
    getJsonString(run.repository, "full_name") !== controlRepository ||
    run.head_branch !== "main" ||
    run.path !== ".github/workflows/handle-pr-dispatch.yml" ||
    run.status !== "completed" ||
    !shaPattern.test(getJsonString(run, "head_sha"))
  ) {
    return false;
  }
  const current = await reader.get(`repos/${controlRepository}/branches/main`);
  const head = isJsonRecord(current) ? getJsonString(current.commit, "sha") : "";
  if (!shaPattern.test(head) || head === run.head_sha) return false;
  const jobs = await reader.get(
    `repos/${controlRepository}/actions/runs/${runId}/jobs?per_page=100`
  );
  return (
    isJsonRecord(jobs) &&
    Array.isArray(jobs.jobs) &&
    jobs.jobs.some(
      (job) =>
        isJsonRecord(job) &&
        job.name === "Development squash merge (operational)" &&
        job.status === "completed" &&
        ["skipped", "failure", "cancelled"].includes(getJsonString(job, "conclusion"))
    )
  );
}

/** New trusted base or repaired control revision can wake a green unmerged dev PR once. */
export async function shouldResumeDevMerge(
  reader: GithubGet,
  rulesetPolicy: unknown,
  scope: PrCiScope,
  controlRepository: string,
  governance: Pick<StatusFact, "run_id" | "updated_at">,
  isPrivate = false
): Promise<boolean> {
  if (
    scope.targetBranch !== "dev" ||
    !rulesetPolicy ||
    !devMergePolicyEnabled(rulesetPolicy, scope.repository, controlRepository)
  ) {
    return false;
  }
  const prior = Date.parse(governance.updated_at);
  if (!Number.isFinite(prior)) return false;
  const prefix = `repos/${scope.repository}`;
  const statuses = await reader.get(`${prefix}/commits/${scope.baseSha}/status`);
  const guard = latestAttestedStatus(statuses, {
    repository: scope.repository,
    sha: scope.baseSha,
    context: "Dev Write Guard",
  });
  const guardAt = Date.parse(getJsonString(guard, "created_at"));
  if (guard?.state !== "success" || !Number.isFinite(guardAt)) return false;
  if (
    !(await hasVerifiedDevWriteGuard(
      reader,
      scope.repository,
      scope.baseSha,
      statuses,
      controlRepository
    )) ||
    (await findActiveIncidents(reader, scope.repository, "dev")).length > 0
  ) {
    return false;
  }
  const run = await reader.get(`repos/${controlRepository}/actions/runs/${governance.run_id}`);
  if (getJsonString(run, "status") !== "completed") return false;
  // A new governance receipt consumes either wake-up reason; do not loop on the same revision.
  if (
    guardAt <= prior &&
    !(await shouldRetryDevOperation(reader, controlRepository, governance.run_id, run))
  ) {
    return false;
  }
  // Wait for repository settings to apply the enrolled policy. The merge executor
  // still performs its own privileged live protection and signed admission checks.
  if (isPrivate) return true; // The merge executor verifies the exact live platform restriction.
  const rules = await reader.get(`${prefix}/rules/branches/dev`);
  if (!Array.isArray(rules)) return false;
  const live = rules.filter(isJsonRecord);
  if (live.some((rule) => rule.type === "update")) return false;
  return (
    live.some((rule) => rule.type === "pull_request") &&
    live.some(
      (rule) =>
        rule.type === "required_status_checks" &&
        isJsonRecord(rule.parameters) &&
        rule.parameters.strict_required_status_checks_policy === true &&
        Array.isArray(rule.parameters.required_status_checks) &&
        rule.parameters.required_status_checks.some(
          (check) =>
            isJsonRecord(check) &&
            check.context === "validate-merge-dev" &&
            check.integration_id === 5609149
        )
    )
  );
}

export async function scanOpenPullRequests(
  policyValue: unknown,
  reader: GithubGet,
  dispatch: Dispatch,
  controlRepository: string,
  dispatchRepair?: Dispatch,
  reserve?: Reserve,
  onlyRepository = "",
  rulesetPolicy?: unknown
): Promise<IntakeResult> {
  const repositories = repositoriesForCapability(policyValue, "pr").filter(
    (repository) =>
      (!onlyRepository || repository === onlyRepository) &&
      (repository !== controlRepository ||
        (rulesetPolicy !== undefined &&
          devMergePolicyEnabled(rulesetPolicy, repository, controlRepository)))
  );
  const result: IntakeResult = {
    repositories: repositories.length,
    open_pull_requests: 0,
    dispatched: 0,
    repair_dispatched: 0,
    repair_blocked: 0,
    in_flight: 0,
    already_processed: 0,
    blocked_unauthorized: 0,
  };

  for (const repository of repositories) {
    const pulls = (await openPullRequests(reader, repository)).filter(
      (pull) => repository !== controlRepository || getJsonString(pull.pull.base, "ref") === "dev"
    );
    result.open_pull_requests += pulls.length;
    for (const pull of pulls) {
      const headRef = getJsonString(pull.pull.head, "ref");
      const baseRef = getJsonString(pull.pull.base, "ref");
      const baseRepo = isJsonRecord(pull.pull.base) ? pull.pull.base.repo : undefined;
      const headRepo = isJsonRecord(pull.pull.head) ? pull.pull.head.repo : undefined;
      if (
        baseRef === "dev" &&
        isDevEnabled(rulesetPolicy ?? readBranchPolicy(), repository) &&
        headRef !== "" &&
        !isReservedMergeSourceRef(headRef) &&
        isJsonRecord(baseRepo) &&
        typeof baseRepo.private === "boolean" &&
        baseRepo.full_name === repository &&
        getJsonString(headRepo, "full_name") === repository &&
        evaluatePrTrust(pull.pull, [], pull.headSha).trusted
      ) {
        if (
          baseRepo.private === true &&
          !(await hasApprovedPrivateCiCaller(reader, repository, getJsonString(pull.pull.base, "sha")))
        ) {
          result.blocked_unauthorized += 1;
          continue;
        }
        const statuses = statusMap(
          await reader.get(`repos/${repository}/commits/${pull.headSha}/status`),
          controlRepository,
          repository,
          pull.headSha
        );
        let action = await needsDispatch(
          statuses,
          reader,
          controlRepository,
          getJsonString(pull.pull, "title"),
          "dev"
        );
        const governance = statuses.get("Dev PR Governance");
        const evidence = statuses.get("Dev CI Evidence");
        const gate = statuses.get("validate-merge-dev");
        if (
          action === "processed" &&
          governance?.state === "success" &&
          evidence?.state === "success" &&
          gate?.state === "success"
        ) {
          const scope = await readCurrentPrCiScope(
            reader,
            repository,
            pull.number,
            pull.headSha,
            "dev"
          );
          if (scope) {
            const expected = devGovernanceReceipt(
              scope,
              prTitleFingerprint(getJsonString(pull.pull, "title").replace(/[\r\n]/g, " "))
            );
            if (
              governance.description !== expected ||
              gate.description !== expected ||
              gate.run_id !== governance.run_id ||
              evidence.description !== prCiScopeDescription(scope)
            ) {
              action = "dispatch";
            } else if (
              pull.pull.draft === false &&
              (await shouldResumeDevMerge(
                reader,
                rulesetPolicy,
                scope,
                controlRepository,
                governance,
                baseRepo.private === true
              ))
            ) {
              action = "dispatch";
            }
          }
        }
        if (action === "in-flight") {
          result.in_flight += 1;
        } else if (
          action === "processed" ||
          statuses.get("Dev PR Governance")?.state === "failure"
        ) {
          result.already_processed += 1;
        } else if (
          await reserveOrBlock(
            reserve,
            result,
            repository,
            pull.headSha,
            "Dev PR Governance",
            "Development PR governance queued by central intake"
          )
        ) {
          await dispatch(repository, pull.number, pull.headSha, "dev");
          result.dispatched += 1;
        }
        continue;
      }
      if (isReservedMergeSourceRef(headRef) || (baseRef !== "" && baseRef !== "main")) {
        result.blocked_unauthorized += 1;
        console.warn(
          `::warning::PR ${repository}#${pull.number} is outside ordinary main governance; dispatch withheld.`
        );
        continue;
      }
      const statuses = statusMap(
        await reader.get(`repos/${repository}/commits/${pull.headSha}/status`),
        controlRepository,
        repository,
        pull.headSha
      );
      const governanceAction = await needsDispatch(
        statuses,
        reader,
        controlRepository,
        typeof pull.pull.title === "string" ? pull.pull.title : ""
      );
      if (governanceAction === "in-flight") {
        result.in_flight += 1;
        continue;
      }
      if (governanceAction === "processed") {
        // Successful checks on an open PR do not imply it was merged. A
        // previously rejected automatic merge can leave the branch behind
        // main. Re-dispatch only that exact green, non-draft, same-repository
        // head so the immutable-head merge worker updates it and reruns CI.
        const isGreen = ["PR Governance", "CI Evidence", "validate-merge"].every(
          (context) => statuses.get(context)?.state === "success"
        );
        if (isGreen && pull.pull.draft === false) {
          const detail = await reader.get(`repos/${repository}/pulls/${pull.number}`);
          const head = isJsonRecord(detail) && isJsonRecord(detail.head) ? detail.head : {};
          const base = isJsonRecord(detail) && isJsonRecord(detail.base) ? detail.base : {};
          const headRepo = isJsonRecord(head.repo) ? head.repo : {};
          const baseRepo = isJsonRecord(base.repo) ? base.repo : {};
          if (
            isJsonRecord(detail) &&
            detail.state === "open" &&
            detail.draft === false &&
            detail.mergeable_state === "behind" &&
            head.sha === pull.headSha &&
            base.ref === "main" &&
            !isReservedMergeSourceRef(getJsonString(head, "ref")) &&
            headRepo.full_name === repository &&
            baseRepo.full_name === repository
          ) {
            if (
              !(await reserveOrBlock(
                reserve,
                result,
                repository,
                pull.headSha,
                "PR Governance",
                "Retry signed CI-green PR branch refresh via central governance"
              ))
            )
              continue;
            await dispatch(repository, pull.number, pull.headSha);
            result.dispatched += 1;
            continue;
          }
        }
        result.already_processed += 1;
        continue;
      }
      // A rejected external head stays blocked: no human review can authorize CI.
      // A fresh head or change in trusted authorship will be assessed on a new intake.
      if (
        governanceAction === "dispatch" &&
        statuses.get("PR Governance")?.state === "failure" &&
        !evaluatePrTrust(pull.pull, [], pull.headSha).trusted
      ) {
        result.blocked_unauthorized += 1;
        continue;
      }

      if (
        dispatchRepair &&
        (await needsDependencyRepair(reader, repository, pull.number, pull.headSha))
      ) {
        const state = await repairState(statuses, reader, controlRepository);
        if (state === "in-flight") {
          result.in_flight += 1;
          continue;
        }
        if (state === "blocked") {
          result.repair_blocked += 1;
          continue;
        }
        if (state === "dispatch") {
          if (
            !(await reserveOrBlock(
              reserve,
              result,
              repository,
              pull.headSha,
              "Dependency Repair",
              "Dependency repair queued by central intake"
            ))
          )
            continue;
          await dispatchRepair(repository, pull.number, pull.headSha);
          result.repair_dispatched += 1;
          continue;
        }
      }

      if (
        !(await reserveOrBlock(
          reserve,
          result,
          repository,
          pull.headSha,
          "PR Governance",
          "Action Worker PR governance queued by central intake"
        ))
      )
        continue;
      await dispatch(repository, pull.number, pull.headSha);
      result.dispatched += 1;
    }
  }

  return result;
}

async function reserveStatus(
  controlRepository: string,
  token: string,
  repository: string,
  headSha: string,
  context: "PR Governance" | "Dependency Repair" | "Dev PR Governance",
  description: string
): Promise<void> {
  const runId = process.env.GITHUB_RUN_ID ?? "";
  const serverUrl = (process.env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, "");
  if (!runId) {
    throw new CliError("GITHUB_RUN_ID is required to reserve central intake status.", 64);
  }
  const targetUrl = `${serverUrl}/${controlRepository}/actions/runs/${runId}`;
  await reserveIntakeCommitStatus(token, repository, headSha, context, description, targetUrl);
}

async function dispatchEvent(
  controlRepository: string,
  token: string,
  eventType: string,
  repository: string,
  prNumber: number,
  headSha: string,
  targetBranch = "main"
): Promise<void> {
  const safeRepository = repository.replace(/[^A-Za-z0-9_.-]/g, "-");
  const body = {
    event_type: eventType,
    client_payload: {
      schema_version: "1",
      request_id: `intake:${safeRepository}:${prNumber}:${headSha.slice(0, 12)}`,
      repository,
      pr_number: prNumber,
      head_sha: headSha,
      ...(targetBranch === "dev" ? { target_branch: targetBranch } : {}),
    },
  };

  await runCommand(
    "gh",
    ["api", "--method", "POST", `repos/${controlRepository}/dispatches`, "--input", "-"],
    {
      env: githubEnvironment(token),
      input: JSON.stringify(body),
      timeoutMs: 30_000,
      maxBuffer: 1024 * 1024,
    }
  );
}

async function main(): Promise<void> {
  const policyRaw = readRepositoryPolicyText() ?? "";
  const controlToken = process.env.AW_CONTROL_TOKEN ?? "";
  const statusToken = requireIntakeStatusToken(process.env.AW_STATUS_API_TOKEN);
  const dispatchToken = process.env.AW_DISPATCH_API_TOKEN ?? "";
  const controlRepository = process.env.AW_CONTROL_REPOSITORY ?? "";
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";

  if (!policyRaw || !controlToken || !dispatchToken || !controlRepository) {
    throw new CliError(
      "AW_REPOSITORY_POLICY, AW_CONTROL_TOKEN, AW_DISPATCH_API_TOKEN, and AW_CONTROL_REPOSITORY are required.",
      64
    );
  }

  const policy = parseJson(policyRaw, "AW_REPOSITORY_POLICY must be valid JSON.", 65);
  const target = trustedIntakeTarget(policy, process.env.AW_INTAKE_TARGET_REPOSITORY ?? "");
  const reader = statusAwareReader(apiUrl, controlToken, statusToken);
  const result = await scanOpenPullRequests(
    policy,
    reader,
    async (repository, prNumber, headSha, targetBranch) => {
      await dispatchEvent(
        controlRepository,
        dispatchToken,
        "run-pr-governance",
        repository,
        prNumber,
        headSha,
        targetBranch
      );
    },
    controlRepository,
    async (repository, prNumber, headSha) => {
      await dispatchEvent(
        controlRepository,
        dispatchToken,
        "run-dependency-repair",
        repository,
        prNumber,
        headSha
      );
    },
    async (repository, headSha, context, description) => {
      await reserveStatus(
        controlRepository,
        statusToken,
        repository,
        headSha,
        context,
        description
      );
    },
    target,
    parseJson(readFileSync("policies/rulesets.json", "utf8"), "Invalid ruleset policy.", 65)
  );

  console.log(JSON.stringify(result));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
