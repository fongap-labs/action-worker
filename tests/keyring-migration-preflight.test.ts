import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
import { keyringsMatch } from "../scripts/verify-keyring-migration.ts";

const key = Buffer.alloc(32, 7).toString("base64url");
const older = JSON.stringify({
  schema_version: 1,
  active: "k1",
  keys: { k1: key },
  legacy_tokens: ["old-verifier"],
});

test("migration compares current and historical signing material without changing it", () => {
  assert.equal(keyringsMatch(older, older), true);
  assert.equal(keyringsMatch(older, ""), false);
  const changedKey = JSON.stringify({
    schema_version: 1,
    active: "k1",
    keys: { k1: Buffer.alloc(32, 8).toString("base64url") },
    legacy_tokens: ["old-verifier"],
  });
  assert.equal(keyringsMatch(older, changedKey), false);
  const lostHistory = JSON.stringify({
    schema_version: 1,
    active: "k1",
    keys: { k1: key },
    legacy_tokens: [],
  });
  assert.equal(keyringsMatch(older, lostHistory), false);
});

test("migration preflight runs independently in a protected job", async () => {
  const source = await readFile(".github/workflows/apply-repository-settings.yml", "utf8");
  const workflow = parse(source) as {
    jobs: Record<
      string,
      {
        needs?: unknown;
        environment?: string;
        steps?: Array<{ name?: string; env?: Record<string, string> }>;
      }
    >;
  };
  const verify = workflow.jobs["verify-status-keyring-migration"];
  assert.ok(verify);
  assert.equal(verify.environment, "admin-ops");
  assert.equal(verify.needs, undefined);
  const step = verify.steps?.find((entry) => entry.name === "Verify signing keyring migration");
  assert.ok(step);
  assert.equal(step.env?.AW_STATUS_SIGNING_KEYS, "${{ secrets.AW_STATUS_SIGNING_KEYS }}");
  assert.equal(step.env?.AW_STATUS_KEYRING, "${{ secrets.AW_STATUS_KEYRING }}");
  assert.ok(workflow.jobs["bootstrap-signing"]);
});
