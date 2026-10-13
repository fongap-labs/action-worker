import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
import { latestCronSlot, parseCronSchedule, slotKey } from "../scripts/cron-schedule.ts";
import { parseDeployManifest } from "../scripts/deploy-manifest.ts";
import {
  beijingText,
  latestScheduledSlot,
  mainCiVerdict,
  resolveScheduledDeploys,
  scheduleContext,
  scheduledDeployRequestBody,
  scheduledDeployTargets,
  utcText,
  wasScheduledDeployDispatched,
} from "../scripts/dispatch-scheduled-deploys.ts";
import { GithubHttpError } from "../scripts/github-api.ts";
import { assertDeployTrigger } from "../scripts/validate-deploy-source.ts";

const head = "0123456789abcdef0123456789abcdef01234567";
const newerHead = "abcdef0123456789abcdef0123456789abcdef01";
const controlRepository = "fongap-labs/action-worker";
const repository = "fongap-labs/example";

function at(value: string): Date {
  return new Date(value);
}

// --- cron and the latest slot --------------------------------------------------------------------

test("a schedule is due when it fired within the lookback, and not due when it did not", () => {
  const daily = parseCronSchedule("0 12 * * *", "Deploy schedule");
  // Fired at 12:00 and the run is at 12:05: due.
  const fired = latestCronSlot(daily, at("2026-10-13T12:05:00Z"), 720);
  assert.ok(fired);
  assert.equal(slotKey(fired), "2026-10-13T12:00Z");
  // Last fired 23 hours earlier, outside a 12 hour lookback: not due.
  assert.equal(latestCronSlot(daily, at("2026-10-13T11:00:00Z"), 720), null);
});

test("a late run dispatches only the latest firing, never every missed one", () => {
  const sixHourly = parseCronSchedule("0 */6 * * *", "Deploy schedule");
  // At 13:00 the firings at 06:00 and 12:00 both fall in the lookback; only 12:00 counts.
  const latest = latestCronSlot(sixHourly, at("2026-10-13T13:00:00Z"), 720);
  assert.ok(latest);
  assert.equal(slotKey(latest), "2026-10-13T12:00Z");
});

test("the latest slot across several schedules of one environment is the most recent firing", () => {
  const now = at("2026-10-13T12:40:00Z");
  const latest = latestScheduledSlot(["0 6 * * *", "30 12 * * *", "0 0 * * 1"], now, 720);
  assert.ok(latest);
  assert.equal(slotKey(latest), "2026-10-13T12:30Z");
  assert.equal(latestScheduledSlot(["0 3 * * *"], at("2026-10-13T12:40:00Z"), 60), null);
});

test("a schedule error names the owner that declared it", () => {
  assert.throws(
    () => parseCronSchedule("61 * * * *", "Deploy schedule"),
    /Deploy schedule cron minute is out of range/
  );
  assert.throws(
    () => parseCronSchedule("0 * * *", "Task source"),
    /Task source cron must contain five fields/
  );
});

// --- targets and due deploys ---------------------------------------------------------------------

// A reader for the contents, commits, statuses and environment endpoints. Anything it does not
// serve answers 404, as the GitHub API does.
function repositoryReader(routes: Record<string, unknown>) {
  return {
    async get(path: string): Promise<unknown> {
      const [file = ""] = path.split("?");
      if (Object.hasOwn(routes, path)) return routes[path];
      if (Object.hasOwn(routes, file)) return routes[file];
      throw new GithubHttpError(404);
    },
  };
}

function encoded(value: unknown) {
  return {
    encoding: "base64",
    content: Buffer.from(JSON.stringify(value), "utf8").toString("base64"),
  };
}

const alphaManifest = {
  schema_version: "2",
  adapter: "source-script",
  root: "projects/alpha",
  entrypoint: "projects/alpha/deploy.sh",
  runner_profile: "production-deploy",
  ignore_docs_only: true,
  environments: {
    production: { triggers: { push: true } },
    nightly: { triggers: { schedule: ["0 12 * * *"] } },
    manual: {},
  },
};

function productRoutes(manifest: unknown, environments: Record<string, unknown>) {
  return {
    [`repos/${repository}`]: { default_branch: "main" },
    [`repos/${repository}/commits/main`]: { sha: head },
    [`repos/${repository}/contents/projects`]: [{ name: "alpha", type: "dir", size: 0 }],
    [`repos/${repository}/contents/projects/alpha`]: [
      { name: "deploy.json", type: "file", size: 400 },
    ],
    [`repos/${repository}/contents/projects/alpha/deploy.json`]: encoded(manifest),
    ...Object.fromEntries(
      Object.entries(environments).map(([name, value]) => [
        `repos/${controlRepository}/environments/${name}`,
        value,
      ])
    ),
  };
}

const policy = { [repository]: ["deploy", "pr"] };
const open = { protection_rules: [] };

