import assert from "node:assert/strict";
import { test } from "node:test";
import { wasScheduledDeployDispatched } from "../scripts/dispatch-scheduled-deploys.ts";
import { type ScheduledTask, wasDispatched } from "../scripts/dispatch-scheduled-tasks.ts";
import { scheduledDispatchCandidateShas } from "../scripts/scheduled-dispatch-candidates.ts";
import { attestFixtureStatuses } from "./attested-status-fixtures.ts";

const repository = "fongap-labs/example";
const head = "a".repeat(40);
const recordedSha = "b".repeat(40);
const slot = "2026-10-13T12:00Z";
const hundred = Array.from({ length: 100 }, (_, index) => ({
  sha: index.toString(16).padStart(40, "0"),
}));

test("scheduled task and deploy deduplication check a signed receipt on page two", async () => {
  const requested: string[] = [];
  const get = async (path: string): Promise<unknown> => {
    requested.push(path);
    if (path.includes("&since=")) {
      return path.includes("&page=2") ? [{ sha: recordedSha }] : hundred;
    }
    if (path.includes("&until=")) return [];
    const sha = path.match(/\/commits\/([0-9a-f]{40})\/statuses\?/)?.[1] ?? "";
    const records =
      sha === recordedSha
        ? [
            {
              context: "Task Schedule/MarketBrief",
              state: "success",
              description: `Task dispatched for ${slot}`,
            },
            {
              context: "Deploy Schedule/alpha/nightly",
              state: "success",
              description: `Deploy dispatched for ${slot}`,
            },
          ]
        : [];
    return attestFixtureStatuses(records, repository, sha);
  };
  const task: ScheduledTask = { repository, head_sha: head, project: "MarketBrief", slot };
  const deploy = {
    repository,
    product: "alpha",
    environment: "nightly",
    schedule: ["0 12 * * *"],
    head_sha: head,
    slot,
    slot_time: new Date("2026-10-13T12:00:00Z"),
  };
  assert.equal(await wasDispatched(task, get), true);
  assert.equal(await wasScheduledDeployDispatched(deploy, get), true);
  assert.ok(requested.some((path) => path.includes("&since=") && path.endsWith("&page=2")));
});

test("scheduled dispatch fails closed when its bounded history cannot be exhausted", async () => {
  const requested: string[] = [];
  const get = async (path: string): Promise<unknown> => {
    requested.push(path);
    if (path.includes("&since=")) return hundred;
    throw new Error("No other API calls are allowed after the bounded history exceeds its limit");
  };
  await assert.rejects(
    scheduledDispatchCandidateShas(repository, head, slot, get),
    /history exceeds 1000 commits.*refusing an unsafe replay/
  );
  assert.equal(requested.length, 10);
  assert.ok(requested.at(-1)?.endsWith("&page=10"));
});

test("scheduled dispatch rejects a malformed or oversized commit page", async () => {
  await assert.rejects(
    scheduledDispatchCandidateShas(repository, head, slot, async () => [{ sha: "wrong" }]),
    /commit list is invalid/
  );
  await assert.rejects(
    scheduledDispatchCandidateShas(repository, head, slot, async () => [...hundred, ...hundred]),
    /commit list is invalid/
  );
});
