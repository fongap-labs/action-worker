import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildTaskCredentialSlotPlan,
  maxTaskCredentialSlots,
} from "../scripts/task-credential-slot-plan.ts";

async function policy(
  config: unknown
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "aw-credential-slots-"));
  const path = join(dir, "policy.json");
  await writeFile(path, JSON.stringify({ schema_version: 1, tasks: config }));
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("credential slots include only the task's declared and authorized names", async () => {
  const item = await policy({
    "fongap-labs/example": {
      project: {
        required: ["REQUIRED_SERVICE_KEY"],
        allowed: ["EXTRA_SERVICE_KEY"],
        aliases: { REQUIRED_SERVICE_KEY: "SERVICE_KEY_PRIMARY" },
      },
    },
  });
  try {
    const actual = await buildTaskCredentialSlotPlan(
      item.path,
      "fongap-labs/example",
      "project",
      ["REQUIRED_SERVICE_KEY"],
      ["EXTRA_SERVICE_KEY"]
    );
    assert.deepEqual(actual, [
      {
        slot: "AW_TASK_SECRET_SLOT_01",
        logical_name: "EXTRA_SERVICE_KEY",
        stored_name: "EXTRA_SERVICE_KEY",
        required: false,
      },
      {
        slot: "AW_TASK_SECRET_SLOT_02",
        logical_name: "REQUIRED_SERVICE_KEY",
        stored_name: "SERVICE_KEY_PRIMARY",
        required: true,
      },
    ]);
    assert.doesNotMatch(JSON.stringify(actual), /secret_value/);
  } finally {
    await item.cleanup();
  }
});

test("unapproved names, overlapping declarations and reserved credentials fail closed", async () => {
  const item = await policy({
    "fongap-labs/example": { project: { required: ["ONE"], allowed: ["TWO"] } },
  });
  try {
    await assert.rejects(
      buildTaskCredentialSlotPlan(item.path, "fongap-labs/example", "project", ["OUTSIDE"], []),
      /ceiling/
    );
    await assert.rejects(
      buildTaskCredentialSlotPlan(item.path, "fongap-labs/example", "project", ["ONE"], ["ONE"]),
      /overlapping/
    );
    await assert.rejects(
      buildTaskCredentialSlotPlan(item.path, "fongap-labs/example", "project", ["AW_ARTIFACT_KEY"], []),
      /invalid/
    );
  } finally {
    await item.cleanup();
  }
});

test("a missing project with any declared credentials fails closed", async () => {
  const item = await policy({});
  try {
    await assert.rejects(
      buildTaskCredentialSlotPlan(item.path, "fongap-labs/new", "project", ["NEW_KEY"], []),
      /no entry/
    );
  } finally {
    await item.cleanup();
  }
});

test("credential plan requires bounded count and unique source secrets", async () => {
  const names = Array.from({ length: maxTaskCredentialSlots + 1 }, (_, index) => `KEY_${index + 1}`);
  const item = await policy({
    "fongap-labs/example": { project: { required: [], allowed: names } },
  });
  try {
    await assert.rejects(
      buildTaskCredentialSlotPlan(item.path, "fongap-labs/example", "project", [], names),
      /limit/
    );
  } finally {
    await item.cleanup();
  }
});

test("R2 S3 Access Key never silently aliases to a Cloudflare API token", async () => {
  const item = await policy({
    "fongap-labs/internal-vault": {
      MarketChina: {
        required: ["CLOUDFLARE_ACCESS_KEY"],
        allowed: [],
        aliases: { CLOUDFLARE_ACCESS_KEY: "CLOUDFLARE_API_TOKEN_PRIMARY" },
      },
    },
  });
  try {
    await assert.rejects(
      buildTaskCredentialSlotPlan(
        item.path,
        "fongap-labs/internal-vault",
        "MarketChina",
        ["CLOUDFLARE_ACCESS_KEY"],
        []
      ),
      /credential-type verification/
    );
  } finally {
    await item.cleanup();
  }
});
