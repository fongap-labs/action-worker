import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseTaskSourceManifest,
  projectsForSchedule,
} from "../scripts/dispatch-scheduled-tasks.ts";

const manifest = {
  schema_version: "1",
  schedules: [
    { cron: "30 0 * * *", projects: ["MarketBrief"] },
    { cron: "30 12 * * *", projects: ["MarketBrief"] },
    { cron: "30 12 * * 0", projects: ["PharmaBrief"] },
  ],
};

test("task source manifest selects projects by schedule without duplicates", () => {
  const parsed = parseTaskSourceManifest(manifest);
  assert.deepEqual(projectsForSchedule(parsed, "30 12 * * *"), ["MarketBrief"]);
  assert.deepEqual(projectsForSchedule(parsed, "30 12 * * 0"), ["PharmaBrief"]);
  assert.deepEqual(projectsForSchedule(parsed, "0 6 * * *"), []);
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
    extra: true,
  }));
});
