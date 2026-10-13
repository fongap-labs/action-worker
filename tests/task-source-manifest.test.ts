import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cronMatches,
  defaultLookbackMinutes,
  maxLookbackMinutes,
  parseTaskSourceManifest,
  projectsDueAt,
  projectsForSchedule,
  type ScheduledTask,
  wasDispatched,
} from "../scripts/dispatch-scheduled-tasks.ts";

const manifest = {
  schema_version: "1",
  push: true,
  schedules: [
    { cron: "30 0 * * *", projects: ["MarketBrief"] },
    { cron: "30 12 * * *", projects: ["MarketBrief"] },
    { cron: "30 12 * * 0", projects: ["PharmaBrief"] },
  ],
};

test("task source manifest selects projects by schedule without duplicates", () => {
  const parsed = parseTaskSourceManifest(manifest);
  assert.equal(parsed.push, true);
  assert.deepEqual(projectsForSchedule(parsed, "30 12 * * *"), ["MarketBrief"]);
  assert.deepEqual(projectsForSchedule(parsed, "30 12 * * 0"), ["PharmaBrief"]);
  assert.deepEqual(projectsForSchedule(parsed, "0 6 * * *"), []);
});

test("source-owned cron is evaluated by the generic scheduler", () => {
  const parsed = parseTaskSourceManifest(manifest);
  assert.equal(cronMatches(new Date("2026-09-28T00:30:00Z"), "30 0 * * *"), true);
  assert.equal(cronMatches(new Date("2026-09-28T00:31:00Z"), "30 0 * * *"), false);
  assert.equal(cronMatches(new Date("2026-09-27T12:30:00Z"), "30 12 * * 0"), true);
  assert.equal(cronMatches(new Date("2026-09-28T12:30:00Z"), "30 12 * * 0"), false);

  assert.deepEqual(projectsDueAt(parsed, new Date("2026-09-28T12:37:00Z"), 20), [
    { project: "MarketBrief", slot: "2026-09-28T12:30Z" },
  ]);
  assert.deepEqual(projectsDueAt(parsed, new Date("2026-09-27T12:37:00Z"), 20), [
    { project: "MarketBrief", slot: "2026-09-27T12:30Z" },
    { project: "PharmaBrief", slot: "2026-09-27T12:30Z" },
  ]);
});

test("the scheduler catches up the latest missed slot when GitHub starts it hours late", () => {
  const parsed = parseTaskSourceManifest(manifest);
  // A real scheduled run started at 07:53 UTC; with a 20-minute look-back it found nothing due.
  const lateRun = new Date("2026-10-13T07:53:00Z");
  assert.deepEqual(projectsDueAt(parsed, lateRun, 20), []);
  assert.deepEqual(projectsDueAt(parsed, lateRun), [
    { project: "MarketBrief", slot: "2026-10-13T00:30Z" },
  ]);
  // Only the latest slot of a project is due, never an older one it supersedes.
  assert.deepEqual(projectsDueAt(parsed, new Date("2026-10-13T13:00:00Z"), maxLookbackMinutes), [
    { project: "MarketBrief", slot: "2026-10-13T12:30Z" },
  ]);
  assert.equal(defaultLookbackMinutes, 720);
  assert.throws(() => projectsDueAt(parsed, lateRun, maxLookbackMinutes + 1), /lookback/);
  assert.throws(() => projectsDueAt(parsed, lateRun, 0), /lookback/);
});

test("a slot dispatched on an earlier default-branch head is not dispatched again", async () => {
  const task: ScheduledTask = {
    repository: "example/tasks",
    head_sha: "b".repeat(40),
    project: "MarketBrief",
    slot: "2026-10-13T00:30Z",
  };
  const earlierHead = "a".repeat(40);
  const recorded = {
    statuses: [
      {
        context: "Task Schedule/MarketBrief",
        state: "success",
        description: "Task dispatched for 2026-10-13T00:30Z",
      },
    ],
  };
  const requests: string[] = [];
  const world = (statusOn: string) => async (path: string) => {
    requests.push(path);
    if (path.includes("&since=")) return [{ sha: task.head_sha }];
    if (path.includes("&until=")) return [{ sha: earlierHead }];
    return path.includes(`/commits/${statusOn}/status`) ? recorded : { statuses: [] };
  };

  assert.equal(await wasDispatched(task, world(earlierHead)), true);
  assert.ok(
    requests.includes(
      `repos/example/tasks/commits?sha=${task.head_sha}&since=2026-10-13T00:30:00Z&per_page=100`
    )
  );
  assert.ok(
    requests.includes(
      `repos/example/tasks/commits?sha=${task.head_sha}&until=2026-10-13T00:30:00Z&per_page=1`
    )
  );
  assert.equal(await wasDispatched(task, world("c".repeat(40))), false);
  await assert.rejects(
    wasDispatched(task, async () => [{ sha: "not-a-sha" }]),
    /commit list is invalid/
  );
});

test("task source manifest rejects unsafe project and schedule data", () => {
  assert.throws(() =>
    parseTaskSourceManifest({
      ...manifest,
      schedules: [{ cron: "30 0 * * *", projects: ["../escape"] }],
    })
  );
  assert.throws(() =>
    parseTaskSourceManifest({
      ...manifest,
      schedules: [{ cron: "30 0 * * *\nrun: bad", projects: ["Example"] }],
    })
  );
  assert.throws(() =>
    parseTaskSourceManifest({
      ...manifest,
      schedules: [{ cron: "60 0 * * *", projects: ["Example"] }],
    })
  );
  assert.throws(() =>
    parseTaskSourceManifest({
      ...manifest,
      extra: true,
    })
  );
});

test("task source manifest defaults push intake to disabled", () => {
  const { push: _push, ...withoutPush } = manifest;
  const parsed = parseTaskSourceManifest(withoutPush);
  assert.equal(parsed.push, false);
});
