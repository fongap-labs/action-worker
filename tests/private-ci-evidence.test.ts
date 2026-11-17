import assert from "node:assert/strict";
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
    path: ".github/workflows/private-source-ci.yml",
    event: "pull_request_target",
    status: "completed",
    conclusion: "success",
    head_sha: identity.headSha,
    head_branch: identity.headBranch,
    repository: { full_name: identity.repository, id: 42 },
    pull_requests: [
      {
        number: 12,
        head: { sha: identity.headSha, ref: identity.headBranch, repo: { id: 42 } },
        base: { sha: identity.baseSha, ref: "main", repo: { id: 42 } },
      },
    ],
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
      v.runs.workflow_runs[0]!.pull_requests[0]!.base.ref = "dev";
    },
    (v) => {
      v.runs.workflow_runs[0]!.run_attempt = 0;
    },
    (v) => {
      v.runs.workflow_runs[0]!.pull_requests[0]!.base.sha = "c".repeat(40);
    },
    (v) => {
      v.runs.workflow_runs[0]!.pull_requests[0]!.head.repo.id = 99;
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

test("private CI reads only repository-scoped source workflow runs and jobs", async () => {
  const fixtureData = fixture();
  const requests: string[] = [];
  const reader = {
    get: async (path: string): Promise<unknown> => {
      requests.push(path);
      return requests.length === 1 ? fixtureData.runs : fixtureData.jobs;
    },
  };
  const actual = await fetchAndVerifyPrivateCiEvidence(reader, identity);
  assert.deepEqual(actual, { runId: 99, runAttempt: 1 });
  assert.deepEqual(requests, [
    `repos/${identity.repository}/actions/workflows/private-source-ci.yml/runs?event=pull_request_target&head_sha=${identity.headSha}&per_page=100`,
    `repos/${identity.repository}/actions/runs/99/jobs?per_page=100&filter=latest`,
  ]);
});
