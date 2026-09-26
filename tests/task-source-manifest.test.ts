import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cronMatches,
  parseTaskSourceManifest,
  projectsDueAt,
  projectsForSchedule,
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

  assert.deepEqual(
    projectsDueAt(parsed, new Date("2026-09-28T12:37:00Z"), 20),
    [{ project: "MarketBrief", slot: "2026-09-28T12:30Z" }],
  );
  assert.deepEqual(
    projectsDueAt(parsed, new Date("2026-09-27T12:37:00Z"), 20),
    [
      { project: "MarketBrief", slot: "2026-09-27T12:30Z" },
      { project: "PharmaBrief", slot: "2026-09-27T12:30Z" },
    ],
  );
});

test("task source manifest rejects unsafe project and schedule data", () => {
  assert.throws(() => parseTaskSourceManifest({
    ...manifest,
    schedules: [{ cron: "30 0 * * *", projects: ["../escape"] }],
  }));
  assert.throws(() => parseTaskSourceManifest({
    ...manifest,
    schedules: [{ cron: "30 0 * * *\nrun: bad", projects: ["Example"] }],
  }));
  assert.throws(() => parseTaskSourceManifest({
    ...manifest,
    schedules: [{ cron: "60 0 * * *", projects: ["Example"] }],
  }));
  assert.throws(() => parseTaskSourceManifest({
    ...manifest,
    extra: true,
  }));
});

test("task source manifest defaults push intake to disabled", () => {
  const { push: _push, ...withoutPush } = manifest;
  const parsed = parseTaskSourceManifest(withoutPush);
  assert.equal(parsed.push, false);
});
