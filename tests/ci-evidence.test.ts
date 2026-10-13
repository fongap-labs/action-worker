import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  centralCiWait,
  hasTrustedSuccessfulCiEvidence,
  hasVerifiedCiEvidence,
  latestCiStatus,
  requireVerifiedCiEvidence,
  trustedCiStatus,
  trustedControlRunId,
} from "../scripts/ci-evidence.ts";
import { waitForCentralStatus } from "../scripts/wait-ci-evidence.ts";

const controlRepository = "fongap-labs/action-worker";

test("trusted control run URLs are exact and repository-scoped", () => {
  assert.equal(
    trustedControlRunId(
      "https://github.com/fongap-labs/action-worker/actions/runs/123",
      controlRepository
    ),
    123
  );
  assert.equal(
    trustedControlRunId("https://github.com/fongap-labs/other/actions/runs/123", controlRepository),
    null
  );
  assert.equal(
    trustedControlRunId(
      "https://example.com/fongap-labs/action-worker/actions/runs/123",
      controlRepository
    ),
    null
  );
});

test("only the latest matching trusted CI status can satisfy the gate", () => {
  const response = {
    statuses: [
      {
        context: "CI Evidence",
        state: "success",
        target_url: "https://github.com/attacker/repo/actions/runs/9",
      },
      {
        context: "CI Evidence",
        state: "success",
        target_url: "https://github.com/fongap-labs/action-worker/actions/runs/8",
      },
    ],
  };
  assert.equal(latestCiStatus(response, "CI Evidence")?.state, "success");
  assert.equal(trustedCiStatus(response, "CI Evidence", controlRepository), undefined);
  assert.equal(hasTrustedSuccessfulCiEvidence(response, "CI Evidence", controlRepository), false);
});

test("trusted successful CI evidence is idempotent", () => {
  const response = {
    statuses: [
      {
        context: "CI Evidence",
        state: "success",
        target_url: "https://github.com/fongap-labs/action-worker/actions/runs/42",
      },
    ],
  };
  assert.equal(hasTrustedSuccessfulCiEvidence(response, "CI Evidence", controlRepository), true);
});

const centralRunPath = ".github/workflows/central-ci-dispatch.yml";
const evidenceRunUrl = "https://github.com/fongap-labs/action-worker/actions/runs/42";
const noDelay = { retryDelayMs: 0 };

function evidenceStatus(overrides: Record<string, unknown> = {}) {
  return {
    statuses: [
      {
        context: "CI Evidence",
        state: "success",
        target_url: evidenceRunUrl,
        created_at: "2026-10-02T13:11:43Z",
        ...overrides,
      },
    ],
  };
}

function controlRun(overrides: Record<string, unknown> = {}) {
  return {
    repository: { full_name: controlRepository },
    path: centralRunPath,
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    run_started_at: "2026-10-02T13:10:15Z",
    updated_at: "2026-10-02T13:11:57Z",
    ...overrides,
  };
}

