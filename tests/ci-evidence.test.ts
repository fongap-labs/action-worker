import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  centralCiWait,
  completedPrRunReader,
  hasTrustedSuccessfulCiEvidence,
  hasVerifiedCiEvidence,
  hasVerifiedCiFailureStatus,
  hasVerifiedControlStatus,
  latestCiStatus,
  mainWriteGuardWorkflowPaths,
  requireVerifiedCiEvidence,
  trustedCiStatus,
  trustedControlRunId,
  verificationRecorder,
} from "../scripts/ci-evidence.ts";
import { waitForCentralStatus } from "../scripts/wait-ci-evidence.ts";
import { attestFixtureStatuses } from "./attested-status-fixtures.ts";

const controlRepository = "fongap-labs/action-worker";
const targetRepository = "fongap/example";
const targetSha = "a".repeat(40);
const verified = { targetRepository, targetSha };

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
  assert.equal(
    hasTrustedSuccessfulCiEvidence(
      response,
      "CI Evidence",
      controlRepository,
      targetRepository,
      targetSha
    ),
    false
  );
});

test("trusted successful CI evidence is idempotent", () => {
  const response = attestFixtureStatuses(
    {
      statuses: [
        {
          context: "CI Evidence",
          state: "success",
          target_url: "https://github.com/fongap-labs/action-worker/actions/runs/42",
        },
      ],
    },
    targetRepository,
    targetSha
  );
  assert.equal(
    hasTrustedSuccessfulCiEvidence(
      response,
      "CI Evidence",
      controlRepository,
      targetRepository,
      targetSha
    ),
    true
  );
});

const centralRunPath = ".github/workflows/central-ci-dispatch.yml";
const evidenceRunUrl = "https://github.com/fongap-labs/action-worker/actions/runs/42";
const noDelay = { retryDelayMs: 0, ...verified };

function evidenceStatus(overrides: Record<string, unknown> = {}) {
  return attestFixtureStatuses(
    {
      statuses: [
        {
          context: "CI Evidence",
          state: "success",
          target_url: evidenceRunUrl,
          created_at: "2026-10-02T13:11:43Z",
          ...overrides,
        },
      ],
    },
    targetRepository,
    targetSha
  );
}

function controlRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
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
  assert.equal(
    await hasVerifiedCiEvidence(reader, evidenceStatus(), { ...noDelay, ...verified }),
    true
  );
  assert.deepEqual(reader.requested, ["repos/fongap-labs/action-worker/actions/runs/42"]);
  assert.equal(
    await hasVerifiedCiEvidence(
      runReader([controlRun({ path: ".github/workflows/handle-pr-dispatch.yml" })]),
      evidenceStatus(),
      { ...noDelay, ...verified }
    ),
    true
  );
});

test("forged CI evidence pointing at a wrong or unsuccessful run is rejected", async () => {
  const rejected = [
    controlRun({ id: 43 }),
    controlRun({ id: null }),
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
      await hasVerifiedCiEvidence(runReader([run]), evidenceStatus(), { ...noDelay, ...verified }),
      false,
      JSON.stringify(run)
    );
  }
});

test("only a signed failure from a completed central dispatch run counts toward retry limits", async () => {
  const failure = evidenceStatus({
    state: "failure",
    description: `R0:${"f".repeat(62)}`,
    created_at: "2026-10-02T13:11:43Z",
  });
  const trustedFailure = controlRun({ conclusion: "failure", event: "repository_dispatch" });
  assert.equal(
    await hasVerifiedCiFailureStatus(runReader([trustedFailure]), failure.statuses[0], {
      ...noDelay,
      ...verified,
    }),
    true
  );
  for (const run of [
    controlRun({ id: 43, conclusion: "failure", event: "repository_dispatch" }),
    controlRun({ id: null, conclusion: "failure", event: "repository_dispatch" }),
    controlRun({ conclusion: "success", event: "repository_dispatch" }),
    controlRun({ conclusion: "failure", event: "push" }),
    controlRun({ conclusion: "failure", path: ".github/workflows/validate-ci.yml" }),
    controlRun({ conclusion: "failure", head_branch: "attacker" }),
  ]) {
    assert.equal(
      await hasVerifiedCiFailureStatus(runReader([run]), failure.statuses[0], {
        ...noDelay,
        ...verified,
      }),
      false
    );
  }
});

test("CI evidence with a missing run, wrong prefix, wrong state or no timestamp is rejected", async () => {
  const missing = runReader([new Error("GitHub API returned HTTP 404.")]);
  assert.equal(
    await hasVerifiedCiEvidence(missing, evidenceStatus(), { ...noDelay, ...verified }),
    false
  );

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
      { ...noDelay, ...verified }
    ),
    /HTTP 500/
  );
});

