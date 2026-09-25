import {
  GithubReader,
  getJsonString,
  githubEnvironment,
  githubExists,
  isJsonRecord,
} from "./github-api.ts";
import { repositoriesForCapability } from "./repository-policy.ts";
import { parseTaskSourceManifest } from "./dispatch-scheduled-tasks.ts";
import {
  CliError,
  handleError,
  isMain,
  parseJson,
  runCommand,
} from "./runtime-command.ts";

type GithubSource = {
  get(path: string): Promise<unknown>;
  exists(path: string): Promise<boolean>;
};

type Dispatch = (repository: string, beforeSha: string, headSha: string) => Promise<void>;

export type TaskIntakeResult = {
  repositories: number;
  push_enabled: number;
  dispatched: number;
  in_flight: number;
  already_processed: number;
};

const shaPattern = /^[0-9a-f]{40}$/;
const zeroSha = "0".repeat(40);

function decodeGithubContent(value: unknown): string {
  if (!isJsonRecord(value) || value.encoding !== "base64" || typeof value.content !== "string") {
    throw new CliError("GitHub task source manifest response is invalid.", 65);
  }
  return Buffer.from(value.content.replace(/\s+/g, ""), "base64").toString("utf8");
}

function latestTaskStatus(value: unknown): string {
  if (!isJsonRecord(value) || !Array.isArray(value.statuses)) {
    throw new CliError("GitHub commit status response is invalid.", 65);
  }
  for (const item of value.statuses) {
    if (!isJsonRecord(item)) continue;
    if (getJsonString(item, "context") === "Task Source") {
      return getJsonString(item, "state");
    }
  }
  return "";
}

function taskState(value: unknown): "dispatch" | "in-flight" | "processed" {
  const state = latestTaskStatus(value);
  if (state === "pending") return "in-flight";
  if (state === "success") return "processed";
  return "dispatch";
}

async function defaultHead(
  source: GithubSource,
  repository: string,
): Promise<{ head_sha: string; before_sha: string }> {
  const repo = await source.get(`repos/${repository}`);
  if (!isJsonRecord(repo)) {
    throw new CliError(`GitHub repository response is invalid: ${repository}.`, 65);
  }
  const branch = getJsonString(repo, "default_branch");
  if (!branch) {
    throw new CliError(`Repository default branch is unavailable: ${repository}.`, 65);
  }

  const commit = await source.get(`repos/${repository}/commits/${branch}`);
  if (!isJsonRecord(commit)) {
    throw new CliError(`GitHub commit response is invalid: ${repository}.`, 65);
  }
  const headSha = getJsonString(commit, "sha");
  if (!shaPattern.test(headSha)) {
    throw new CliError(`Repository default head SHA is invalid: ${repository}.`, 65);
  }

  let beforeSha = zeroSha;
  if (Array.isArray(commit.parents) && commit.parents.length > 0) {
    const parent = commit.parents[0];
    if (!isJsonRecord(parent)) {
      throw new CliError(`Repository default head parent is invalid: ${repository}.`, 65);
    }
    beforeSha = getJsonString(parent, "sha");
    if (!shaPattern.test(beforeSha)) {
      throw new CliError(`Repository default head parent SHA is invalid: ${repository}.`, 65);
    }
  }

  return { head_sha: headSha, before_sha: beforeSha };
}

export async function scanTaskSources(
  policyValue: unknown,
  source: GithubSource,
  dispatch: Dispatch,
  excludedRepository = "",
): Promise<TaskIntakeResult> {
  const repositories = repositoriesForCapability(policyValue, "task")
    .filter((repository) => repository !== excludedRepository);
  const result: TaskIntakeResult = {
    repositories: repositories.length,
    push_enabled: 0,
    dispatched: 0,
    in_flight: 0,
    already_processed: 0,
  };

  for (const repository of repositories) {
    const facts = await defaultHead(source, repository);
    const manifestPath =
      `repos/${repository}/contents/.github/task-source.json?ref=${facts.head_sha}`;
    if (!await source.exists(manifestPath)) {
      continue;
    }

    const manifest = parseTaskSourceManifest(
      parseJson(
        decodeGithubContent(await source.get(manifestPath)),
        `Task source manifest must be valid JSON: ${repository}.`,
        65,
      ),
    );
    if (!manifest.push) {
      continue;
    }
    result.push_enabled += 1;

    const status = await source.get(
      `repos/${repository}/commits/${facts.head_sha}/status`,
    );
    const state = taskState(status);
    if (state === "in-flight") {
      result.in_flight += 1;
      continue;
    }
    if (state === "processed") {
      result.already_processed += 1;
      continue;
    }

    await dispatch(repository, facts.before_sha, facts.head_sha);
    result.dispatched += 1;
  }

  return result;
}

async function dispatchTaskSource(
  controlRepository: string,
  token: string,
  repository: string,
  beforeSha: string,
  headSha: string,
): Promise<void> {
  const safeRepository = repository.replace(/[^A-Za-z0-9_.-]/g, "-");
  const body = {
    event_type: "run-task-source",
    client_payload: {
      schema_version: "1",
      request_id: `task-intake:${safeRepository}:${headSha.slice(0, 12)}`,
      repository,
      mode: "push",
      project: "",
      before_sha: beforeSha,
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
  const result = await scanTaskSources(
    parseJson(policyRaw, "AW_REPOSITORY_POLICY must be valid JSON.", 65),
    {
      get: async (path) => await reader.get(path),
      exists: async (path) => await githubExists(path, controlToken),
    },
    async (repository, beforeSha, headSha) => {
      await dispatchTaskSource(
        controlRepository,
        ingressToken,
        repository,
        beforeSha,
        headSha,
      );
    },
    controlRepository,
  );
  console.log(JSON.stringify(result));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
