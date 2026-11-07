import assert from "node:assert/strict";
import { test } from "node:test";
import { wasScheduledDeployDispatched } from "../scripts/dispatch-scheduled-deploys.ts";
import { type ScheduledTask, wasDispatched } from "../scripts/dispatch-scheduled-tasks.ts";
import { hasScheduledDispatchReceipt } from "../scripts/scheduled-dispatch-statuses.ts";
import { attestFixtureStatuses } from "./attested-status-fixtures.ts";

const repository = "fongap-labs/example";
const sha = "a".repeat(40);
const oldSlot = "2026-10-13T12:00Z";
const recentSlot = "2026-10-13T18:00Z";

function signed(context: string, slot: string, label: "Task" | "Deploy") {
  return attestFixtureStatuses(
    { context, state: "success", description: `${label} dispatched for ${slot}` },
    repository,
    sha
  );
}

test("task dedupe finds a past signed slot under the same commit and context", async () => {
  const task: ScheduledTask = {
    repository,
    head_sha: sha,
    project: "MarketBrief",
    slot: oldSlot,
  };
  const context = "Task Schedule/MarketBrief";
  const statuses = [
    signed(context, recentSlot, "Task"),
    signed(context, oldSlot, "Task"),
  ];
  const requested: string[] = [];
  const get = async (path: string): Promise<unknown> => {
    requested.push(path);
    if (path.includes("&since=") || path.includes("&until=")) return [];
    if (path.includes("/statuses?per_page=100&page=1")) return statuses;
    throw new Error(`Unexpected GitHub path: ${path}`);
  };
  assert.equal(await wasDispatched(task, get), true);
  assert.ok(requested.some((path) => path.includes("/statuses?per_page=100&page=1")));
  assert.ok(!requested.some((path) => path.endsWith("/status")));
});

test("deploy dedupe finds a historical signed slot on the same head", async () => {
  const context = "Deploy Schedule/alpha/nightly";
  const deploy = {
    repository,
    product: "alpha",
    environment: "nightly",
    head_sha: sha,
    slot: oldSlot,
    slot_time: new Date("2026-10-13T12:00:00Z"),
    schedule: ["0 12 * * *"],
  };
  const statuses = [
    signed(context, recentSlot, "Deploy"),
    signed(context, oldSlot, "Deploy"),
  ];
  const get = async (path: string): Promise<unknown> => {
    if (path.includes("&since=") || path.includes("&until=")) return [];
    if (path.includes("/statuses?per_page=100&page=1")) return statuses;
    throw new Error(`Unexpected GitHub path: ${path}`);
  };
  assert.equal(await wasScheduledDeployDispatched(deploy, get), true);
});

test("signed schedule receipts on a second status-history page are found", async () => {
  const context = "Task Schedule/MarketBrief";
  const newerStatuses = Array.from({ length: 100 }, (_, index) =>
    signed(context, `2026-10-14T${String(index % 24).padStart(2, "0")}:00Z`, "Task")
  );
  const requested: string[] = [];
  const found = await hasScheduledDispatchReceipt(
    repository,
    sha,
    context,
    `Task dispatched for ${oldSlot}`,
    async (path) => {
      requested.push(path);
      return path.endsWith("page=1")
        ? newerStatuses
        : [signed(context, oldSlot, "Task")];
    }
  );
  assert.equal(found, true);
  assert.ok(requested[1]?.endsWith("page=2"));
});

test("a forged status does not suppress dispatch", async () => {
  const context = "Task Schedule/MarketBrief";
  const result = await hasScheduledDispatchReceipt(
    repository,
    sha,
    context,
    `Task dispatched for ${oldSlot}`,
    async () => [
      {
        context,
        state: "success",
        description: `Task dispatched for ${oldSlot}`,
      },
    ]
  );
  assert.equal(result, false);
});

test("unbounded or malformed status history fails closed", async () => {
  const context = "Task Schedule/MarketBrief";
  const newerStatuses = Array.from({ length: 100 }, (_, index) =>
    signed(context, `2026-10-14T${String(index % 24).padStart(2, "0")}:00Z`, "Task")
  );
  const requested: string[] = [];
  await assert.rejects(
    hasScheduledDispatchReceipt(
      repository,
      sha,
      context,
      `Task dispatched for ${oldSlot}`,
      async (path) => {
        requested.push(path);
        return newerStatuses;
      }
    ),
    /status history exceeds 1000 records.*refusing an unsafe replay/
  );
  assert.equal(requested.length, 10);
  assert.ok(requested.at(-1)?.endsWith("page=10"));
  for (const invalid of [{ statuses: [] }, [{ context }], Array(101).fill({})]) {
    await assert.rejects(
      hasScheduledDispatchReceipt(repository, sha, context, "unused", async () => invalid),
      /status history is invalid/
    );
  }
});
