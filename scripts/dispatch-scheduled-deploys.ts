import { createHash } from "node:crypto";
import { hasVerifiedCiEvidence, type JsonReader, latestCiStatus } from "./ci-evidence.ts";
import { latestCronSlot, minuteFloor, parseCronSchedule, slotKey } from "./cron-schedule.ts";
import { parseDeployPlan } from "./deploy-manifest.ts";
import {
  assertNoRequiredReviewers,
  deployEventType,
  parseDeployPolicy,
} from "./dispatch-central-deploy.ts";
import {
  GithubReader,
  getJsonArray,
  getJsonString,
  githubEnvironment,
  isJsonRecord,
} from "./github-api.ts";
import { type ContentReader, discoverProducts } from "./product-discovery.ts";
import { repositoriesForCapability } from "./repository-policy.ts";
import {
  appendLines,
  CliError,
  handleError,
  isMain,
  parseJson,
  readJson,
  runCommand,
} from "./runtime-command.ts";

export type ScheduledDeployTarget = {
  repository: string;
  // The product directory name, or the empty string for the root layout.
  product: string;
  environment: string;
  // The cron expressions of the environment's schedule.
  schedule: readonly string[];
};

type DeployResult = {
  repository: string;
  product: string;
  environment: string;
  slot_utc: string;
  slot_beijing: string;
  commit: string;
  result: string;
};

export type ScheduledDeploy = ScheduledDeployTarget & {
  head_sha: string;
  // The slot is the UTC minute of the latest firing, as slotKey writes it.
  slot: string;
  slot_time: Date;
};

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;
const scheduleContextPrefix = "Deploy Schedule/";

// The same bounds as task schedules: a slot up to 12 hours late still runs once.
export const defaultLookbackMinutes = 720;
export const maxLookbackMinutes = 1440;

// The dedupe status names the product only when there is one, so the root layout keeps
// "Deploy Schedule/<environment>" and a product keeps "Deploy Schedule/<product>/<environment>".
export function scheduleContext(product: string, environment: string): string {
  return product === ""
    ? `${scheduleContextPrefix}${environment}`
    : `${scheduleContextPrefix}${product}/${environment}`;
}

export function scheduleDescription(slot: string): string {
  return `Deploy dispatched for ${slot}`;
}

/**
 * The latest firing of any of the schedules within the lookback. Only that slot is dispatched, so a
 * late run never replays several missed firings of one environment.
 */
export function latestScheduledSlot(
  schedules: readonly string[],
  now: Date,
  lookbackMinutes: number
): Date | null {
  let latest: Date | null = null;
  for (const cron of schedules) {
    const matched = latestCronSlot(
      parseCronSchedule(cron, "Deploy schedule"),
      now,
      lookbackMinutes
    );
    if (matched && (latest === null || matched.getTime() > latest.getTime())) {
      latest = matched;
    }
  }
  return latest;
}

// Every product environment of one repository whose manifest declares a schedule, read at HEAD.
export async function scheduledDeployTargets(
  reader: ContentReader,
  repository: string,
  sha: string,
  controlRepository: string
): Promise<ScheduledDeployTarget[]> {
  const discovery = await discoverProducts(reader, repository, sha);
  const targets: ScheduledDeployTarget[] = [];
  for (const product of discovery.products) {
    const text = product.files["deploy.json"];
    if (text === undefined) {
      continue;
    }
    const plan = parseDeployPlan(text, repository);
    for (const environment of plan.environments) {
      if (environment.declares_triggers) {
        await assertNoRequiredReviewers(reader, controlRepository, environment.environment);
      }
      if (environment.schedule.length > 0) {
        targets.push({
          repository,
          product: product.name,
          environment: environment.environment,
          schedule: [...environment.schedule],
        });
      }
    }
  }
  return targets;
}

async function defaultHead(reader: ContentReader, repository: string): Promise<string> {
  const repositoryValue = await reader.get(`repos/${repository}`);
  const defaultBranch = getJsonString(repositoryValue, "default_branch");
  if (!defaultBranch) {
    throw new CliError(`Repository default branch is unavailable: ${repository}.`, 65);
  }
  const commit = await reader.get(`repos/${repository}/commits/${defaultBranch}`);
  const sha = getJsonString(commit, "sha");
  if (!shaPattern.test(sha)) {
    throw new CliError(`Repository default head SHA is invalid: ${repository}.`, 65);
  }
  return sha;
}

