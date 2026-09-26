import {
  GithubReader,
  githubEnvironment,
  isJsonRecord,
} from "./github-api.ts";
import {
  decodeGithubContent,
  parseDependencyRepairManifest,
  resolveDependencyRepairFacts,
  selectDependencyRepair,
} from "./dependency-repair.ts";
import { trustedControlRunId } from "./ci-evidence.ts";
import { repositoriesForCapability } from "./repository-policy.ts";
import {
  CliError,
  handleError,
  isMain,
  parseJson,
  runCommand,
} from "./runtime-command.ts";

type GithubGet = {
  get(path: string): Promise<unknown>;
};

type Dispatch = (repository: string, prNumber: number, headSha: string) => Promise<void>;

export type IntakeResult = {
  repositories: number;
  open_pull_requests: number;
  dispatched: number;
  repair_dispatched: number;
  repair_blocked: number;
  in_flight: number;
  already_processed: number;
};

const shaPattern = /^[0-9a-f]{40}$/;

type StatusFact = {
  state: string;
  run_id: number;
};

function statusMap(value: unknown, controlRepository: string): Map<string, StatusFact> {
  if (!isJsonRecord(value) || !Array.isArray(value.statuses)) {
    throw new CliError("GitHub commit status response is invalid.", 65);
  }
  const statuses = new Map<string, StatusFact>();
  for (const item of value.statuses) {
    if (!isJsonRecord(item)) continue;
    const context = typeof item.context === "string" ? item.context : "";
    const state = typeof item.state === "string" ? item.state : "";
    const targetUrl = typeof item.target_url === "string" ? item.target_url : "";
    const runId = trustedControlRunId(targetUrl, controlRepository);
    if (!runId) continue;
    if (context && state && !statuses.has(context)) {
      statuses.set(context, { state, run_id: runId });
    }
  }
  return statuses;
}

function pullFacts(value: unknown): { number: number; headSha: string } {
  if (!isJsonRecord(value)
    || typeof value.number !== "number"
    || !Number.isInteger(value.number)
    || value.number < 1
    || !isJsonRecord(value.head)
  ) {
    throw new CliError("GitHub pull request response is invalid.", 65);
  }
  const headSha = typeof value.head.sha === "string" ? value.head.sha : "";
  if (!shaPattern.test(headSha)) {
    throw new CliError("GitHub pull request head SHA is invalid.", 65);
  }
  return { number: value.number, headSha };
}

