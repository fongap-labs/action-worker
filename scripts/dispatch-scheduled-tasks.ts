import { createHash } from "node:crypto";
import { getGithubJson, githubEnvironment, githubExists, isJsonRecord } from "./github-api.ts";
import { repositoriesForCapability } from "./repository-policy.ts";
import { CliError, handleError, isMain, parseJson, runCommand } from "./runtime-command.ts";

export type TaskSourceManifest = {
  schema_version: "1";
  push: boolean;
  schedules: Array<{
    cron: string;
    projects: string[];
  }>;
};

export type ScheduledTask = {
  repository: string;
  head_sha: string;
  project: string;
  slot: string;
};

type DueProject = {
  project: string;
  slot: string;
};

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;
const projectPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const cronPattern = /^[0-9*/,?\- ]{1,128}$/;
const scheduleContextPrefix = "Task Schedule/";

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
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

function isWildcard(value: string): boolean {
  return value === "*" || value === "?";
}

function parseInteger(value: string, min: number, max: number, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new CliError(`Task source cron ${label} is invalid.`, 65);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new CliError(`Task source cron ${label} is out of range.`, 65);
  }
  return parsed;
}

function fieldValues(
  field: string,
  min: number,
  max: number,
  label: string,
  isSundaySevenAllowed = false
): Set<number> {
  if (!field || !cronPattern.test(field)) {
    throw new CliError(`Task source cron ${label} is invalid.`, 65);
  }

  const values = new Set<number>();
  for (const rawPart of field.split(",")) {
    if (!rawPart) {
      throw new CliError(`Task source cron ${label} is invalid.`, 65);
    }
    const segments = rawPart.split("/");
    if (segments.length > 2) {
      throw new CliError(`Task source cron ${label} step is invalid.`, 65);
    }
    const base = segments[0]!;
    const step =
      segments.length === 2 ? parseInteger(segments[1]!, 1, max - min + 1, `${label} step`) : 1;

    let start = min;
    let end = max;
    if (!isWildcard(base)) {
      const range = base.split("-");
      if (range.length > 2) {
        throw new CliError(`Task source cron ${label} range is invalid.`, 65);
      }
      if (range.length === 2) {
        start = parseInteger(range[0]!, min, isSundaySevenAllowed ? max + 1 : max, label);
        end = parseInteger(range[1]!, min, isSundaySevenAllowed ? max + 1 : max, label);
        if (start > end) {
          throw new CliError(`Task source cron ${label} range is reversed.`, 65);
        }
      } else {
        start = parseInteger(base, min, isSundaySevenAllowed ? max + 1 : max, label);
        end = segments.length === 2 ? max : start;
      }
    }

    for (let value = start; value <= end; value += step) {
      values.add(isSundaySevenAllowed && value === 7 ? 0 : value);
    }
  }
  return values;
}

function parseCron(cron: string): {
  fields: string[];
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
} {
  if (!cronPattern.test(cron)) {
    throw new CliError("Task source cron is invalid.", 65);
  }
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CliError("Task source cron must contain five fields.", 65);
  }
  return {
    fields,
    minute: fieldValues(fields[0]!, 0, 59, "minute"),
    hour: fieldValues(fields[1]!, 0, 23, "hour"),
    day: fieldValues(fields[2]!, 1, 31, "day-of-month"),
    month: fieldValues(fields[3]!, 1, 12, "month"),
    weekday: fieldValues(fields[4]!, 0, 6, "day-of-week", true),
  };
}

export function cronMatches(date: Date, cron: string): boolean {
  if (Number.isNaN(date.getTime())) {
    throw new CliError("Task source schedule time is invalid.", 64);
  }
  return matchesParsedCron(date, parseCron(cron));
}

