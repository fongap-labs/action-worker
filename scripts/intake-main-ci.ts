import {
  GithubReader,
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

type Dispatch = (repository: string, headSha: string) => Promise<void>;

export type CiIntakeResult = {
  repositories: number;
  dispatched: number;
  in_flight: number;
  already_processed: number;
};

const shaPattern = /^[0-9a-f]{40}$/;

function latestStatus(value: unknown, context: string): string {
  if (!isJsonRecord(value) || !Array.isArray(value.statuses)) {
    throw new CliError("GitHub commit status response is invalid.", 65);
  }
  for (const item of value.statuses) {
    if (!isJsonRecord(item)) continue;
    if (getJsonString(item, "context") === context) {
      return getJsonString(item, "state");
    }
  }
  return "";
}

function ciState(value: unknown): "dispatch" | "in-flight" | "processed" {
  const canonical = latestStatus(value, "CI Evidence");
  const compatibility = latestStatus(value, "ci-evidence");
  const state = canonical || compatibility;
  if (state === "pending") return "in-flight";
  if (state) return "processed";
  return "dispatch";
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
): Promise<CiIntakeResult> {
  const repositories = repositoriesForCapability(policyValue, "pr");
  const result: CiIntakeResult = {
    repositories: repositories.length,
    dispatched: 0,
    in_flight: 0,
    already_processed: 0,
  };

  for (const repository of repositories) {
    const headSha = await defaultHead(reader, repository);
    const status = await reader.get(`repos/${repository}/commits/${headSha}/status`);
    const state = ciState(status);
    if (state === "in-flight") {
      result.in_flight += 1;
      continue;
    }
    if (state === "processed") {
      result.already_processed += 1;
      continue;
    }
    await dispatch(repository, headSha);
    result.dispatched += 1;
  }

  return result;
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
  );

  console.log(JSON.stringify(result));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
