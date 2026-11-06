import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import {
  privateTaskKeyPrefix,
  resolveProjectTransferKeyPlan,
} from "../scripts/private-task-key-plan.ts";

async function policyFixture(projects: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "aw-private-keys-"));
  const file = join(root, "policy.json");
  await writeFile(file, JSON.stringify({ schema_version: 1, projects }));
  return { file, cleanup: async () => rm(root, { recursive: true, force: true }) };
}

const repo = "fongap-labs/source";
const other = "fongap-labs/other";
const project = "demo";
const fingerprintA = "a".repeat(64);
const fingerprintB = "b".repeat(64);

test("private transfer enrollment is exact repository+project and fingerprints are independently pinned", async () => {
  const f = await policyFixture({
    [`${repo}:${project}`]: {
      inbound_fingerprint: fingerprintA,
      outbound_fingerprint: fingerprintB,
    },
  });
  try {
    const plan = await resolveProjectTransferKeyPlan(repo, project, f.file);
    assert.equal(plan.inbound_fingerprint, fingerprintA);
    assert.equal(plan.outbound_fingerprint, fingerprintB);
    assert.equal(
      plan.inbound_public_var,
      `${privateTaskKeyPrefix(repo, project)}_INBOUND_PUBLIC_KEY`
    );
    assert.equal(
      plan.outbound_private_secret,
      `${privateTaskKeyPrefix(repo, project)}_OUTBOUND_PRIVATE_KEY`
    );
    assert.notEqual(privateTaskKeyPrefix(repo, project), privateTaskKeyPrefix(repo, "other"));
    assert.notEqual(privateTaskKeyPrefix(repo, project), privateTaskKeyPrefix(other, project));
    const wrongPairs: Array<[string, string]> = [
      [other, project],
      [repo, "Demo"],
      [repo, "other"],
    ];
    for (const [r, p] of wrongPairs) {
      await assert.rejects(resolveProjectTransferKeyPlan(r, p, f.file), /enrollment/);
    }
  } finally {
    await f.cleanup();
  }
});

test("missing, reused, malformed, or ambiguous key enrollment fails closed", async () => {
  const badEntries: unknown[] = [
    { inbound_fingerprint: fingerprintA, outbound_fingerprint: fingerprintA },
    { inbound_fingerprint: "wrong", outbound_fingerprint: fingerprintB },
    { inbound_fingerprint: fingerprintA, outbound_fingerprint: "wrong" },
    { inbound_fingerprint: fingerprintA },
    { inbound_fingerprint: fingerprintA, outbound_fingerprint: fingerprintB, extra: true },
    [],
    null,
  ];
  for (const entry of badEntries) {
    const fixture = await policyFixture({ [`${repo}:${project}`]: entry });
    try {
      await assert.rejects(resolveProjectTransferKeyPlan(repo, project, fixture.file), /enrollment/);
    } finally {
      await fixture.cleanup();
    }
  }
  assert.throws(() => privateTaskKeyPrefix("fongap-labs/source:demo", project), /enrollment/);
  assert.throws(() => privateTaskKeyPrefix(repo, "../demo"), /enrollment/);
});

test("private Runner jobs bind all four keys to one pinned project and offer strict legacy cutoff", async () => {
  const raw = await readFile(".github/workflows/handle-task-dispatch.yml", "utf8");
  const workflow = parse(raw) as {
    jobs: Record<
      string,
      {
        outputs?: Record<string, string>;
        steps?: Array<{
          name?: string;
          id?: string;
          if?: string;
          run?: string;
          env?: Record<string, string>;
        }>;
      }
    >;
  };
  const validate = workflow.jobs.validate;
  const gate = validate?.steps?.find((step) => step.id === "private_isolation");
  const keyPlan = validate?.steps?.find((step) => step.id === "private_key_plan");
  const legacyCutoff = validate?.steps?.find(
    (step) => step.name === "Refuse legacy private Runner when strict isolation is required"
  );
  assert.ok(gate);
  assert.ok(keyPlan);
  assert.match(keyPlan.if ?? "", /private_isolation\.outputs\.enabled == 'true'/);
  assert.match(keyPlan.run ?? "", /private-task-key-plan\.ts/);
  assert.match(legacyCutoff?.if ?? "", /AW_PRIVATE_LEGACY_EXECUTION_DISABLED/);
  assert.match(legacyCutoff?.run ?? "", /exit 77/);
  for (const field of [
    "private_inbound_public_var",
    "private_inbound_private_secret",
    "private_outbound_public_var",
    "private_outbound_private_secret",
    "private_inbound_fingerprint",
    "private_outbound_fingerprint",
  ]) {
    assert.match(validate?.outputs?.[field] ?? "", /steps\.private_key_plan\.outputs/);
  }
  const prepare = JSON.stringify(workflow.jobs.prepare_private_isolated);
  const task = JSON.stringify(workflow.jobs.run_private_isolated);
  const finalize = JSON.stringify(workflow.jobs.finalize_private_isolated);
  const whole = prepare + task + finalize;
  assert.doesNotMatch(whole, /secrets\.AW_TASK_TRANSFER_(?:INBOUND|OUTBOUND)_PRIVATE_KEY/);
  assert.doesNotMatch(whole, /vars\.AW_TASK_TRANSFER_(?:INBOUND|OUTBOUND)_PUBLIC_KEY/);
  assert.match(prepare, /private_inbound_public_var/);
  assert.match(task, /private_inbound_private_secret/);
  assert.match(task, /private_outbound_public_var/);
  assert.match(finalize, /private_outbound_private_secret/);
  assert.match(whole, /private_inbound_fingerprint/);
  assert.match(whole, /private_outbound_fingerprint/);
  assert.doesNotMatch(task, /AW_ARTIFACT_KEY/);
  assert.doesNotMatch(task, /AW_APP_PRIVATE_KEY/);
});
