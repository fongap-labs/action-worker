import { readFileSync } from "node:fs";
import { isJsonRecord } from "./github-api.ts";
import { hasRepositoryCapability, readRepositoryPolicyText } from "./repository-policy.ts";
import { appendLines, CliError, handleError, isMain, parseJson } from "./runtime-command.ts";

const CONTROLLER = "fongap-labs/action-worker";
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^fongap-labs\/[A-Za-z0-9_.-]{1,100}$/;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

type AgentAuthorization = {
  schema_version: 1;
  enabled: boolean;
  repository_owner: "fongap-labs";
  operation: "task";
  authorized_actors: Array<{ login: string; id: number }>;
};
export type AgentRequest = {
  repository: string;
  repository_name: string;
  project: string;
  request_id: string;
};

export function parseAgentAuthorization(input: unknown): AgentAuthorization {
  if (
    !isJsonRecord(input) ||
    input.schema_version !== 1 ||
    input.enabled !== true ||
    input.repository_owner !== "fongap-labs" ||
    input.operation !== "task" ||
    !Array.isArray(input.authorized_actors) ||
    input.authorized_actors.length === 0 ||
    input.authorized_actors.length > 10
  ) {
    throw new CliError("Agent admission policy is invalid or disabled.", 77);
  }
  const actors = input.authorized_actors;
  if (
    !actors.every(
      (actor) =>
        isJsonRecord(actor) &&
        typeof actor.login === "string" &&
        /^[A-Za-z0-9-]{1,39}$/.test(actor.login) &&
        Number.isSafeInteger(actor.id) &&
        Number(actor.id) > 0
    ) ||
    new Set(actors.map((actor) => actor.id)).size !== actors.length
  ) {
    throw new CliError("Agent authorized actor identities are invalid.", 77);
  }
  return input as AgentAuthorization;
}

export function validateAgentRequest(
  event: unknown,
  env: {
    eventName: string;
    repository: string;
    ref: string;
    actor: string;
    actorId: string;
    triggeringActor: string;
    runId: string;
    attempt: string;
  },
  policyInput: unknown,
  repositoryPolicy: unknown
): AgentRequest {
  const policy = parseAgentAuthorization(policyInput);
  if (
    env.eventName !== "workflow_dispatch" ||
    env.repository !== CONTROLLER ||
    env.ref !== "refs/heads/main" ||
    !isJsonRecord(event)
  ) {
    throw new CliError(
      "Only the protected control repository main workflow may submit Agent tasks.",
      77
    );
  }
  // GitHub's workflow_dispatch payload may omit sender. The GitHub-owned
  // ACTOR_ID is authoritative; user-controlled inputs are never identity proof.
  // A rerun by a different triggering actor must not inherit the original actor's rights.
  if (
    !isJsonRecord(event.repository) ||
    event.repository.full_name !== CONTROLLER ||
    env.triggeringActor !== env.actor ||
    !policy.authorized_actors.some(
      (actor) => actor.login === env.actor && String(actor.id) === env.actorId
    ) ||
    (event.sender !== undefined &&
      (!isJsonRecord(event.sender) ||
        event.sender.login !== env.actor ||
        String(event.sender.id) !== env.actorId ||
        event.sender.type !== "User"))
  ) {
    throw new CliError(
      "The authenticated GitHub account is not authorized for private Agent dispatch.",
      77
    );
  }
  if (
    !isJsonRecord(event.inputs) ||
    Object.keys(event.inputs).sort().join(",") !== "project,repository"
  ) {
    throw new CliError("Agent task inputs must contain only repository and project.", 64);
  }
  const repository = event.inputs.repository;
  const project = event.inputs.project;
  if (
    typeof repository !== "string" ||
    !REPO.test(repository) ||
    typeof project !== "string" ||
    !PROJECT.test(project)
  ) {
    throw new CliError("Invalid Agent task repository or project.", 64);
  }
  if (!hasRepositoryCapability(repository, repositoryPolicy, "task")) {
    throw new CliError("Target repository is not granted the central task capability.", 77);
  }
  if (!/^\d{1,20}$/.test(env.runId) || !/^\d{1,8}$/.test(env.attempt)) {
    throw new CliError("GitHub run identity is unavailable.", 65);
  }
  const repositoryName = repository.split("/")[1];
  if (!repositoryName) throw new CliError("Invalid repository identity.", 64);
  return {
    repository,
    repository_name: repositoryName,
    project,
    request_id: `agent-${env.runId}-${env.attempt}`,
  };
}