function runReader(runs: Array<unknown | Error>) {
  const requested: string[] = [];
  let index = 0;
  return {
    requested,
    async get(path: string): Promise<unknown> {
      requested.push(path);
      const next = runs[Math.min(index, runs.length - 1)];
      index += 1;
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test("verified CI evidence needs a successful control run of a publishing workflow", async () => {
  const reader = runReader([controlRun()]);
  assert.equal(await hasVerifiedCiEvidence(reader, evidenceStatus(), noDelay), true);
  assert.deepEqual(reader.requested, ["repos/fongap-labs/action-worker/actions/runs/42"]);
  assert.equal(
    await hasVerifiedCiEvidence(
      runReader([controlRun({ path: ".github/workflows/handle-pr-dispatch.yml" })]),
      evidenceStatus(),
      noDelay
    ),
    true
  );
});

test("forged CI evidence pointing at a wrong or unsuccessful run is rejected", async () => {
  const rejected = [
    controlRun({ path: ".github/workflows/validate-ci.yml" }),
    controlRun({ conclusion: "failure" }),
    controlRun({ conclusion: "cancelled" }),
    controlRun({ head_branch: "attacker-branch" }),
    controlRun({ repository: { full_name: "attacker/fork" } }),
    controlRun({ run_started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:01:00Z" }),
    controlRun({ run_started_at: "not a date" }),
    "not-a-run",
  ];
  for (const run of rejected) {
    assert.equal(
      await hasVerifiedCiEvidence(runReader([run]), evidenceStatus(), noDelay),
      false,
      JSON.stringify(run)
    );
  }
});

test("CI evidence with a missing run, wrong prefix, wrong state or no timestamp is rejected", async () => {
  const missing = runReader([new Error("GitHub API returned HTTP 404.")]);
  assert.equal(await hasVerifiedCiEvidence(missing, evidenceStatus(), noDelay), false);

  const untouched = runReader([controlRun()]);
  for (const response of [
    evidenceStatus({ state: "failure" }),
    evidenceStatus({ state: "pending" }),
    evidenceStatus({ target_url: "https://example.invalid/runs/42" }),
    evidenceStatus({ target_url: "https://github.com/fongap-labs/other/actions/runs/42" }),
    evidenceStatus({ created_at: undefined }),
    { statuses: [] },
  ]) {
    assert.equal(await hasVerifiedCiEvidence(untouched, response, noDelay), false);
  }
  assert.deepEqual(untouched.requested, []);

  await assert.rejects(
    hasVerifiedCiEvidence(
      runReader([new Error("GitHub API returned HTTP 500.")]),
      evidenceStatus(),
      noDelay
    ),
    /HTTP 500/
  );
});

test("CI evidence waits for a run that is still finishing and fails closed if it never ends", async () => {
  const settling = runReader([
    controlRun({ status: "in_progress", conclusion: null }),
    controlRun(),
  ]);
  assert.equal(await hasVerifiedCiEvidence(settling, evidenceStatus(), noDelay), true);
  assert.equal(settling.requested.length, 2);

  const stuck = runReader([controlRun({ status: "in_progress", conclusion: null })]);
  assert.equal(
    await hasVerifiedCiEvidence(stuck, evidenceStatus(), { ...noDelay, runAttempts: 3 }),
    false
  );
  assert.equal(stuck.requested.length, 3);
});

test("requiring CI evidence on a commit polls the status and fails closed", async () => {
  const sha = "a".repeat(40);
  const statusPath = `repos/fongap/example/commits/${sha}/status`;
  const responses = [{ statuses: [] }, evidenceStatus({ state: "pending" }), evidenceStatus()];
  let statusCalls = 0;
  const reader = {
    async get(path: string): Promise<unknown> {
      if (path === statusPath) {
        statusCalls += 1;
        return responses[Math.min(statusCalls - 1, responses.length - 1)];
      }
      return controlRun();
    },
  };
  await requireVerifiedCiEvidence(reader, "fongap/example", sha, { ...noDelay, statusAttempts: 5 });
  assert.equal(statusCalls, 3);

  statusCalls = 0;
  await assert.rejects(
    requireVerifiedCiEvidence(reader, "fongap/example", sha, { ...noDelay, statusAttempts: 2 }),
    /no successful Action Worker CI Evidence/
  );

  const failed = { get: async () => evidenceStatus({ state: "failure" }) };
  await assert.rejects(
    requireVerifiedCiEvidence(failed, "fongap/example", sha, { ...noDelay, statusAttempts: 5 }),
    /failed CI Evidence/
  );

  const forged = {
    get: async (path: string) =>
      path === statusPath ? evidenceStatus() : controlRun({ conclusion: "failure" }),
  };
  await assert.rejects(
    requireVerifiedCiEvidence(forged, "fongap/example", sha, noDelay),
    /not produced by a successful Action Worker CI run/
  );
});

test("a CI evidence failure names the run to open and the next step", async () => {
  const sha = "a".repeat(40);
  const failed = { get: async () => evidenceStatus({ state: "failure" }) };
  await assert.rejects(
    requireVerifiedCiEvidence(failed, "fongap/example", sha, noDelay),
    (error: Error) =>
      error.message.includes(evidenceRunUrl) &&
      error.message.includes("fix it through a pull request")
  );

  const missing = { get: async () => ({ statuses: [] }) };
  await assert.rejects(
    requireVerifiedCiEvidence(missing, "fongap/example", sha, noDelay),
    (error: Error) =>
      error.message.includes("fongap/example@aaaaaaaaaaaa") &&
      error.message.includes("run the CI Intake workflow")
  );
});

test("task source, release and deploy gates wait for central CI with one shared window", () => {
  assert.deepEqual(centralCiWait, { statusAttempts: 120, retryDelayMs: 10_000 });
  for (const file of [
    "scripts/validate-task-source.ts",
    "scripts/validate-release-build-request.ts",
    "scripts/validate-deploy-source.ts",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /centralCiWait/, `${file} waits with the shared window`);
    assert.match(source, /requireVerifiedCiEvidence\(/, `${file} verifies the evidence run`);
  }
});

test("the PR gate rejects a success status that no successful control run produced", async () => {
  const ci = { status_context: "CI Evidence" };
  const statusPath = `repos/fongap-labs/target/commits/${"a".repeat(40)}/status`;
  const reader = (run: unknown) => ({
    async get(path: string): Promise<unknown> {
      return path === statusPath ? evidenceStatus() : run;
    },
  });
  await waitForCentralStatus(
    "fongap-labs/target",
    "a".repeat(40),
    ci,
    reader(controlRun()),
    controlRepository,
    5,
    1
  );
  await assert.rejects(
    waitForCentralStatus(
      "fongap-labs/target",
      "a".repeat(40),
      ci,
      reader(controlRun({ path: ".github/workflows/validate-ci.yml" })),
      controlRepository,
      5,
      1
    ),
    /not produced by a successful Action Worker CI run/
  );
});