function matchesParsedCron(date: Date, parsed: ReturnType<typeof parseCron>): boolean {
  if (
    !parsed.minute.has(date.getUTCMinutes()) ||
    !parsed.hour.has(date.getUTCHours()) ||
    !parsed.month.has(date.getUTCMonth() + 1)
  ) {
    return false;
  }

  const dayMatch = parsed.day.has(date.getUTCDate());
  const weekdayMatch = parsed.weekday.has(date.getUTCDay());
  const dayWildcard = isWildcard(parsed.fields[2]!);
  const weekdayWildcard = isWildcard(parsed.fields[4]!);

  if (dayWildcard && weekdayWildcard) return true;
  if (dayWildcard) return weekdayMatch;
  if (weekdayWildcard) return dayMatch;
  return dayMatch || weekdayMatch;
}

function minuteFloor(value: Date): Date {
  const date = new Date(value);
  date.setUTCSeconds(0, 0);
  return date;
}

function slotKey(value: Date): string {
  return `${value.toISOString().slice(0, 16)}Z`;
}

// GitHub starts scheduled workflows only every few hours on this account (gaps of 2.6 to 9.8 hours
// were observed), so the scheduler catches up the latest slot of each schedule that is at most this
// late, instead of only the slots of the last few minutes. Dispatches are deduplicated per slot.
export const maxLookbackMinutes = 1440;
export const defaultLookbackMinutes = 720;

export function projectsDueAt(
  manifest: TaskSourceManifest,
  now: Date,
  lookbackMinutes = defaultLookbackMinutes
): DueProject[] {
  if (
    !Number.isInteger(lookbackMinutes) ||
    lookbackMinutes < 1 ||
    lookbackMinutes > maxLookbackMinutes
  ) {
    throw new CliError(
      `Task source lookback must be between 1 and ${maxLookbackMinutes} minutes.`,
      64
    );
  }
  const current = minuteFloor(now);
  if (Number.isNaN(current.getTime())) {
    throw new CliError("Task source schedule time is invalid.", 64);
  }

  const due = new Map<string, string>();
  for (const schedule of manifest.schedules) {
    const parsed = parseCron(schedule.cron);
    let matched: Date | null = null;
    for (let offset = 0; offset < lookbackMinutes; offset += 1) {
      const candidate = new Date(current.getTime() - offset * 60_000);
      if (matchesParsedCron(candidate, parsed)) {
        matched = candidate;
        break;
      }
    }
    if (!matched) continue;
    const slot = slotKey(matched);
    for (const project of schedule.projects) {
      const previous = due.get(project);
      if (!previous || previous < slot) {
        due.set(project, slot);
      }
    }
  }

  return [...due.entries()]
    .map(([project, slot]) => ({ project, slot }))
    .sort((left, right) => left.project.localeCompare(right.project));
}

export function parseTaskSourceManifest(value: unknown): TaskSourceManifest {
  if (!isJsonRecord(value)) {
    throw new CliError("Task source manifest must be an object.", 65);
  }
  const allowed = new Set(["schema_version", "push", "schedules"]);
  const keys = Object.keys(value);
  if (
    keys.some((key) => !allowed.has(key)) ||
    !("schema_version" in value) ||
    !("schedules" in value) ||
    value.schema_version !== "1" ||
    (value.push !== undefined && typeof value.push !== "boolean") ||
    !Array.isArray(value.schedules) ||
    value.schedules.length > 32
  ) {
    throw new CliError("Task source manifest is invalid.", 65);
  }

  const schedules = value.schedules.map((raw) => {
    if (!isJsonRecord(raw)) {
      throw new CliError("Task source schedule must be an object.", 65);
    }
    exactKeys(raw, ["cron", "projects"], "Task source schedule");
    if (
      typeof raw.cron !== "string" ||
      !cronPattern.test(raw.cron) ||
      !Array.isArray(raw.projects) ||
      raw.projects.length < 1 ||
      raw.projects.length > 64 ||
      !raw.projects.every((item) => typeof item === "string" && projectPattern.test(item)) ||
      new Set(raw.projects).size !== raw.projects.length
    ) {
      throw new CliError("Task source schedule is invalid.", 65);
    }
    parseCron(raw.cron);
    return {
      cron: raw.cron,
      projects: raw.projects as string[],
    };
  });

  return { schema_version: "1", push: value.push === true, schedules };
}