test("scheduled targets are the product environments with a schedule, and a reviewer-gated one is refused", async () => {
  const reader = repositoryReader(
    productRoutes(alphaManifest, { production: open, nightly: open, manual: open })
  );
  assert.deepEqual(await scheduledDeployTargets(reader, repository, head, controlRepository), [
    { repository, product: "alpha", environment: "nightly", schedule: ["0 12 * * *"] },
  ]);

  const gated = repositoryReader(
    productRoutes(alphaManifest, {
      production: open,
      nightly: { protection_rules: [{ type: "required_reviewers", reviewers: [] }] },
      manual: open,
    })
  );
  await assert.rejects(
    scheduledDeployTargets(gated, repository, head, controlRepository),
    /Environment nightly requires reviewers/
  );
});

test("a due product environment is dispatched once for its latest slot, and an undue one is not", async () => {
  const reader = repositoryReader(
    productRoutes(alphaManifest, { production: open, nightly: open, manual: open })
  );
  const due = await resolveScheduledDeploys(
    policy,
    at("2026-10-13T12:05:00Z"),
    720,
    controlRepository,
    reader
  );
  assert.equal(due.length, 1);
  assert.equal(due[0]?.product, "alpha");
  assert.equal(due[0]?.environment, "nightly");
  assert.equal(due[0]?.head_sha, head);
  assert.equal(due[0]?.slot, "2026-10-13T12:00Z");

  const notDue = await resolveScheduledDeploys(
    policy,
    at("2026-10-13T11:00:00Z"),
    720,
    controlRepository,
    reader
  );
  assert.deepEqual(notDue, []);
});

// --- dedupe --------------------------------------------------------------------------------------

function deployFor(product: string, environment: string) {
  return {
    repository,
    product,
    environment,
    schedule: ["0 12 * * *"],
    head_sha: head,
    slot: "2026-10-13T12:00Z",
    slot_time: at("2026-10-13T12:00:00Z"),
  };
}

// Commits: the head of the slot time is `head`, and `newerHead` landed after the slot.
function dedupeGet(statuses: Record<string, unknown[]>) {
  return async (path: string): Promise<unknown> => {
    if (path.includes("until=")) return [{ sha: head }];
    if (path.includes("since=")) return [{ sha: newerHead }, { sha: head }];
    const sha = path.match(/commits\/([0-9a-f]{40})\/status$/)?.[1] ?? "";
    return { statuses: statuses[sha] ?? [] };
  };
}

test("a recorded slot is not dispatched again, even when a newer commit is the head", async () => {
  const record = {
    context: "Deploy Schedule/alpha/nightly",
    state: "success",
    description: "Deploy dispatched for 2026-10-13T12:00Z",
  };
  // The status is on the head of the slot time, not on the newer head.
  const get = dedupeGet({ [head]: [record] });
  assert.equal(await wasScheduledDeployDispatched(deployFor("alpha", "nightly"), get), true);
  assert.equal(await wasScheduledDeployDispatched(deployFor("alpha", "production"), get), false);
  assert.equal(
    await wasScheduledDeployDispatched(
      { ...deployFor("alpha", "nightly"), slot: "2026-10-12T12:00Z" },
      get
    ),
    false
  );
});

test("a product and the root layout write different dedupe statuses", async () => {
  assert.equal(scheduleContext("alpha", "nightly"), "Deploy Schedule/alpha/nightly");
  assert.equal(scheduleContext("", "production"), "Deploy Schedule/production");

  const rootRecord = {
    context: "Deploy Schedule/production",
    state: "success",
    description: "Deploy dispatched for 2026-10-13T12:00Z",
  };
  const get = dedupeGet({ [head]: [rootRecord] });
  assert.equal(await wasScheduledDeployDispatched(deployFor("", "production"), get), true);
  assert.equal(await wasScheduledDeployDispatched(deployFor("alpha", "production"), get), false);
});

// --- CI verdict ----------------------------------------------------------------------------------

const ciSuccess = {
  context: "CI Evidence",
  state: "success",
  target_url: `https://github.com/${controlRepository}/actions/runs/123`,
  created_at: "2026-10-02T13:11:43Z",
};

const run = {
  repository: { full_name: controlRepository },
  path: ".github/workflows/central-ci-dispatch.yml",
  head_branch: "main",
  status: "completed",
  conclusion: "success",
  run_started_at: "2026-10-02T13:10:15Z",
  updated_at: "2026-10-02T13:11:57Z",
};

function ciReader(statuses: unknown[], runValue: unknown = run) {
  return {
    async get(path: string): Promise<unknown> {
      if (path === `repos/${repository}/commits/${head}/status`) return { statuses };
      if (path === `repos/${controlRepository}/actions/runs/123`) return runValue;
      throw new GithubHttpError(404);
    },
  };
}