// Only the default branch is scheduled: a deploy names the head of the moment, never an older one.
export async function resolveScheduledDeploys(
  policyValue: unknown,
  now: Date,
  lookbackMinutes: number,
  controlRepository: string,
  reader: ContentReader
): Promise<ScheduledDeploy[]> {
  const repositories = repositoriesForCapability(policyValue, "deploy").filter(
    (repository) => repository !== controlRepository
  );
  const deploys: ScheduledDeploy[] = [];
  for (const repository of repositories) {
    const headSha = await defaultHead(reader, repository);
    for (const target of await scheduledDeployTargets(
      reader,
      repository,
      headSha,
      controlRepository
    )) {
      const slot = latestScheduledSlot(target.schedule, now, lookbackMinutes);
      if (!slot) {
        continue;
      }
      deploys.push({ ...target, head_sha: headSha, slot: slotKey(slot), slot_time: slot });
    }
  }
  return deploys.sort(
    (left, right) =>
      left.repository.localeCompare(right.repository) ||
      left.product.localeCompare(right.product) ||
      left.environment.localeCompare(right.environment)
  );
}

function commitShas(value: unknown, repository: string): string[] {
  return getJsonArray(value).map((item) => {
    const sha = isJsonRecord(item) && typeof item.sha === "string" ? item.sha : "";
    if (!shaPattern.test(sha)) {
      throw new CliError(`GitHub commit list is invalid: ${repository}.`, 65);
    }
    return sha;
  });
}

/**
 * A slot is recorded on the default-branch head of the slot time or a later one, so look at every
 * one of those heads. A new commit does not make an already dispatched slot run again.
 */