type ApiResponse = Record<string, unknown>;
async function githubGet(token: string, path: string): Promise<ApiResponse> {
  const url = new URL(`https://api.github.com/${path}`);
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new CliError(`GitHub source validation returned HTTP ${response.status}.`, 75);
  return (await response.json()) as ApiResponse;
}

export async function resolveTrustedSourceSha(
  repository: string,
  token: string,
  fetcher: typeof githubGet = githubGet
): Promise<string> {
  if (!REPO.test(repository)) throw new CliError("Invalid repository.", 64);
  const metadata = await fetcher(token, `repos/${repository}`);
  if (
    metadata.default_branch !== "main" ||
    metadata.archived === true ||
    metadata.disabled === true
  ) {
    throw new CliError("Target repository is not an active main-branch project.", 77);
  }
  const commit = await fetcher(token, `repos/${repository}/commits/main`);
  if (typeof commit.sha !== "string" || !SHA.test(commit.sha)) {
    throw new CliError("Target main SHA is not available.", 75);
  }
  return commit.sha;
}

export function agentDispatchPayload(request: AgentRequest, sha: string): Record<string, unknown> {
  if (!SHA.test(sha)) throw new CliError("Invalid trusted source SHA.", 64);
  return {
    event_type: "run-task",
    client_payload: {
      schema_version: "1",
      repository: request.repository,
      project: request.project,
      request_id: request.request_id,
      bootstrap_ref: sha,
      agent_domain: "coding",
      operation: "task",
    },
  };
}

export async function dispatchAgentTask(
  payload: Record<string, unknown>,
  token: string
): Promise<void> {
  if (!token) throw new CliError("Scoped fongap-bot dispatch credential missing.", 77);
  const response = await fetch(`https://api.github.com/repos/${CONTROLLER}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status !== 204) {
    // Never log the GitHub error body: it may contain request material.
    throw new CliError(
      `Central fongap-bot task dispatch was not acknowledged (HTTP ${response.status}).`,
      75
    );
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "";
  if (mode !== "admit" && mode !== "dispatch") {
    throw new CliError("Usage: agent-task-ingress.ts admit|dispatch", 64);
  }
  const sourceEvent = process.env.GITHUB_EVENT_PATH;
  if (!sourceEvent) throw new CliError("Trusted GitHub event is unavailable.", 65);
  const event = parseJson(readFileSync(sourceEvent, "utf8"), "Invalid GitHub event.", 65);
  const policy = parseJson(
    readFileSync("policies/agent-ingress.json", "utf8"),
    "Agent ingress policy is invalid.",
    65
  );
  const repositoryPolicy = parseJson(readRepositoryPolicyText(), "Invalid repository policy.", 65);
  const request = validateAgentRequest(
    event,
    {
      eventName: process.env.GITHUB_EVENT_NAME ?? "",
      repository: process.env.GITHUB_REPOSITORY ?? "",
      ref: process.env.GITHUB_REF ?? "",
      actor: process.env.GITHUB_ACTOR ?? "",
      actorId: process.env.GITHUB_ACTOR_ID ?? "",
      triggeringActor: process.env.GITHUB_TRIGGERING_ACTOR ?? "",
      runId: process.env.GITHUB_RUN_ID ?? "",
      attempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
    },
    policy,
    repositoryPolicy
  );

  if (mode === "admit") {
    await appendLines(process.env.GITHUB_OUTPUT, [
      `repository=${request.repository}`,
      `repository_name=${request.repository_name}`,
      `project=${request.project}`,
      `request_id=${request.request_id}`,
    ]);
    console.log("Authorized private Agent task request admitted.");
    return;
  }

  const sourceToken = process.env.AW_AGENT_SOURCE_READ_TOKEN ?? "";
  const dispatchToken = process.env.AW_AGENT_DISPATCH_WRITE_TOKEN ?? "";
  if (!sourceToken || !dispatchToken) throw new CliError("Scoped App tokens are missing.", 77);
  const sha = await resolveTrustedSourceSha(request.repository, sourceToken);
  await dispatchAgentTask(agentDispatchPayload(request, sha), dispatchToken);
  await appendLines(process.env.GITHUB_STEP_SUMMARY, [
    "## Private Agent task accepted",
    "",
    `- Repository: \`${request.repository}\``,
    `- Project: \`${request.project}\``,
    `- Trusted main SHA: \`${sha}\``,
    `- Request: \`${request.request_id}\``,
    "- Result: GitHub dispatch acknowledged; execution still requires central task validation.",
    "",
    "Follow the central handle-task-dispatch.yml workflow for the final result.",
  ]);
  console.log("Private Agent task delivered to Action Worker.");
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