test("a red or unverified main is skipped, and a verified successful main passes", async () => {
  const red = await mainCiVerdict(
    ciReader([{ ...ciSuccess, state: "failure" }]),
    repository,
    head,
    controlRepository
  );
  assert.deepEqual(red, { passed: false, reason: "main CI is failure" });

  const missing = await mainCiVerdict(ciReader([]), repository, head, controlRepository);
  assert.equal(missing.passed, false);
  assert.equal(missing.reason, "main CI is missing");

  const unverified = await mainCiVerdict(
    ciReader([ciSuccess], { ...run, conclusion: "failure" }),
    repository,
    head,
    controlRepository
  );
  assert.equal(unverified.passed, false);

  const verified = await mainCiVerdict(ciReader([ciSuccess]), repository, head, controlRepository);
  assert.deepEqual(verified, { passed: true, reason: "CI Evidence verified" });
});

// --- request, time text and trigger --------------------------------------------------------------

test("a scheduled deploy request names the head, the product and the environment with trigger schedule", () => {
  const body = JSON.parse(
    scheduledDeployRequestBody(deployFor("alpha", "nightly"), "run-source-script-deploy")
  );
  assert.equal(body.event_type, "run-source-script-deploy");
  assert.equal(body.client_payload.trigger, "schedule");
  assert.equal(body.client_payload.source_sha, head);
  assert.equal(body.client_payload.product, "alpha");
  assert.equal(body.client_payload.environment, "nightly");
  assert.match(body.client_payload.request_id, /^[A-Za-z0-9._:-]{1,128}$/);

  // The same slot always names the same request, so a retry does not look like a new deploy.
  assert.equal(
    scheduledDeployRequestBody(deployFor("alpha", "nightly"), "run-source-script-deploy"),
    scheduledDeployRequestBody(deployFor("alpha", "nightly"), "run-source-script-deploy")
  );
});

test("the run summary shows the slot in UTC and in Beijing time", () => {
  const slot = at("2026-10-13T12:00:00Z");
  assert.equal(utcText(slot), "2026-10-13 12:00 UTC");
  assert.equal(beijingText(slot), "2026-10-13 20:00 Beijing time");
  assert.equal(beijingText(at("2026-10-13T20:30:00Z")), "2026-10-14 04:30 Beijing time");
});

test("a schedule trigger needs a schedule, a push trigger needs an automatic environment, and manual needs nothing", () => {
  const scheduled = { automatic: false, schedule: ["0 12 * * *"], environment: "nightly" };
  const pushed = { automatic: true, schedule: [], environment: "production" };
  const manual = { automatic: false, schedule: [], environment: "manual" };

  assert.doesNotThrow(() => assertDeployTrigger("schedule", scheduled));
  assert.throws(
    () => assertDeployTrigger("schedule", pushed),
    /Scheduled deploy requires a schedule/
  );
  assert.doesNotThrow(() => assertDeployTrigger("push", pushed));
  assert.throws(() => assertDeployTrigger("push", manual), /Push deploy requires a push trigger/);
  assert.doesNotThrow(() => assertDeployTrigger("manual", manual));
});

test("the source manifest refuses a schedule that cannot run", () => {
  const withSchedule = (schedule: string[]) => ({
    ...alphaManifest,
    environments: { nightly: { triggers: { schedule } } },
  });
  assert.doesNotThrow(() => parseDeployManifest(withSchedule(["0 12 * * *"])));
  for (const schedule of [["61 * * * *"], ["0 12 * *"], ["0 12 * * 9"], ["@daily"]]) {
    assert.throws(
      () => parseDeployManifest(withSchedule(schedule)),
      Error,
      JSON.stringify(schedule)
    );
  }
});

// --- workflow ------------------------------------------------------------------------------------

test("the Intake deploy-schedules job matches the task-schedules job", async () => {
  const intake = parse(await readFile(".github/workflows/intake.yml", "utf8")) as {
    jobs: Record<
      string,
      {
        name?: string;
        "timeout-minutes"?: number;
        permissions?: unknown;
        steps?: Array<{ uses?: string; env?: unknown; run?: string }>;
      }
    >;
  };
  const deploy = intake.jobs["deploy-schedules"];
  const tasks = intake.jobs["task-schedules"];
  assert.ok(deploy, "deploy-schedules job exists");
  assert.equal(deploy.name, "Scheduled deploys");
  assert.equal(deploy["timeout-minutes"], 10);
  assert.deepEqual(deploy.permissions, { contents: "write" });
  assert.deepEqual(
    deploy.steps?.map((step) => step.uses),
    tasks?.steps?.map((step) => step.uses)
  );
  const run = deploy.steps?.at(-1);
  assert.equal(run?.run, "node scripts/dispatch-scheduled-deploys.ts");
  assert.deepEqual(run?.env, {
    AW_REPOSITORY_POLICY: "${{ vars.AW_REPOSITORY_POLICY }}",
    AW_CONTROL_TOKEN: "${{ secrets.AW_CONTROL_TOKEN }}",
    AW_INGRESS_TOKEN: "${{ github.token }}",
    AW_CONTROL_REPOSITORY: "${{ github.repository }}",
    DEPLOY_SCHEDULE_LOOKBACK_MINUTES: "720",
  });
  const text = await readFile(".github/workflows/intake.yml", "utf8");
  assert.match(
    text,
    /# A slot up to 12 hours late runs once: only the latest due slot of each product environment is dispatched\./
  );
});
