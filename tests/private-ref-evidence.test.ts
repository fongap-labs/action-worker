import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  fetchAndVerifyPrivateRef,
  type PrivateRefIdentity,
  verifyPrivateRefEvidence,
} from "../scripts/private-ref-evidence.ts";

const identity: PrivateRefIdentity = {
  repository: "fongap-labs/delta-legacy",
  headSha: "b".repeat(40),
  beforeSha: "a".repeat(40),
  linuxShards: ["checks", "desktop"],
  hasWindows: true,
};
const prefix = "Private main source verification / ";

function fixture() {
  const run = {
    id: 101,
    name: `private-ref-${identity.headSha}`,
    display_title: `private-ref-${identity.headSha}`,
    workflow_id: 123,
    path: ".github/workflows/private-ref-ci.yml",
    event: "push",
    head_branch: "main",
    head_sha: identity.headSha,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    repository: { full_name: identity.repository, id: 999 },
  };
  const names = [
    "Verify protected private main and CI plan",
    "Private main security and dependencies",
    "Private main Linux (checks)",
    "Private main Linux (desktop)",
    "Private main Windows",
    "Private main CI complete",
  ];
  const jobs = names.map((name) => ({
    name: prefix + name,
    run_id: run.id,
    status: "completed",
    conclusion: "success",
  }));
  return {
    runs: { total_count: 1, workflow_runs: [run] },
    jobs: { total_count: jobs.length, jobs },
  };
}

test("protected caller template has a single exact source-owned SHA256", async () => {
  const [text, policyText] = await Promise.all([
    readFile("templates/bridge/private-ref-ci.yml", "utf8"),
    readFile("policies/private-ref-callers.json", "utf8"),
  ]);
  const policy = JSON.parse(policyText) as {
    schema_version: number;
    callers: Array<{ repository: string; path: string; sha256: string }>;
  };
  assert.equal(policy.schema_version, 1);
  assert.equal(policy.callers.length, 1);
  assert.equal(policy.callers[0]?.repository, identity.repository);
  assert.equal(policy.callers[0]?.path, ".github/workflows/private-ref-ci.yml");
  assert.equal(createHash("sha256").update(text).digest("hex"), policy.callers[0]?.sha256);
  assert.ok(text.includes("push:"));
  assert.ok(text.includes("branches: [main]"));
  assert.match(text, /private-ref-\$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(text, /secrets\.|workflow_dispatch|pull_request_target|write-all/);
});

test("main evidence requires all exact jobs and rejects unsafe results", () => {
  const x = fixture();
  assert.deepEqual(verifyPrivateRefEvidence(identity, x.runs, x.jobs), {
    runId: 101,
    runAttempt: 1,
  });
  const mutate: Array<(f: ReturnType<typeof fixture>) => void> = [
    (f) => {
      f.runs.workflow_runs[0]!.name = "Private main source CI";
    },
    (f) => {
      f.runs.workflow_runs[0]!.event = "workflow_dispatch";
    },
    (f) => {
      f.runs.workflow_runs[0]!.head_sha = "c".repeat(40);
    },
    (f) => {
      f.runs.workflow_runs[0]!.status = "in_progress";
    },
    (f) => {
      f.runs.workflow_runs[0]!.run_attempt = 0;
    },
    (f) => {
      f.jobs.jobs[2]!.conclusion = "failure";
    },
    (f) => {
      f.jobs.jobs[2]!.conclusion = "skipped";
    },
    (f) => {
      f.jobs.jobs.pop();
      f.jobs.total_count -= 1;
    },
    (f) => {
      f.jobs.jobs.push({ ...f.jobs.jobs[0]!, name: "Unexpected private job" });
      f.jobs.total_count += 1;
    },
  ];
  for (const change of mutate) {
    const f = fixture();
    change(f);
    assert.throws(() => verifyPrivateRefEvidence(identity, f.runs, f.jobs));
  }
});

test("private ref identity requires immutable SHA and trusted current main", async () => {
  const text = await readFile("templates/bridge/private-ref-ci.yml", "utf8");
  const { runs, jobs } = fixture();
  const caller = {
    type: "file",
    path: ".github/workflows/private-ref-ci.yml",
    encoding: "base64",
    content: Buffer.from(text).toString("base64"),
  };
  const urls = new Map<string, unknown>([
    [
      `repos/${identity.repository}`,
      {
        full_name: identity.repository,
        private: true,
        default_branch: "main",
      },
    ],
    [
      `repos/${identity.repository}/git/ref/heads/main`,
      {
        object: { sha: identity.headSha },
      },
    ],
    [
      `repos/${identity.repository}/git/commits/${identity.headSha}`,
      {
        sha: identity.headSha,
        parents: [{ sha: identity.beforeSha }],
      },
    ],
    [
      `repos/${identity.repository}/contents/.github/workflows/private-ref-ci.yml?ref=${identity.headSha}`,
      caller,
    ],
    [
      `repos/${identity.repository}/actions/workflows/private-ref-ci.yml/runs?event=push&head_sha=${identity.headSha}&per_page=100`,
      runs,
    ],
    [`repos/${identity.repository}/actions/runs/101/jobs?per_page=100&filter=latest`, jobs],
  ]);
  const reader = { get: async (url: string): Promise<unknown> => urls.get(url) };
  assert.deepEqual(await fetchAndVerifyPrivateRef(reader, identity), {
    runId: 101,
    runAttempt: 1,
  });
  const repoKey = `repos/${identity.repository}`;
  const currentRepo = urls.get(repoKey) as { private: boolean };
  currentRepo.private = false;
  await assert.rejects(fetchAndVerifyPrivateRef(reader, identity));
  currentRepo.private = true;
  const key = `repos/${identity.repository}/git/ref/heads/main`;
  urls.set(key, { object: { sha: "c".repeat(40) } });
  await assert.rejects(fetchAndVerifyPrivateRef(reader, identity));
  urls.set(key, { object: { sha: identity.headSha } });
  const commitKey = `repos/${identity.repository}/git/commits/${identity.headSha}`;
  urls.set(commitKey, { sha: identity.headSha, parents: [{ sha: "c".repeat(40) }] });
  await assert.rejects(fetchAndVerifyPrivateRef(reader, identity));
  urls.set(commitKey, { sha: identity.headSha, parents: [{ sha: identity.beforeSha }] });
  urls.set(
    `repos/${identity.repository}/contents/.github/workflows/private-ref-ci.yml?ref=${identity.headSha}`,
    { ...caller, content: Buffer.from(`${text}# modified`).toString("base64") }
  );
  await assert.rejects(fetchAndVerifyPrivateRef(reader, identity));
});