export async function wasScheduledDeployDispatched(
  deploy: ScheduledDeploy,
  get: (path: string) => Promise<unknown>
): Promise<boolean> {
  const slotTime = `${deploy.slot.slice(0, 16)}:00Z`;
  const base = `repos/${deploy.repository}/commits?sha=${deploy.head_sha}`;
  const heads = new Set([
    deploy.head_sha,
    ...commitShas(await get(`${base}&since=${slotTime}&per_page=100`), deploy.repository),
    ...commitShas(await get(`${base}&until=${slotTime}&per_page=1`), deploy.repository),
  ]);
  const context = scheduleContext(deploy.product, deploy.environment);
  const description = scheduleDescription(deploy.slot);
  for (const sha of heads) {
    const value = await get(`repos/${deploy.repository}/commits/${sha}/status`);
    if (!isJsonRecord(value) || !Array.isArray(value.statuses)) {
      throw new CliError(`GitHub deploy schedule status is invalid: ${deploy.repository}.`, 65);
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

/**
 * The scheduled deploy waits for no one: it dispatches only when the default branch already has a
 * verified successful CI Evidence. A red or pending head is skipped for this run.
 */
export async function mainCiVerdict(
  reader: JsonReader,
  repository: string,
  sha: string,
  controlRepository: string
): Promise<{ passed: boolean; reason: string }> {
  const response = await reader.get(`repos/${repository}/commits/${sha}/status`);
  const state = getJsonString(latestCiStatus(response, "CI Evidence"), "state") || "missing";
  if (state !== "success") {
    return { passed: false, reason: `main CI is ${state}` };
  }
  const verified = await hasVerifiedCiEvidence(reader, response, {
    controlRepository,
    runAttempts: 1,
    retryDelayMs: 0,
  });
  if (!verified) {
    return {
      passed: false,
      reason: "CI Evidence was not produced by a successful Action Worker CI run",
    };
  }
  return { passed: true, reason: "CI Evidence verified" };
}

export function scheduledDeployRequestBody(deploy: ScheduledDeploy, eventType: string): string {
  const identity = createHash("sha256")
    .update(
      `${deploy.repository}\n${deploy.product}\n${deploy.environment}\n${deploy.slot}\n${deploy.head_sha}`
    )
    .digest("hex")
    .slice(0, 32);
  return JSON.stringify({
    event_type: eventType,
    client_payload: {
      schema_version: "1",
      request_id: `deploy-schedule-${identity}`,
      source_repository: deploy.repository,
      source_sha: deploy.head_sha,
      product: deploy.product,
      environment: deploy.environment,
      trigger: "schedule",
    },
  });
}

// The run summary shows the slot in UTC and in Beijing time (UTC+8, without daylight saving).
export function utcText(value: Date): string {
  return `${value.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function beijingText(value: Date): string {
  const shifted = new Date(value.getTime() + 8 * 60 * 60_000);
  return `${shifted.toISOString().slice(0, 16).replace("T", " ")} Beijing time`;
}

async function markDispatched(deploy: ScheduledDeploy, token: string): Promise<void> {
  const payload = JSON.stringify({
    state: "success",
    context: scheduleContext(deploy.product, deploy.environment),
    description: scheduleDescription(deploy.slot),
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
      `repos/${deploy.repository}/statuses/${deploy.head_sha}`,
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

async function dispatchDeploy(
  controlRepository: string,
  token: string,
  body: string
): Promise<void> {
  await runCommand(
    "gh",
    ["api", "--method", "POST", `repos/${controlRepository}/dispatches`, "--input", "-"],
    {
      env: githubEnvironment(token),
      input: body,
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
  const lookbackRaw =
    process.env.DEPLOY_SCHEDULE_LOOKBACK_MINUTES ?? String(defaultLookbackMinutes);
  const lookbackMinutes = Number(lookbackRaw);

  if (!policyRaw || !controlToken || !ingressToken || !repositoryPattern.test(controlRepository)) {
    throw new CliError(
      "AW_REPOSITORY_POLICY, AW_CONTROL_TOKEN, AW_INGRESS_TOKEN, and AW_CONTROL_REPOSITORY are required.",
      64
    );
  }
  if (
    !Number.isInteger(lookbackMinutes) ||
    lookbackMinutes < 1 ||
    lookbackMinutes > maxLookbackMinutes
  ) {
    throw new CliError(
      `DEPLOY_SCHEDULE_LOOKBACK_MINUTES must be between 1 and ${maxLookbackMinutes}.`,
      64
    );
  }

  const now = new Date();
  const reader = new GithubReader(
    process.env.GITHUB_API_URL ?? "https://api.github.com",
    controlToken
  );
  const policy = parseJson(policyRaw, "AW_REPOSITORY_POLICY must be valid JSON.", 65);
  const eventType = deployEventType(
    parseDeployPolicy(await readJson("policies/deploy.json")),
    "source-script"
  );

  const deploys = await resolveScheduledDeploys(
    policy,
    now,
    lookbackMinutes,
    controlRepository,
    reader
  );
  const results: DeployResult[] = [];
  let dispatched = 0;
  for (const deploy of deploys) {
    const label = {
      repository: deploy.repository,
      product: deploy.product || "(root)",
      environment: deploy.environment,
      slot_utc: utcText(deploy.slot_time),
      slot_beijing: beijingText(deploy.slot_time),
      commit: deploy.head_sha,
    };
    if (await wasScheduledDeployDispatched(deploy, (path) => reader.get(path))) {
      results.push({ ...label, result: "skipped (already dispatched)" });
      continue;
    }
    const verdict = await mainCiVerdict(
      reader,
      deploy.repository,
      deploy.head_sha,
      controlRepository
    );
    if (!verdict.passed) {
      results.push({
        ...label,
        result: `skipped (${verdict.reason}; the slot is retried while it is in the lookback)`,
      });
      continue;
    }
    await dispatchDeploy(
      controlRepository,
      ingressToken,
      scheduledDeployRequestBody(deploy, eventType)
    );
    await markDispatched(deploy, controlToken);
    dispatched += 1;
    results.push({ ...label, result: "dispatched" });
  }

  await appendLines(process.env.GITHUB_STEP_SUMMARY, [
    "## Scheduled deploys",
    "",
    `- Now: ${utcText(minuteFloor(now))} / ${beijingText(minuteFloor(now))}`,
    `- Lookback: ${lookbackMinutes} minutes`,
    `- Due: ${deploys.length}; dispatched: ${dispatched}`,
    ...results.map(
      (item) =>
        `- ${item.repository} ${item.product} ${item.environment}: slot ${item.slot_utc} / ${item.slot_beijing} at ${item.commit.slice(0, 12)} — ${item.result}`
    ),
  ]);
  console.log(
    JSON.stringify({
      now: minuteFloor(now).toISOString(),
      lookback_minutes: lookbackMinutes,
      due: deploys.length,
      dispatched,
      results,
    })
  );
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
