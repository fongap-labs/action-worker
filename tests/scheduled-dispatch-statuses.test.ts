import assert from "node:assert/strict";
import { test } from "node:test";
import { wasScheduledDeployDispatched } from "../scripts/dispatch-scheduled-deploys.ts";
import { type ScheduledTask, wasDispatched } from "../scripts/dispatch-scheduled-tasks.ts";
import {
  dispatchWithReservation,
  hasScheduledDispatchReceipt,
  scheduledDispatchStatusPayload,
} from "../scripts/scheduled-dispatch-statuses.ts";
import { hasValidStatusAttestation, originalStatusDescription } from "../scripts/status-attestation.ts";
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

function reserved(context: string, slot: string, label: "Task" | "Deploy") {
  return attestFixtureStatuses(
    { context, state: "pending", description: `${label} dispatch reserved for ${slot}` },
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
  const statuses = [signed(context, recentSlot, "Task"), reserved(context, oldSlot, "Task")];
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
  const statuses = [signed(context, recentSlot, "Deploy"), reserved(context, oldSlot, "Deploy")];
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
    [{ state: "success", description: `Task dispatched for ${oldSlot}` }],
    async (path) => {
      requested.push(path);
      return path.endsWith("page=1") ? newerStatuses : [signed(context, oldSlot, "Task")];
    }
  );
  assert.equal(found, true);
  assert.ok(requested[1]?.endsWith("page=2"));
});

test("a dense commit stops safely at the due slot rather than scanning old status history", async () => {
  const context = "Task Schedule/MarketBrief";
  const fresh = Array.from({ length: 100 }, () => ({
    context: "unrelated",
    state: "success",
    created_at: "2026-10-13T18:00:00Z",
  }));
  const historical = Array.from({ length: 100 }, () => ({
    context: "unrelated",
    state: "success",
    created_at: "2026-10-13T11:50:00Z",
  }));
  const requested: string[] = [];
  const result = await hasScheduledDispatchReceipt(
    repository,
    sha,
    context,
    [{ state: "pending", description: `Task dispatch reserved for ${oldSlot}` }],
    async (path) => {
      requested.push(path);
      return path.endsWith("page=11") ? historical : fresh;
    },
    oldSlot
  );
  assert.equal(result, false);
  assert.equal(requested.length, 11);
  assert.ok(requested.at(-1)?.endsWith("page=11"));
});

test("an exact signed receipt wins before checking the older-than-slot boundary", async () => {
  const context = "Task Schedule/MarketBrief";
  const fresh = Array.from({ length: 100 }, () => ({
    context: "unrelated",
    state: "success",
    created_at: "2026-10-13T18:00:00Z",
  }));
  const historical = Array.from({ length: 99 }, () => ({
    context: "unrelated",
    state: "success",
    created_at: "2026-10-13T11:50:00Z",
  }));
  const receipt = {
    ...reserved(context, oldSlot, "Task"),
    created_at: "2026-10-13T12:10:00Z",
  };
  const paths: string[] = [];
  const result = await hasScheduledDispatchReceipt(
    repository,
    sha,
    context,
    [{ state: "pending", description: `Task dispatch reserved for ${oldSlot}` }],
    async (path) => {
      paths.push(path);
      return path.endsWith("page=11") ? [receipt, ...historical] : fresh;
    },
    oldSlot
  );
  assert.equal(result, true);
  assert.equal(paths.length, 11);
});

test("a malformed status order never certifies the slot boundary", async () => {
  const context = "Task Schedule/MarketBrief";
  const unordered = [
    ...Array.from({ length: 99 }, () => ({
      context: "unrelated",
      state: "success",
      created_at: "2026-10-13T11:50:00Z",
    })),
    { context: "unrelated", state: "success", created_at: "2026-10-13T18:00:00Z" },
  ];
  const seen: string[] = [];
  const result = await hasScheduledDispatchReceipt(
    repository,
    sha,
    context,
    [{ state: "success", description: `Task dispatched for ${oldSlot}` }],
    async (path) => {
      seen.push(path);
      return path.endsWith("page=1") ? unordered : [signed(context, oldSlot, "Task")];
    },
    oldSlot
  );
  assert.equal(result, true);
  assert.equal(seen.length, 2);
});

