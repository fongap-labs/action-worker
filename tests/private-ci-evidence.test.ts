import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  fetchAndVerifyPrivateCiEvidence,
  fetchAndVerifyPrivateCiForPull,
  isApprovedPrivateCiBootstrap,
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

test("native CI acceptance binds private repo, PR and exact merge parents", async () => {
  const { runs, jobs } = fixture();
  const mergeSha = "d".repeat(40);
  const callerContent = await readFile("templates/bridge/private-source-ci.yml", "utf8");
  const callerPath = `repos/${identity.repository}/contents/.github/workflows/private-source-ci.yml?ref=${identity.baseSha}`;
  const runPath = `repos/${identity.repository}/actions/workflows/private-source-ci.yml/runs?event=pull_request_target&head_sha=${identity.headSha}&per_page=100`;
  const jobsPath = `repos/${identity.repository}/actions/runs/99/jobs?per_page=100&filter=latest`;
  const request = {
    repository: identity.repository,
    prNumber: identity.prNumber,
    baseSha: identity.baseSha,
    headSha: identity.headSha,
    mergeSha,
    linuxShards: identity.linuxShards,
    hasWindows: identity.hasWindows,
  };
  const values = new Map<string, unknown>([
    [`repos/${identity.repository}`, { private: true, full_name: identity.repository }],
    [
      `repos/${identity.repository}/pulls/${identity.prNumber}`,
      {
        number: identity.prNumber,
        state: "open",
        base: { ref: "main", sha: identity.baseSha, repo: { full_name: identity.repository } },
        head: {
          sha: identity.headSha,
          ref: identity.headBranch,
          repo: { full_name: identity.repository },
        },
      },
    ],
    [
      `repos/${identity.repository}/git/commits/${mergeSha}`,
      { sha: mergeSha, parents: [{ sha: identity.baseSha }, { sha: identity.headSha }] },
    ],
    [
      callerPath,
      {
        path: ".github/workflows/private-source-ci.yml",
        type: "file",
        encoding: "base64",
        content: Buffer.from(callerContent).toString("base64"),
      },
    ],
    [runPath, runs],
    [jobsPath, jobs],
  ]);
  const reader = { get: async (path: string): Promise<unknown> => values.get(path) };
  assert.deepEqual(await fetchAndVerifyPrivateCiForPull(reader, request), {
    runId: 99,
    runAttempt: 1,
  });

  const repos = values.get(`repos/${identity.repository}`) as {
    private: boolean;
    full_name: string;
  };
  const pull = values.get(`repos/${identity.repository}/pulls/${identity.prNumber}`) as {
    state: string;
    base: { ref: string; sha: string; repo: { full_name: string } };
    head: { sha: string; ref: string; repo: { full_name: string } };
  };
  const merge = values.get(`repos/${identity.repository}/git/commits/${mergeSha}`) as {
    sha: string;
    parents: Array<{ sha: string }>;
  };
  const invalids: Array<() => void> = [
    () => {
      pull.base.ref = "dev";
    },
    () => {
      repos.private = false;
    },
    () => {
      pull.state = "closed";
    },
    () => {
      pull.head.repo.full_name = "outside/fork";
    },
    () => {
      pull.base.sha = "c".repeat(40);
    },
    () => {
      merge.parents[0]!.sha = "c".repeat(40);
    },
    () => {
      merge.parents.reverse();
    },
  ];
  for (const mutate of invalids) {
    const repoBefore = structuredClone(repos);
    const pullBefore = structuredClone(pull);
    const mergeBefore = structuredClone(merge);
    mutate();
    await assert.rejects(fetchAndVerifyPrivateCiForPull(reader, request));
    Object.assign(repos, repoBefore);
    Object.assign(pull, pullBefore);
    Object.assign(merge, mergeBefore);
  }
});

test("private dev run title cannot reuse a main result at identical SHAs", () => {
  const { runs, jobs } = fixture();
  const dev = { ...identity, targetBranch: "dev" as const };
  assert.throws(() => verifyPrivateCiEvidence(dev, runs, jobs));
  const run = runs.workflow_runs[0]!;
  run.name = run.name.replace("private-ci-", "private-ci-dev-");
  run.display_title = run.name;
  assert.deepEqual(verifyPrivateCiEvidence(dev, runs, jobs), { runId: 99, runAttempt: 1 });
  assert.throws(() => verifyPrivateCiEvidence(identity, runs, jobs));
});

