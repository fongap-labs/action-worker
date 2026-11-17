import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  fetchAndVerifyPrivateCiEvidence,
  type PrivateCiIdentity,
  verifyPrivateCiEvidence,
} from "../scripts/private-ci-evidence.ts";

const identity: PrivateCiIdentity = {
  repository: "fongap-labs/private-example",
  prNumber: 12,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  headBranch: "fix/private-ci",
  linuxShards: ["checks", "deny"],
  hasWindows: true,
};

function fixture() {
  const run = {
    id: 99,
    run_attempt: 1,
    name: `private-ci-${identity.prNumber}-${identity.baseSha}-${identity.headSha}`,
    workflow_id: 418196779,
    display_title: `private-ci-${identity.prNumber}-${identity.baseSha}-${identity.headSha}`,
    path: ".github/workflows/private-source-ci.yml",
    event: "pull_request_target",
    status: "completed",
    conclusion: "success",
    head_sha: identity.headSha,
    head_branch: identity.headBranch,
    repository: { full_name: identity.repository, id: 42 },
    pull_requests: [],
  };
  const names = [
    "Verify caller and trusted CI plan",
    "Private security and dependency integrity",
    "Private Linux (checks)",
    "Private Linux (deny)",
    "Private Windows",
  ];
  const jobs = names.map((name) => ({
    run_id: 99,
    name: `Private source verification / ${name}`,
    status: "completed",
    conclusion: "success",
  }));
  return {
    runs: { total_count: 1, workflow_runs: [run] },
    jobs: { total_count: 5, jobs },
  };
}

test("private CI verifies an exact caller run and every declared job", () => {
  const { runs, jobs } = fixture();
  assert.deepEqual(verifyPrivateCiEvidence(identity, runs, jobs), {
    runId: 99,
    runAttempt: 1,
  });
});

test("private CI refuses stale, forged, skipped and incomplete evidence", () => {
  type Fixture = ReturnType<typeof fixture>;
  const mutations: Array<(value: Fixture) => void> = [
    (v) => {
      v.runs.workflow_runs[0]!.event = "pull_request";
    },
    (v) => {
      v.runs.workflow_runs[0]!.head_sha = "c".repeat(40);
    },
    (v) => {
      v.runs.workflow_runs[0]!.path = ".github/workflows/untrusted.yml";
    },
    (v) => {
      v.runs.workflow_runs[0]!.display_title =
        `private-ci-13-${identity.baseSha}-${identity.headSha}`;
    },
    (v) => {
      v.runs.workflow_runs[0]!.run_attempt = 0;
    },
    (v) => {
      v.runs.workflow_runs[0]!.workflow_id = 0;
    },
    (v) => {
      v.runs.workflow_runs[0]!.name = "Untrusted workflow";
    },
    (v) => {
      v.runs.workflow_runs[0]!.name = "Private source CI";
    },
    (v) => {
      v.runs.workflow_runs[0]!.name =
        `private-ci-${identity.prNumber}-${identity.baseSha}-${"c".repeat(40)}`;
    },
    (v) => {
      v.runs.workflow_runs[0]!.display_title =
        `private-ci-${identity.prNumber}-${"c".repeat(40)}-${identity.headSha}`;
    },
    (v) => {
      v.runs.workflow_runs[0]!.repository.full_name = "other/repository";
    },
    (v) => {
      v.runs.workflow_runs[0]!.conclusion = "failure";
    },
    (v) => {
      v.runs.workflow_runs[0]!.status = "in_progress";
    },
    (v) => {
      v.runs.total_count = 101;
    },
    (v) => {
      v.jobs.jobs[1]!.conclusion = "skipped";
    },
    (v) => {
      v.jobs.jobs[1]!.conclusion = "failure";
    },
    (v) => {
      v.jobs.jobs[1]!.run_id = 100;
    },
    (v) => {
      v.jobs.jobs.pop();
      v.jobs.total_count = 4;
    },
    (v) => {
      v.jobs.jobs.push(v.jobs.jobs[0]!);
      v.jobs.total_count = 6;
    },
    (v) => {
      v.jobs.total_count = 100;
    },
  ];
  for (const mutate of mutations) {
    const current = structuredClone(fixture());
    mutate(current);
    assert.throws(() => verifyPrivateCiEvidence(identity, current.runs, current.jobs));
  }
});

test("private CI permits a skipped Windows job only when undeclared", () => {
  const data = fixture();
  data.jobs.jobs[4]!.conclusion = "skipped";
  assert.deepEqual(
    verifyPrivateCiEvidence({ ...identity, hasWindows: false }, data.runs, data.jobs),
    { runId: 99, runAttempt: 1 }
  );
  assert.throws(() => verifyPrivateCiEvidence(identity, data.runs, data.jobs));
});

test("private CI rejects stale failures even if an older run passed", () => {
  const data = fixture();
  const stale = structuredClone(data.runs.workflow_runs[0]!);
  stale.id = 100;
  stale.conclusion = "failure";
  data.runs.workflow_runs.push(stale);
  data.runs.total_count = 2;
  assert.throws(() => verifyPrivateCiEvidence(identity, data.runs, data.jobs));
});

test("private CI accepts only the exact audited caller from a protected base SHA", async () => {
  const { runs, jobs } = fixture();
  const callerContent = await readFile("templates/bridge/private-source-ci.yml", "utf8");
  const callerPath = `repos/${identity.repository}/contents/.github/workflows/private-source-ci.yml?ref=${identity.baseSha}`;
  const runPath = `repos/${identity.repository}/actions/workflows/private-source-ci.yml/runs?event=pull_request_target&head_sha=${identity.headSha}&per_page=100`;
  const jobPath = `repos/${identity.repository}/actions/runs/99/jobs?per_page=100&filter=latest`;
  const caller = {
    path: ".github/workflows/private-source-ci.yml",
    type: "file",
    encoding: "base64",
    content: Buffer.from(callerContent).toString("base64"),
  };
  const responses = new Map<string, unknown>([
    [callerPath, caller],
    [runPath, runs],
    [jobPath, jobs],
  ]);
  const reader = {
    get: async (path: string): Promise<unknown> => responses.get(path),
  };
  assert.deepEqual(await fetchAndVerifyPrivateCiEvidence(reader, identity), {
    runId: 99,
    runAttempt: 1,
  });

  for (const invalid of [
    { ...caller, content: Buffer.from(`${callerContent}# altered`).toString("base64") },
    { ...caller, path: ".github/workflows/unknown.yml" },
    { ...caller, type: "dir" },
    { ...caller, encoding: "utf8" },
  ]) {
    await assert.rejects(
      fetchAndVerifyPrivateCiEvidence(
        {
          get: async (path: string): Promise<unknown> =>
            path === callerPath ? invalid : responses.get(path),
        },
        identity
      )
    );
  }
  await assert.rejects(
    fetchAndVerifyPrivateCiEvidence(reader, { ...identity, baseSha: "c".repeat(40) })
  );
});