test("each verification step reports the step that decided it", async () => {
  const cases: Array<[string, unknown, unknown[]]> = [
    ["status-missing", { statuses: [] }, [controlRun()]],
    ["status-not-success", evidenceStatus({ state: "pending" }), [controlRun()]],
    ["run-not-found", evidenceStatus(), [new Error("GitHub API returned HTTP 404.")]],
    ["run-mismatch", evidenceStatus(), [controlRun({ path: ".github/workflows/validate-ci.yml" })]],
    ["run-not-success", evidenceStatus(), [controlRun({ conclusion: "failure" })]],
    [
      "run-outside-window",
      evidenceStatus(),
      [controlRun({ run_started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:01:00Z" })],
    ],
    ["verified", evidenceStatus(), [controlRun()]],
  ];
  for (const [expected, response, runs] of cases) {
    const steps: string[] = [];
    const verdict = await hasVerifiedControlStatus(runReader(runs), response, "CI Evidence", {
      ...noDelay,
      ...verified,
      trace: (step) => {
        steps.push(step);
      },
    });
    assert.equal(steps.at(-1), expected, JSON.stringify(response));
    assert.equal(verdict, expected === "verified");
  }
});

test("a verification recorder remembers the last step that failed", () => {
  const recorder = verificationRecorder("PR Governance test");
  assert.equal(recorder.lastFailure(), "no verification step ran");
  recorder.trace("run-mismatch", { run_id: 1 });
  recorder.trace("verified", { run_id: 1 });
  assert.equal(recorder.lastFailure(), "run-mismatch");
});

test("CI evidence waits for a run that is still finishing and fails closed if it never ends", async () => {
  const settling = runReader([
    controlRun({ status: "in_progress", conclusion: null }),
    controlRun(),
  ]);
  assert.equal(
    await hasVerifiedCiEvidence(settling, evidenceStatus(), { ...noDelay, ...verified }),
    true
  );
  assert.equal(settling.requested.length, 2);

  const stuck = runReader([controlRun({ status: "in_progress", conclusion: null })]);
  assert.equal(
    await hasVerifiedCiEvidence(stuck, evidenceStatus(), {
      ...noDelay,
      ...verified,
      runAttempts: 3,
    }),
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
      path === statusPath
        ? attestFixtureStatuses(evidenceStatus(), "fongap-labs/target", "a".repeat(40))
        : controlRun({ conclusion: "failure" }),
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
      error.message.includes("Actions > Central CI Dispatch") &&
      error.message.includes("nothing needs to be started by hand")
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
      return path === statusPath
        ? attestFixtureStatuses(evidenceStatus(), "fongap-labs/target", "a".repeat(40))
        : run;
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

test("every control workflow that attests a main write is trusted", () => {
  const workflowDir = ".github/workflows";
  const publishers = readdirSync(workflowDir)
    .filter((name) => name.endsWith(".yml"))
    .filter((name) => {
      const source = readFileSync(`${workflowDir}/${name}`, "utf8");
      return (
        source.includes("scripts/audit-main-writes.ts") ||
        source.includes("scripts/main-write-guard.ts")
      );
    })
    .map((name) => `${workflowDir}/${name}`)
    .sort();
  // Previously completed CI runs continue to attest main writes after follow-ups move away.
  const legacy = ".github/workflows/central-ci-dispatch.yml";
  assert.deepEqual([...publishers, legacy].sort(), [...mainWriteGuardWorkflowPaths].sort());
});

test("a main write attested by a release, intake or guard run is trusted", async () => {
  const status = attestFixtureStatuses(
    {
      statuses: [
        {
          context: "Main Write Guard",
          state: "success",
          target_url: evidenceRunUrl,
          created_at: "2026-10-02T13:11:43Z",
        },
      ],
    },
    targetRepository,
    targetSha
  );
  const options = { ...noDelay, workflowPaths: mainWriteGuardWorkflowPaths };
  for (const path of [
    ".github/workflows/release-app.yml",
    ".github/workflows/intake.yml",
    ".github/workflows/main-write-guard.yml",
  ]) {
    assert.equal(
      await hasVerifiedControlStatus(
        runReader([controlRun({ path })]),
        status,
        "Main Write Guard",
        {
          ...options,
        }
      ),
      true,
      path
    );
  }
  assert.equal(
    await hasVerifiedControlStatus(
      runReader([controlRun({ path: ".github/workflows/validate-ci.yml" })]),
      status,
      "Main Write Guard",
      options
    ),
    false
  );
});

test("release validation supplies the status signing keyring for evidence verification", () => {
  const workflow = readFileSync(".github/workflows/release-app.yml", "utf8");
  const block = workflow.match(
    / {6}- name: Validate release build request\n([\s\S]*?)\n {2}build:/
  );
  assert.ok(block, "release validation job exists");
  assert.match(block[1]!, /AW_STATUS_KEYRING: \$\{\{ secrets\.AW_STATUS_KEYRING \}\}/);
  assert.match(block[1]!, /run: node scripts\/validate-release-build-request\.ts/);
});

test("one main-write verification pass reads a completed PR dispatcher run only once", async () => {
  const status = attestFixtureStatuses(
    {
      statuses: ["PR Governance", "CI Evidence", "validate-merge"].map((context) => ({
        context,
        state: "success",
        target_url: evidenceRunUrl,
        created_at: "2026-10-02T13:11:43Z",
      })),
    },
    targetRepository,
    targetSha
  );
  const source = runReader([controlRun({ path: ".github/workflows/handle-pr-dispatch.yml" })]);
  const scoped = completedPrRunReader(source, controlRepository);
  for (const context of ["PR Governance", "CI Evidence", "validate-merge"]) {
    assert.equal(
      await hasVerifiedControlStatus(scoped, status, context, {
        ...noDelay,
        controlRepository,
        workflowPaths:
          context === "CI Evidence"
            ? [
                ".github/workflows/central-ci-dispatch.yml",
                ".github/workflows/handle-pr-dispatch.yml",
              ]
            : [".github/workflows/handle-pr-dispatch.yml"],
      }),
      true,
      context
    );
  }
  assert.equal(
    source.requested.length,
    1,
    "one authenticated completed run validates three statuses"
  );
  const independent = completedPrRunReader(source, controlRepository);
  await independent.get(`repos/${controlRepository}/actions/runs/42`);
  assert.equal(source.requested.length, 2, "the next verification pass must fetch again");
});

test("running, failed, untrusted, or unrelated runs cannot enter completed PR run reuse", async () => {
  const runPath = `repos/${controlRepository}/actions/runs/42`;
  for (const unsafe of [
    controlRun({ status: "in_progress", conclusion: null }),
    controlRun({ conclusion: "failure" }),
    controlRun({ repository: { full_name: "fongap-labs/other" } }),
    controlRun({ path: ".github/workflows/validate-ci.yml" }),
    controlRun({ head_branch: "feature" }),
  ]) {
    const source = runReader([
      unsafe,
      controlRun({ path: ".github/workflows/handle-pr-dispatch.yml" }),
    ]);
    const scoped = completedPrRunReader(source, controlRepository);
    assert.deepEqual(await scoped.get(runPath), unsafe);
    assert.equal(
      (await scoped.get(runPath)) !== undefined,
      true,
      "the second response can independently establish a completed success"
    );
    assert.equal(source.requested.length, 2);
    await scoped.get(runPath);
    assert.equal(
      source.requested.length,
      2,
      "only the newly verified successful run may be reused"
    );
  }
  const source = runReader([controlRun()]);
  const scoped = completedPrRunReader(source, controlRepository);
  for (const path of [
    `repos/${controlRepository}/actions/runs/42?per_page=1`,
    `repos/${controlRepository}/actions/runs/42/attempts/1`,
    `repos/fongap-labs/other/actions/runs/42`,
  ])
    await scoped.get(path);
  assert.equal(source.requested.length, 3, "non-exact paths never reuse a run");
});

test("completed PR run reuse cannot bypass per-context workflow or signed timestamp checks", async () => {
  const source = runReader([controlRun({ path: ".github/workflows/handle-pr-dispatch.yml" })]);
  const scoped = completedPrRunReader(source, controlRepository);
  assert.equal(
    await hasVerifiedControlStatus(scoped, evidenceStatus(), "CI Evidence", {
      ...noDelay,
      controlRepository,
    }),
    true
  );
  assert.equal(
    await hasVerifiedControlStatus(scoped, evidenceStatus(), "CI Evidence", {
      ...noDelay,
      controlRepository,
      workflowPaths: [".github/workflows/central-ci-dispatch.yml"],
    }),
    false,
    "cached run must still be validated against the required publisher workflow"
  );
  assert.equal(
    await hasVerifiedControlStatus(
      scoped,
      evidenceStatus({ created_at: "2026-12-01T00:00:00Z" }),
      "CI Evidence",
      { ...noDelay, controlRepository }
    ),
    false,
    "cached run cannot satisfy a status outside its real execution window"
  );
  assert.equal(source.requested.length, 1);
});


test("completed PR run cache rejects mismatched response ID and retries independently", async () => {
  const runPath = `repos/${controlRepository}/actions/runs/42`;
  const source = runReader([
    controlRun({ id: 99, path: ".github/workflows/handle-pr-dispatch.yml" }),
    controlRun({ id: 42, path: ".github/workflows/handle-pr-dispatch.yml" }),
  ]);
  const scoped = completedPrRunReader(source, controlRepository);
  const wrong = await scoped.get(runPath);
  assert.equal((wrong as { id: number }).id, 99);
  assert.equal((await scoped.get(runPath) as { id: number }).id, 42);
  assert.equal((await scoped.get(runPath) as { id: number }).id, 42);
  assert.equal(source.requested.length, 2, "only the matching verified run may be reused");
});

test("verified successful control run identity must match the signed status URL", async () => {
  const reader = runReader([controlRun({ id: 43 })]);
  const failures: string[] = [];
  const result = await hasVerifiedCiEvidence(reader, evidenceStatus(), {
    ...noDelay,
    ...verified,
    trace: (step) => failures.push(step),
  });
  assert.equal(result, false);
  assert.equal(failures.at(-1), "run-mismatch");
  assert.equal(reader.requested.length, 1);
});