export function projectsForSchedule(manifest: TaskSourceManifest, cron: string): string[] {
  parseCron(cron);
  return [
    ...new Set(
      manifest.schedules.filter((entry) => entry.cron === cron).flatMap((entry) => entry.projects)
    ),
  ].sort();
}

async function defaultHead(repository: string, token: string): Promise<string> {
  const repositoryValue = await getGithubJson(`repos/${repository}`, token);
  if (!isJsonRecord(repositoryValue)) {
    throw new CliError(`GitHub repository response is invalid: ${repository}.`, 65);
  }
  const defaultBranch =
    typeof repositoryValue.default_branch === "string" ? repositoryValue.default_branch : "";
  if (!defaultBranch) {
    throw new CliError(`Repository default branch is unavailable: ${repository}.`, 65);
  }
  const commitValue = await getGithubJson(`repos/${repository}/commits/${defaultBranch}`, token);
  if (
    !isJsonRecord(commitValue) ||
    typeof commitValue.sha !== "string" ||
    !shaPattern.test(commitValue.sha)
  ) {
    throw new CliError(`Repository default head SHA is invalid: ${repository}.`, 65);
  }
  return commitValue.sha;
}

export async function resolveScheduledTasks(
  policyValue: unknown,
  now: Date,
  lookbackMinutes: number,
  controlRepository: string,
  token: string
): Promise<ScheduledTask[]> {
  if (!repositoryPattern.test(controlRepository)) {
    throw new CliError("Control repository is invalid.", 64);
  }
  if (!token) {
    throw new CliError("AW_CONTROL_TOKEN is required.", 77);
  }

  const tasks: ScheduledTask[] = [];
  const repositories = repositoriesForCapability(policyValue, "task").filter(
    (repository) => repository !== controlRepository
  );

  for (const repository of repositories) {
    const headSha = await defaultHead(repository, token);
    const manifestPath = `repos/${repository}/contents/.github/task-source.json?ref=${headSha}`;
    if (!(await githubExists(manifestPath, token))) {
      continue;
    }
    const manifest = parseTaskSourceManifest(
      parseJson(
        decodeGithubContent(await getGithubJson(manifestPath, token)),
        `Task source manifest must be valid JSON: ${repository}.`,
        65
      )
    );
    for (const due of projectsDueAt(manifest, now, lookbackMinutes)) {
      const taskPath = `repos/${repository}/contents/projects/${encodeURIComponent(due.project)}/task.json?ref=${headSha}`;
      if (!(await githubExists(taskPath, token))) {
        throw new CliError(
          `Scheduled project is missing task.json: ${repository}/projects/${due.project}/task.json.`,
          66
        );
      }
      tasks.push({
        repository,
        head_sha: headSha,
        project: due.project,
        slot: due.slot,
      });
    }
  }

  return tasks.sort(
    (left, right) =>
      left.repository.localeCompare(right.repository) ||
      left.project.localeCompare(right.project) ||
      left.slot.localeCompare(right.slot)
  );
}

function scheduleContext(project: string): string {
  return `${scheduleContextPrefix}${project}`;
}

function scheduleDescription(slot: string): string {
  return `Task dispatched for ${slot}`;
}

function commitShas(value: unknown, repository: string): string[] {
  if (!Array.isArray(value)) {
    throw new CliError(`GitHub commit list is invalid: ${repository}.`, 65);
  }
  return value.map((item) => {
    const sha = isJsonRecord(item) && typeof item.sha === "string" ? item.sha : "";
    if (!shaPattern.test(sha)) {
      throw new CliError(`GitHub commit list is invalid: ${repository}.`, 65);
    }
    return sha;
  });
}

/**
 * The dispatch of a slot is recorded on the default-branch head of that moment, which is the head
 * of the slot time or a later one. Look at every one of those heads, so a new commit on the default
 * branch does not make an already dispatched slot run again.
 */