test("a signed pending reservation suppresses a duplicate scheduled dispatch", async () => {
  const context = "Task Schedule/MarketBrief";
  const reservation = attestFixtureStatuses(
    [{ context, state: "pending", description: `Task dispatch reserved for ${oldSlot}` }],
    repository,
    sha
  );
  const found = await hasScheduledDispatchReceipt(
    repository,
    sha,
    context,
    [
      { state: "pending", description: `Task dispatch reserved for ${oldSlot}` },
      { state: "success", description: `Task dispatched for ${oldSlot}` },
    ],
    async () => reservation
  );
  assert.equal(found, true);
});

test("scheduled dispatch reserves before sending and acknowledges only after acceptance", async () => {
  const calls: string[] = [];
  await dispatchWithReservation(
    async () => void calls.push("reserve"),
    async () => void calls.push("dispatch"),
    async () => void calls.push("accepted")
  );
  assert.deepEqual(calls, ["reserve", "dispatch", "accepted"]);

  calls.length = 0;
  await assert.rejects(
    dispatchWithReservation(
      async () => void calls.push("reserve"),
      async () => {
        calls.push("dispatch");
        throw new Error("ambiguous dispatch failure");
      },
      async () => void calls.push("accepted")
    ),
    /ambiguous dispatch failure/
  );
  assert.deepEqual(calls, ["reserve", "dispatch"]);

  calls.length = 0;
  await assert.rejects(
    dispatchWithReservation(
      async () => {
        calls.push("reserve");
        throw new Error("reservation was not persisted");
      },
      async () => void calls.push("dispatch"),
      async () => void calls.push("accepted")
    ),
    /reservation was not persisted/
  );
  assert.deepEqual(calls, ["reserve"]);
});

test("a forged status does not suppress dispatch", async () => {
  const context = "Task Schedule/MarketBrief";
  const result = await hasScheduledDispatchReceipt(
    repository,
    sha,
    context,
    [
      { state: "pending", description: `Task dispatch reserved for ${oldSlot}` },
      { state: "success", description: `Task dispatched for ${oldSlot}` },
    ],
    async () => [
      {
        context,
        state: "pending",
        description: `Task dispatch reserved for ${oldSlot}`,
      },
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
      [{ state: "success", description: `Task dispatched for ${oldSlot}` }],
      async (path) => {
        requested.push(path);
        return newerStatuses;
      }
    ),
    /status history exceeds 5000 records.*refusing an unsafe replay/
  );
  assert.equal(requested.length, 50);
  assert.ok(requested.at(-1)?.endsWith("page=50"));
  for (const invalid of [{ statuses: [] }, [null], Array(101).fill({})]) {
    await assert.rejects(
      hasScheduledDispatchReceipt(
        repository,
        sha,
        context,
        [{ state: "success", description: "unused" }],
        async () => invalid
      ),
      /status history is invalid/
    );
  }
});

test("task and deploy scheduled receipts preserve signed status payloads", () => {
  for (const [context, kind] of [
    ["Task Schedule/MarketBrief", "Task"],
    ["Deploy Schedule/alpha/nightly", "Deploy"],
  ] as const) {
    for (const [state, description] of [
      ["pending", `${kind} dispatch reserved for ${oldSlot}`],
      ["success", `${kind} dispatched for ${oldSlot}`],
    ] as const) {
      const payload = JSON.parse(
        scheduledDispatchStatusPayload({ repository, head_sha: sha, context }, state, description)
      ) as Record<string, unknown>;
      assert.equal(payload.state, state);
      assert.equal(payload.context, context);
      assert.equal(originalStatusDescription(payload), description);
      assert.equal(hasValidStatusAttestation(payload, { repository, sha, context }), true);
    }
  }
});
