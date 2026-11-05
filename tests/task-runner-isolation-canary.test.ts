import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  finalizeCanary,
  parsePreparation,
  prepareCanary,
  runUntrustedCanary,
  validateResult,
} from "../scripts/task-runner-isolation-canary.ts";

const runId = "420000001";
const attempt = "1";

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "aw-runner-canary-"));
  await mkdir(join(root, "scripts"));
  await writeFile(join(root, "scripts/task-transfer-envelope.ts"), "export const trusted = true;\n");
  return root;
}

test("synthetic execution changes only its workspace and a clean checkout validates", async () => {
  const trusted = await workspace();
  const untrusted = await workspace();
  const clean = await workspace();
  try {
    const preparation = await prepareCanary(trusted, runId, attempt);
    const result = await runUntrustedCanary(untrusted, preparation, runId, attempt);
    assert.match(
      await readFile(join(untrusted, "scripts/task-transfer-envelope.ts"), "utf8"),
      /CANARY_UNTRUSTED_WORKSPACE_MUTATION/
    );
    await finalizeCanary(clean, preparation, result, runId, attempt);
    await assert.rejects(finalizeCanary(untrusted, preparation, result, runId, attempt), /poisoned/);
  } finally {
    await Promise.all([trusted, untrusted, clean].map((root) => rm(root, { recursive: true, force: true })));
  }
});

test("forged job output, changed identity and extra fields are rejected", async () => {
  const root = await workspace();
  try {
    const prep = await prepareCanary(root, runId, attempt);
    const result = {
      schema: "1",
      run_id: runId,
      attempt,
      fixture_sha256: prep.fixture_sha256,
      workspace_modified: true,
      background_attempted: true,
      result: "synthetic-task-result",
    };
    assert.deepEqual(validateResult(result, prep), result);
    assert.throws(() => validateResult({ ...result, command: "rm -rf /" }, prep), /unknown/);
    assert.throws(() => validateResult({ ...result, result: "forged" }, prep), /validation/);
    assert.throws(() => validateResult({ ...result, run_id: "123" }, prep), /validation/);
    assert.throws(() => parsePreparation(prep, runId, "2"), /identity/);
    assert.throws(() => parsePreparation({ ...prep, secret: "extra" }, runId, attempt), /unknown/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canary refuses altered trusted SHA and invalid run identity", async () => {
  const root = await workspace();
  try {
    const prep = await prepareCanary(root, runId, attempt);
    await writeFile(join(root, "scripts/task-transfer-envelope.ts"), "modified by attacker");
    await assert.rejects(runUntrustedCanary(root, prep, runId, attempt), /mismatched/);
    await assert.rejects(prepareCanary(root, "0", attempt), /identity/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