async function openPullRequests(reader: GithubGet, repository: string): Promise<Array<{ number: number; headSha: string }>> {
  const pulls: Array<{ number: number; headSha: string }> = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = await reader.get(
      `repos/${repository}/pulls?state=open&per_page=100&page=${page}`,
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
  controlHeadSha: string,
): Promise<"dispatch" | "in-flight" | "processed"> {
  const governance = statuses.get("PR Governance");
  const evidence = statuses.get("CI Evidence");
  const mergeGate = statuses.get("validate-merge");
  const facts = [governance, evidence, mergeGate].filter(
    (item): item is StatusFact => item !== undefined,
  );

  const pendingRunIds = [...new Set(
    facts.filter((item) => item.state === "pending").map((item) => item.run_id),
  )];
  for (const runId of pendingRunIds) {
    const run = await reader.get(`repos/${controlRepository}/actions/runs/${runId}`);
    const runStatus = isJsonRecord(run) && typeof run.status === "string" ? run.status : "";
    if (["queued", "in_progress", "pending", "waiting", "requested"].includes(runStatus)) {
      return "in-flight";
    }
  }
  if (pendingRunIds.length > 0) {
    return "dispatch";
  }

  if (governance && evidence && mergeGate) {
    if ([governance, evidence, mergeGate].every((item) => item.state === "success")) {
      return "processed";
    }

    const failedRunIds = [...new Set(
      [governance, evidence, mergeGate]
        .filter((item) => item.state === "failure" || item.state === "error")
        .map((item) => item.run_id),
    )];
    if (shaPattern.test(controlHeadSha) && failedRunIds.length > 0) {
      for (const runId of failedRunIds) {
        const run = await reader.get(`repos/${controlRepository}/actions/runs/${runId}`);
        const runHeadSha = isJsonRecord(run) && typeof run.head_sha === "string" ? run.head_sha : "";
        if (shaPattern.test(runHeadSha) && runHeadSha !== controlHeadSha) {
          return "dispatch";
        }
      }
    }
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
  headSha: string,
): Promise<boolean> {
  const request = {
    schema_version: "1" as const,
    request_id: `intake-repair:${repository.replace(/[^A-Za-z0-9_.-]/g, "-")}:${prNumber}:${headSha.slice(0, 12)}`,
    repository,
    pr_number: prNumber,
    head_sha: headSha,
  };
  const facts = await resolveDependencyRepairFacts(reader, request);
  let manifestResponse: unknown;
  try {
    manifestResponse = await reader.get(
      `repos/${repository}/contents/.github/dependency-repair.json?ref=${facts.base_sha}`,
    );
  } catch (error) {
    if (isMissingManifest(error)) return false;
    throw error;
  }
  const manifest = parseDependencyRepairManifest(
    parseJson(
      decodeGithubContent(manifestResponse),
      "Dependency repair manifest must be valid JSON.",
      65,
    ),
  );
  return selectDependencyRepair(manifest, facts) !== null;
}

async function repairState(
  statuses: Map<string, StatusFact>,
  reader: GithubGet,
  controlRepository: string,
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
  return "dispatch";
}

export async function scanOpenPullRequests(
  policyValue: unknown,
  reader: GithubGet,
  dispatch: Dispatch,
  controlRepository: string,
  dispatchRepair?: Dispatch,
  controlHeadSha = "",
): Promise<IntakeResult> {
  const repositories = repositoriesForCapability(policyValue, "pr")
    .filter((repository) => repository !== controlRepository);
  const result: IntakeResult = {
    repositories: repositories.length,
    open_pull_requests: 0,
    dispatched: 0,
    repair_dispatched: 0,
    repair_blocked: 0,
    in_flight: 0,
    already_processed: 0,
  };

  for (const repository of repositories) {
    const pulls = await openPullRequests(reader, repository);
    result.open_pull_requests += pulls.length;
    for (const pull of pulls) {
      const statuses = statusMap(
        await reader.get(`repos/${repository}/commits/${pull.headSha}/status`),
        controlRepository,
      );
      const governanceAction = await needsDispatch(
        statuses,
        reader,
        controlRepository,
        controlHeadSha,
      );
      if (governanceAction === "in-flight") {
        result.in_flight += 1;
        continue;
      }
      if (governanceAction === "processed") {
        result.already_processed += 1;
        continue;
      }

      if (dispatchRepair && await needsDependencyRepair(reader, repository, pull.number, pull.headSha)) {
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
          await dispatchRepair(repository, pull.number, pull.headSha);
          result.repair_dispatched += 1;
          continue;
        }
      }

      await dispatch(repository, pull.number, pull.headSha);
      result.dispatched += 1;
    }
  }

  return result;
}

async function dispatchEvent(
  controlRepository: string,
  token: string,
  eventType: string,
  repository: string,
  prNumber: number,
  headSha: string,
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
    },
  );
}

async function main(): Promise<void> {
  const policyRaw = process.env.AW_REPOSITORY_POLICY ?? "";
  const controlToken = process.env.AW_CONTROL_TOKEN ?? "";
  const dispatchToken = process.env.AW_INGRESS_TOKEN ?? "";
  const controlRepository = process.env.AW_CONTROL_REPOSITORY ?? "";
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";

  if (!policyRaw || !controlToken || !dispatchToken || !controlRepository) {
    throw new CliError(
      "AW_REPOSITORY_POLICY, AW_CONTROL_TOKEN, AW_INGRESS_TOKEN, and AW_CONTROL_REPOSITORY are required.",
      64,
    );
  }

  const reader = new GithubReader(apiUrl, controlToken);
  const result = await scanOpenPullRequests(
    parseJson(policyRaw, "AW_REPOSITORY_POLICY must be valid JSON.", 65),
    reader,
    async (repository, prNumber, headSha) => {
      await dispatchEvent(controlRepository, dispatchToken, "run-pr-governance", repository, prNumber, headSha);
    },
    controlRepository,
    async (repository, prNumber, headSha) => {
      await dispatchEvent(controlRepository, dispatchToken, "run-dependency-repair", repository, prNumber, headSha);
    },
    process.env.GITHUB_SHA ?? "",
  );

  console.log(JSON.stringify(result));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
