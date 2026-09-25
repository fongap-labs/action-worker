import {
  GithubReader,
  getJsonArray,
  getJsonString,
  githubEnvironment,
  isJsonRecord,
} from "./github-api.ts";
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
  in_flight: number;
  already_processed: number;
};

const shaPattern = /^[0-9a-f]{40}$/;

function statusMap(value: unknown): Map<string, string> {
  if (!isJsonRecord(value) || !Array.isArray(value.statuses)) {
    throw new CliError("GitHub commit status response is invalid.", 65);
  }
  const statuses = new Map<string, string>();
  for (const item of value.statuses) {
    if (!isJsonRecord(item)) continue;
    const context = getJsonString(item, "context");
    const state = getJsonString(item, "state");
    if (context && state && !statuses.has(context)) {
      statuses.set(context, state);
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
  const headSha = getJsonString(value.head, "sha");
  if (!shaPattern.test(headSha)) {
    throw new CliError("GitHub pull request head SHA is invalid.", 65);
  }
  return { number: value.number, headSha };
}

async function openPullRequests(reader: GithubGet, repository: string): Promise<Array<{ number: number; headSha: string }>> {
  const pulls: Array<{ number: number; headSha: string }> = [];
  for (let page = 1; page <= 20; page += 1) {
    const values = getJsonArray(await reader.get(
      `repos/${repository}/pulls?state=open&per_page=100&page=${page}`,
    ));
    pulls.push(...values.map(pullFacts));
    if (values.length < 100) break;
  }
  return pulls;
}

function needsDispatch(statuses: Map<string, string>): "dispatch" | "in-flight" | "processed" {
  const governance = statuses.get("PR Governance");
  const evidence = statuses.get("CI Evidence");
  const mergeGate = statuses.get("validate-merge");

  if (governance === "pending" || evidence === "pending" || mergeGate === "pending") {
    return "in-flight";
  }
  if (governance && evidence && mergeGate) {
    return "processed";
  }
  return "dispatch";
}

export async function scanOpenPullRequests(
  policyValue: unknown,
  reader: GithubGet,
  dispatch: Dispatch,
): Promise<IntakeResult> {
  const repositories = repositoriesForCapability(policyValue, "pr");
  const result: IntakeResult = {
    repositories: repositories.length,
    open_pull_requests: 0,
    dispatched: 0,
    in_flight: 0,
    already_processed: 0,
  };

  for (const repository of repositories) {
    const pulls = await openPullRequests(reader, repository);
    result.open_pull_requests += pulls.length;
    for (const pull of pulls) {
      const statuses = statusMap(await reader.get(
        `repos/${repository}/commits/${pull.headSha}/status`,
      ));
      const action = needsDispatch(statuses);
      if (action === "in-flight") {
        result.in_flight += 1;
        continue;
      }
      if (action === "processed") {
        result.already_processed += 1;
        continue;
      }
      await dispatch(repository, pull.number, pull.headSha);
      result.dispatched += 1;
    }
  }

  return result;
}

async function dispatchPullRequest(
  controlRepository: string,
  token: string,
  repository: string,
  prNumber: number,
  headSha: string,
): Promise<void> {
  const safeRepository = repository.replace(/[^A-Za-z0-9_.-]/g, "-");
  const body = {
    event_type: "run-pr-governance",
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
      await dispatchPullRequest(controlRepository, dispatchToken, repository, prNumber, headSha);
    },
  );

  console.log(JSON.stringify(result));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