export async function wasDispatched(
  task: ScheduledTask,
  get: (path: string) => Promise<unknown>
): Promise<boolean> {
  const slotTime = `${task.slot.slice(0, 16)}:00Z`;
  const base = `repos/${task.repository}/commits?sha=${task.head_sha}`;
  const heads = new Set([
    task.head_sha,
    ...commitShas(await get(`${base}&since=${slotTime}&per_page=100`), task.repository),
    ...commitShas(await get(`${base}&until=${slotTime}&per_page=1`), task.repository),
  ]);
  const context = scheduleContext(task.project);
  const description = scheduleDescription(task.slot);
  for (const sha of heads) {
    const value = await get(`repos/${task.repository}/commits/${sha}/status`);
    if (!isJsonRecord(value) || !Array.isArray(value.statuses)) {
      throw new CliError(`GitHub task schedule status is invalid: ${task.repository}.`, 65);
    }
    const isRecorded = value.statuses.some(
      (item) =>
        isJsonRecord(item) &&
        item.context === context &&
        item.state === "success" &&
        item.description === description
    );
    if (isRecorded) return true;
  }
  return false;
}

async function markDispatched(task: ScheduledTask, token: string): Promise<void> {
  const payload = JSON.stringify({
    state: "success",
    context: scheduleContext(task.project),
    description: scheduleDescription(task.slot),
    target_url:
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : undefined,
  });
  await runCommand(
    "gh",
    [
      "api",
      "--method",
      "POST",
      `repos/${task.repository}/statuses/${task.head_sha}`,
      "--input",
      "-",
    ],
    {
      env: githubEnvironment(token),
      input: payload,
      timeoutMs: 30_000,
      maxBuffer: 1024 * 1024,
    }
  );
}

async function dispatchTask(
  controlRepository: string,
  token: string,
  task: ScheduledTask
): Promise<void> {
  const identity = createHash("sha256")
    .update(`${task.repository}\n${task.project}\n${task.slot}\n${task.head_sha}`)
    .digest("hex")
    .slice(0, 32);
  const body = {
    event_type: "run-task",
    client_payload: {
      schema_version: "1",
      request_id: `task-schedule-${identity}`,
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
    }
  );
}

async function main(): Promise<void> {
  const policyRaw = process.env.AW_REPOSITORY_POLICY ?? "";
  const controlToken = process.env.AW_CONTROL_TOKEN ?? "";
  const ingressToken = process.env.AW_INGRESS_TOKEN ?? "";
  const controlRepository = process.env.AW_CONTROL_REPOSITORY ?? "";
  const nowRaw = process.env.TASK_SOURCE_NOW ?? "";
  const lookbackRaw = process.env.TASK_SOURCE_LOOKBACK_MINUTES ?? String(defaultLookbackMinutes);
  const now = nowRaw ? new Date(nowRaw) : new Date();
  const lookbackMinutes = Number(lookbackRaw);

  if (!policyRaw || !controlToken || !ingressToken || !controlRepository) {
    throw new CliError(
      "AW_REPOSITORY_POLICY, AW_CONTROL_TOKEN, AW_INGRESS_TOKEN, and AW_CONTROL_REPOSITORY are required.",
      64
    );
  }
  if (
    Number.isNaN(now.getTime()) ||
    !Number.isInteger(lookbackMinutes) ||
    lookbackMinutes < 1 ||
    lookbackMinutes > maxLookbackMinutes
  ) {
    throw new CliError("Task scheduler time or lookback is invalid.", 64);
  }

  const tasks = await resolveScheduledTasks(
    parseJson(policyRaw, "AW_REPOSITORY_POLICY must be valid JSON.", 65),
    now,
    lookbackMinutes,
    controlRepository,
    controlToken
  );

  let dispatched = 0;
  let deduplicated = 0;
  for (const task of tasks) {
    if (await wasDispatched(task, (path) => getGithubJson(path, controlToken))) {
      deduplicated += 1;
      continue;
    }
    await dispatchTask(controlRepository, ingressToken, task);
    await markDispatched(task, controlToken);
    dispatched += 1;
  }
  console.log(
    JSON.stringify({
      now: minuteFloor(now).toISOString(),
      lookback_minutes: lookbackMinutes,
      due: tasks.length,
      dispatched,
      deduplicated,
      tasks,
    })
  );
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
