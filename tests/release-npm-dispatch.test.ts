import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { validateNpmDispatch } from "../scripts/release-npm-dispatch.ts";

const valid = {
  correlation_id: "12345-1-54321",
  source_repository: "fongap-labs/dsh-plugin",
  target_repository: "fongap-labs/dsh-plugin",
  release_id: "54321",
  release_key: "dsh-delta-code",
  version: "1.2.3",
  tag: "dsh-delta-code-v1.2.3",
  asset_name: "fongap-labs-dsh-delta-code.tgz",
  sha256: "a".repeat(64),
};

test("standalone npm dispatch accepts only a verified stable dsh-plugin request", () => {
  assert.deepEqual(validateNpmDispatch(valid), valid);
  for (const invalid of [
    { version: "1.2.3-beta.1", tag: "dsh-delta-code-v1.2.3-beta.1" },
    { version: "1.2.3-rc.1", tag: "dsh-delta-code-v1.2.3-rc.1" },
    { source_repository: "fongap-labs/ai-gateway" },
    { target_repository: "fongap-labs/external-vault" },
    { asset_name: "unexpected.tgz" },
    { tag: "dsh-delta-code-v1.2.4" },
    { sha256: "bad" },
    { release_id: "0" },
    { correlation_id: "bad" },
  ]) {
    assert.throws(() => validateNpmDispatch({ ...valid, ...invalid }), /Only verified stable/);
  }
});

test("npm workflow has no manual trigger and validates an unpublished draft", async () => {
  const workflow = await readFile(".github/workflows/release-npm-auto.yml", "utf8");
  const implementation = await readFile("scripts/release-npm-dispatch.ts", "utf8");
  assert.doesNotMatch(workflow, /workflow_dispatch:/);
  assert.match(workflow, /types: \[run-npm-release\]/);
  assert.match(workflow, /github\.event\.sender\.login == 'fongap-bot\[bot\]'/);
  assert.match(implementation, /release\.draft !== true/);
  assert.match(implementation, /release\.prerelease !== false/);
  assert.match(implementation, /Downloaded npm package checksum/);
  assert.match(implementation, /jobs\?per_page=100/);
  assert.match(implementation, /getJsonString\(job, "conclusion"\) === "success"/);
});
