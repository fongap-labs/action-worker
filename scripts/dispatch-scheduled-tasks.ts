import {
  getGithubJson,
  githubEnvironment,
  githubExists,
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

export type TaskSourceManifest = {
  schema_version: "1";
  schedules: Array<{
    cron: string;
    projects: string[];
  }>;
};

export type ScheduledTask = {
  repository: string;
  head_sha: string;
  project: string;
};

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;
const projectPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const cronPattern = /^[0-9*/,?\- ]{1,128}$/;

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((item, index) => item !== wanted[index])) {
    throw new CliError(`${label} keys are invalid.`, 65);
  }
}

function decodeGithubContent(value: unknown): string {
  if (!isJsonRecord(value) || value.encoding !== "base64" || typeof value.content !== "string") {
    throw new CliError("GitHub task source manifest response is invalid.", 65);
  }
  return Buffer.from(value.content.replace(/\s+/g, ""), "base64").toString("utf8");
}

export function parseTaskSourceManifest(value: unknown): TaskSourceManifest {
  if (!isJsonRecord(value)) {
    throw new CliError("Task source manifest must be an object.", 65);
  }
  exactKeys(value, ["schema_version", "schedules"], "Task source manifest");
  if (value.schema_version !== "1" || !Array.isArray(value.schedules) || value.schedules.length > 32) {
    throw new CliError("Task source manifest is invalid.", 65);
  }

  const schedules = value.schedules.map((raw) => {
    if (!isJsonRecord(raw)) {
      throw new CliError("Task source schedule must be an object.", 65);
    }
    exactKeys(raw, ["cron", "projects"], "Task source schedule");
    if (typeof raw.cron !== "string" || !cronPattern.test(raw.cron)
      || !Array.isArray(raw.projects)
      || raw.projects.length < 1
      || raw.projects.length > 64
      || !raw.projects.every((item) => typeof item === "string" && projectPattern.test(item))
      || new Set(raw.projects).size !== raw.projects.length
    ) {
      throw new CliError("Task source schedule is invalid.", 65);
    }
    return {
      cron: raw.cron,
      projects: raw.projects as string[],
    };
  });

  return { schema_version: "1", schedules };
}

export function projectsForSchedule(manifest: TaskSourceManifest, cron: string): string[] {
  if (!cronPattern.test(cron)) {
    throw new CliError("Task source cron is invalid.", 64);
  }
  return [...new Set(
    manifest.schedules
      .filter((entry) => entry.cron === cron)
      .flatMap((entry) => entry.projects),
  )].sort();
}

async function defaultHead(repository: string, token: string): Promise<string> {
  const repositoryValue = await getGithubJson(`repos/${repository}`, token);
  if (!isJsonRecord(repositoryValue)) {
    throw new CliError(`GitHub repository response is invalid: ${repository}.`, 65);
  }
  const defaultBranch = typeof repositoryValue.default_branch === "string"
    ? repositoryValue.default_branch
    : "";
  if (!defaultBranch) {
    throw new CliError(`Repository default branch is unavailable: ${repository}.`, 65);
  }
  const commitValue = await getGithubJson(`repos/${repository}/commits/${defaultBranch}`, token);
  if (!isJsonRecord(commitValue) || typeof commitValue.sha !== "string" || !shaPattern.test(commitValue.sha)) {
    throw new CliError(`Repository default head SHA is invalid: ${repository}.`, 65);
  }
  return commitValue.sha;
}

export async function resolveScheduledTasks(
  policyValue: unknown,
  cron: string,
  controlRepository: string,
  token: string,
): Promise<ScheduledTask[]> {
  if (!repositoryPattern.test(controlRepository)) {
    throw new CliError("Control repository is invalid.", 64);
  }
  if (!token) {
    throw new CliError("AW_CONTROL_TOKEN is required.", 77);
  }

  const tasks: ScheduledTask[] = [];
  const repositories = repositoriesForCapability(policyValue, "task")
    .filter((repository) => repository !== controlRepository);

  for (const repository of repositories) {
    const headSha = await defaultHead(repository, token);
    const manifestPath = `repos/${repository}/contents/.github/task-source.json?ref=${headSha}`;
    if (!await githubExists(manifestPath, token)) {
      continue;
    }
    const manifest = parseTaskSourceManifest(
      parseJson(
        decodeGithubContent(await getGithubJson(manifestPath, token)),
        `Task source manifest must be valid JSON: ${repository}.`,
        65,
      ),
    );
    for (const project of projectsForSchedule(manifest, cron)) {
      const taskPath = `repos/${repository}/contents/projects/${encodeURIComponent(project)}/task.json?ref=${headSha}`;
      if (!await githubExists(taskPath, token)) {
        throw new CliError(
          `Scheduled project is missing task.json: ${repository}/projects/${project}/task.json.`,
          66,
        );
      }
      tasks.push({ repository, head_sha: headSha, project });
    }
  }

  return tasks.sort((left, right) =>
    left.repository.localeCompare(right.repository) || left.project.localeCompare(right.project)
  );
}

async function dispatchTask(
  controlRepository: string,
  token: string,
  task: ScheduledTask,
  index: number,
): Promise<void> {
  const safeRepository = task.repository.replace(/[^A-Za-z0-9_.-]/g, "-");
  const body = {
    event_type: "run-task",
    client_payload: {
      schema_version: "1",
      request_id: `task-schedule:${safeRepository}:${task.project}:${task.head_sha.slice(0, 12)}:${index}`,
      project: task.project,
      bootstrap_ref: task.head_sha,
      repository: task.repository,
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
  const cron = process.env.TASK_SOURCE_SCHEDULE ?? "";
  if (!policyRaw || !controlToken || !ingressToken || !controlRepository || !cron) {
    throw new CliError(
      "AW_REPOSITORY_POLICY, AW_CONTROL_TOKEN, AW_INGRESS_TOKEN, AW_CONTROL_REPOSITORY, and TASK_SOURCE_SCHEDULE are required.",
      64,
    );
  }

  const tasks = await resolveScheduledTasks(
    parseJson(policyRaw, "AW_REPOSITORY_POLICY must be valid JSON.", 65),
    cron,
    controlRepository,
    controlToken,
  );
  for (let index = 0; index < tasks.length; index += 1) {
    await dispatchTask(controlRepository, ingressToken, tasks[index]!, index + 1);
  }
  console.log(JSON.stringify({ schedule: cron, dispatched: tasks.length, tasks }));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