test("private dev caller initialization admits only the exact metadata snapshot", async () => {
  const { repository, prNumber, baseSha, headSha } = identity;
  const root = `repos/${repository}`;
  const caller = ".github/workflows/private-source-ci.yml";
  const template = await readFile("templates/bridge/private-source-ci.yml", "utf8");
  const oldLog = "# 更新日志\n\n## [Unreleased]\n\n";
  const newLog = oldLog.replace("## [Unreleased]\n", "## [Unreleased]\n\n- 维护: 初始化中央批准的私有源码持续集成调用入口。\n");
  const mergeSha = "d".repeat(40);
  const treeSha = "e".repeat(40);
  const file = (path: string, content: string) => ({
    path, type: "file", encoding: "base64", content: Buffer.from(content).toString("base64")
  });
  const pull = {
    number: prNumber, state: "open", author_association: "OWNER",
    base: { ref: "dev", sha: baseSha, repo: { private: true, full_name: repository } },
    head: { ref: "chore/private-ci", sha: headSha, repo: { full_name: repository } },
  };
  const compare = {
    status: "ahead", ahead_by: 1, behind_by: 0, merge_base_commit: { sha: baseSha },
    files: [{ filename: caller, status: "added" }, { filename: "CHANGELOG.md", status: "modified" }],
  };
  const values = new Map<string, unknown>([
    [root, { private: true, full_name: repository }],
    [`${root}/pulls/${prNumber}`, pull],
    [`${root}/compare/${baseSha}...${headSha}`, compare],
    [`${root}/git/commits/${headSha}`, { sha: headSha, tree: { sha: treeSha }, parents: [{ sha: baseSha }] }],
    [`${root}/git/commits/${mergeSha}`, { sha: mergeSha, tree: { sha: treeSha }, parents: [{ sha: baseSha }, { sha: headSha }] }],
    [`${root}/git/trees/${headSha}?recursive=1`, { truncated: false, tree: [caller, "CHANGELOG.md"].map(path => ({ path, type: "blob", mode: "100644" })) }],
    [`${root}/contents/${caller}?ref=${headSha}`, file(caller, template)],
    [`${root}/contents/CHANGELOG.md?ref=${baseSha}`, file("CHANGELOG.md", oldLog)],
    [`${root}/contents/CHANGELOG.md?ref=${headSha}`, file("CHANGELOG.md", newLog)],
  ]);
  const reader = { get: async (path: string): Promise<unknown> => values.get(path) };
  const verify = () => isApprovedPrivateCiBootstrap(reader, repository, prNumber, baseSha, headSha);
  const request = { ...identity, mergeSha, targetBranch: "dev" as const };
  assert.equal(await verify(), true);
  assert.deepEqual(await fetchAndVerifyPrivateCiForPull(reader, request), { bootstrap: true });
  for (const [path, invalid] of [
    [`${root}/compare/${baseSha}...${headSha}`, { ...compare, files: [...compare.files, { filename: "src/index.ts", status: "modified" }] }],
    [`${root}/contents/${caller}?ref=${headSha}`, file(caller, template + "# modified")],
    [`${root}/contents/CHANGELOG.md?ref=${headSha}`, file("CHANGELOG.md", newLog + "extra")],
    [`${root}/contents/${caller}?ref=${baseSha}`, file(caller, "unapproved")],
    [`${root}/pulls/${prNumber}`, { ...pull, author_association: "NONE" }],
    [`${root}/pulls/${prNumber}`, { ...pull, base: { ...pull.base, ref: "main" } }],
  ] as const) {
    const original = values.get(path);
    values.set(path, invalid);
    assert.equal(await verify(), false);
    if (original === undefined) values.delete(path);
    else values.set(path, original);
  }
  values.set(`${root}/git/commits/${mergeSha}`, { sha: mergeSha, tree: { sha: "f".repeat(40) }, parents: [{ sha: baseSha }, { sha: headSha }] });
  await assert.rejects(fetchAndVerifyPrivateCiForPull(reader, request));
});
