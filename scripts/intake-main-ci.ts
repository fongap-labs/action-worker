import {
  GithubReader,
  getJsonString,
  githubEnvironment,
  isJsonRecord,
} from "./github-api.ts";
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

type Dispatch = (repository: string, headSha: string) => Promise<void>;
type Reserve = (repository: string, headSha: string) => Promise<void>;

export type CiIntakeResult = {
  repositories: number;
  dispatched: number;
  in_flight: number;
  already_processed: number;
};

const shaPattern = /^[0-9a-f]{40}$/;
export const PENDING_STATUS_LEASE_MS = 120_000;

type StatusFact = {
  state: string;
  target_url: string;
  updated_at: string;
};

function latestStatus(value: unknown, context: string): StatusFact | null {
  if (!isJsonRecord(value) || !Array.isArray(value.statuses)) {
    throw new CliError("GitHub commit status response is invalid.", 65);
  }
  for (const item of value.statuses) {
    if (!isJsonRecord(item)) continue;
    if (getJsonString(item, "context") === context) {
      return {
        state: getJsonString(item, "state"),
        target_url: getJsonString(item, "target_url"),
        updated_at: getJsonString(item, "updated_at"),
      };
    }
  }
  return null;
}

function pendingLeaseActive(fact: StatusFact, nowMs = Date.now()): boolean {
  const updatedAtMs = Date.parse(fact.updated_at);
  return Number.isFinite(updatedAtMs)
    && nowMs >= updatedAtMs
    && nowMs - updatedAtMs < PENDING_STATUS_LEASE_MS;
}

async function ciState(
  value: unknown,
  reader: GithubGet,
  controlRepository: string,
): Promise<"dispatch" | "in-flight" | "processed"> {
  const fact = latestStatus(value, "CI Evidence")
    ?? latestStatus(value, "ci-evidence");
  if (!fact) return "dispatch";
  if (fact.state !== "pending") return "processed";

  if (!controlRepository) {
    return "in-flight";
  }

  const runId = trustedControlRunId(fact.target_url, controlRepository);
  if (runId) {
    const run = await reader.get(`repos/${controlRepository}/actions/runs/${runId}`);
    const runStatus = isJsonRecord(run) && typeof run.status === "string" ? run.status : "";
    if (["queued", "in_progress", "pending", "waiting", "requested"].includes(runStatus)) {
      return "in-flight";
    }
  }

  return pendingLeaseActive(fact) ? "in-flight" : "dispatch";
}

async function defaultHead(reader: GithubGet, repository: string): Promise<string> {
  const repo = await reader.get(`repos/${repository}`);
  if (!isJsonRecord(repo)) {
    throw new CliError(`GitHub repository response is invalid: ${repository}.`, 65);
  }
  const branch = getJsonString(repo, "default_branch");
  if (!branch) {
    throw new CliError(`Repository default branch is unavailable: ${repository}.`, 65);
  }
  const commit = await reader.get(`repos/${repository}/commits/${branch}`);
  if (!isJsonRecord(commit)) {
    throw new CliError(`GitHub commit response is invalid: ${repository}.`, 65);
  }
  const sha = getJsonString(commit, "sha");
  if (!shaPattern.test(sha)) {
    throw new CliError(`Repository default head SHA is invalid: ${repository}.`, 65);
  }
  return sha;
}

export async function scanMainCi(
  policyValue: unknown,
  reader: GithubGet,
  dispatch: Dispatch,
  excludedRepository = "",
  reserve?: Reserve,
): Promise<CiIntakeResult> {
  const repositories = repositoriesForCapability(policyValue, "pr")
    .filter((repository) => repository !== excludedRepository);
  const result: CiIntakeResult = {
    repositories: repositories.length,
    dispatched: 0,
    in_flight: 0,
    already_processed: 0,
  };

  for (const repository of repositories) {
    const headSha = await defaultHead(reader, repository);
    const status = await reader.get(`repos/${repository}/commits/${headSha}/status`);
    const state = await ciState(status, reader, excludedRepository);
    if (state === "in-flight") {
      result.in_flight += 1;
      continue;
    }
    if (state === "processed") {
      result.already_processed += 1;
      continue;
    }
    if (reserve) {
      await reserve(repository, headSha);
    }
    await dispatch(repository, headSha);
    result.dispatched += 1;
  }

  return result;
}

async function reserveCiStatus(
  controlRepository: string,
  token: string,
  repository: string,
  headSha: string,
): Promise<void> {
  const runId = process.env.GITHUB_RUN_ID ?? "";
  const serverUrl = (process.env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, "");
  if (!runId) {
    throw new CliError("GITHUB_RUN_ID is required to reserve central CI status.", 64);
  }
  const targetUrl = `${serverUrl}/${controlRepository}/actions/runs/${runId}`;
  await runCommand(
    "gh",
    [
      "api",
      "--method",
      "POST",
      `repos/${repository}/statuses/${headSha}`,
      "-f",
      "state=pending",
      "-f",
      "context=CI Evidence",
      "-f",
      "description=Central CI queued by central intake",
      "-f",
      `target_url=${targetUrl}`,
    ],
    {
      env: githubEnvironment(token),
      timeoutMs: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
}

async function dispatchCentralCi(
  controlRepository: string,
  token: string,
  repository: string,
  headSha: string,
): Promise<void> {
  const safeRepository = repository.replace(/[^A-Za-z0-9_.-]/g, "-");
  const body = {
    event_type: "run-central-ci-ref",
    client_payload: {
      schema_version: "1",
      request_id: `ci-intake:${safeRepository}:${headSha.slice(0, 12)}`,
      repository,
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
  const ingressToken = process.env.AW_INGRESS_TOKEN ?? "";
  const controlRepository = process.env.AW_CONTROL_REPOSITORY ?? "";
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";

  if (!policyRaw || !controlToken || !ingressToken || !controlRepository) {
    throw new CliError(
      "AW_REPOSITORY_POLICY, AW_CONTROL_TOKEN, AW_INGRESS_TOKEN, and AW_CONTROL_REPOSITORY are required.",
      64,
    );
  }

  const reader = new GithubReader(apiUrl, controlToken);
  const result = await scanMainCi(
    parseJson(policyRaw, "AW_REPOSITORY_POLICY must be valid JSON.", 65),
    reader,
    async (repository, headSha) => {
      await dispatchCentralCi(controlRepository, ingressToken, repository, headSha);
    },
    controlRepository,
    async (repository, headSha) => {
      await reserveCiStatus(controlRepository, controlToken, repository, headSha);
    },
  );

  console.log(JSON.stringify(result));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
