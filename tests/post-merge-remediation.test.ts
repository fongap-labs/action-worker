import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  type PostMergeMainRemediation,
  reconcilePostMergeMainRemediations,
} from "../scripts/post-merge-remediation.ts";
import { prTitleFingerprint } from "../scripts/pr-title-fingerprint.ts";
import { signedStatusDescription } from "../scripts/status-attestation.ts";

const repository = "fongap-labs/example";
const controlRepository = "fongap-labs/action-worker";
const mergeSha = "a".repeat(40);
const headSha = "b".repeat(40);
const currentMain = "c".repeat(40);
const title = "fix(example): document a central capability";
const govUrl = `https://github.com/${controlRepository}/actions/runs/11`;
const ciUrl = `https://github.com/${controlRepository}/actions/runs/12`;
const auditUrl = `https://github.com/${controlRepository}/actions/runs/13`;
const files = ["CHANGELOG.md", "docs/capability.md"];
const oldKeyring = process.env.AW_STATUS_KEYRING;
process.env.AW_STATUS_KEYRING = JSON.stringify({
  schema_version: 1,
  active: "k1",
  keys: { k1: Buffer.alloc(32, 7).toString("base64url") },
  legacy_tokens: [],
});
const caseRecord: PostMergeMainRemediation = {
  repository,
  merge_sha: mergeSha,
  root_incident_sha: mergeSha,
  pr_number: 7,
  approval_issue: 8,
  ci_run_id: 12,
  allowed_changed_files: files,
};

function status(
  sha: string,
  context: string,
  url: string,
  description: string,
  createdAt: string,
  state: "failure" | "success" = "success"
) {
  return {
    context,
    state,
    target_url: url,
    created_at: createdAt,
    description: signedStatusDescription({
      repository,
      sha,
      state,
      context,
      description,
      targetUrl: url,
    }),
  };
}

const mergeTime = "2026-11-19T00:30:00Z";
const headStatuses = [
  status(
    headSha,
    "PR Governance",
    govUrl,
    `title-sha256=${prTitleFingerprint(title)} passed`,
    "2026-11-19T00:29:50Z"
  ),
  status(
    headSha,
    "CI Evidence",
    govUrl,
    "CI not run: the governance plan does not require CI",
    "2026-11-19T00:29:50Z"
  ),
  status(
    headSha,
    "validate-merge",
    govUrl,
    `title-sha256=${prTitleFingerprint(title)} passed`,
    "2026-11-19T00:29:50Z"
  ),
];
const mergedCi = status(
  mergeSha,
  "CI Evidence",
  ciUrl,
  "Central CI passed",
  "2026-11-19T00:31:00Z"
);
const failedGuard = status(
  mergeSha,
  "Main Write Guard",
  auditUrl,
  "Untrusted main write",
  "2026-11-19T00:30:10Z",
  "failure"
);

function fakeReader(overrides: Record<string, unknown> = {}) {
  const response: Record<string, unknown> = {
    [`repos/${repository}/commits/${mergeSha}/status`]: {
      statuses: [failedGuard, mergedCi],
    },
    [`repos/${repository}/compare/${mergeSha}...${currentMain}`]: {
      status: "ahead",
      merge_base_commit: { sha: mergeSha },
    },
    [`repos/${repository}/issues/8`]: {
      state: "closed",
      title: `Main write incident: ${mergeSha.slice(0, 12)}`,
      body: `Main Write Audit rejected ${repository}@${mergeSha}`,
    },
    [`repos/${repository}/issues/8/comments?per_page=100`]: [
      { body: "/resolve", author_association: "MEMBER" },
      {
        body: `/accept-post-merge-ci-remediation ${mergeSha}`,
        author_association: "MEMBER",
      },
    ],
    [`repos/${repository}/pulls/7`]: {
      number: 7,
      state: "closed",
      merged: true,
      merged_at: mergeTime,
      title,
      merge_commit_sha: mergeSha,
      head: { sha: headSha },
      base: { ref: "main" },
      changed_files: files.length,
    },
    [`repos/${repository}/commits/${headSha}/status`]: {
      statuses: headStatuses,
    },
    [`repos/${controlRepository}/actions/runs/11`]: {
      id: 11,
      repository: { full_name: controlRepository },
      path: ".github/workflows/handle-pr-dispatch.yml",
      head_branch: "main",
      event: "repository_dispatch",
      status: "completed",
      conclusion: "success",
      run_started_at: "2026-11-19T00:29:00Z",
      updated_at: "2026-11-19T00:30:01Z",
    },
    [`repos/${repository}/commits/${mergeSha}`]: {
      sha: mergeSha,
      parents: [{ sha: "d".repeat(40) }],
      files: files.map((filename) => ({ filename, status: "modified" })),
    },
    [`repos/${repository}/pulls/7/files?per_page=100`]: files.map((filename) => ({
      filename,
      status: "modified",
    })),
    [`repos/${controlRepository}/actions/runs/12`]: {
      id: 12,
      repository: { full_name: controlRepository },
      path: ".github/workflows/central-ci-dispatch.yml",
      head_branch: "main",
      event: "repository_dispatch",
      status: "completed",
      conclusion: "success",
      run_started_at: "2026-11-19T00:30:20Z",
      updated_at: "2026-11-19T00:31:30Z",
    },
    ...overrides,
  };
  return {
    async get(path: string): Promise<unknown> {
      if (!(path in response)) throw new Error(`Unexpected API read: ${path}`);
      return response[path];
    },
  };
}

function verify(
  reader = fakeReader(),
  record: PostMergeMainRemediation = caseRecord,
  current = currentMain
) {
  const writes: Array<{ context: string; state: string; description: string; sha: string }> = [];
  return {
    writes,
    run: () =>
      reconcilePostMergeMainRemediations(
        reader,
        repository,
        current,
        controlRepository,
        "scoped-token",
        auditUrl,
        [record],
        async (item) => {
          writes.push(item);
        }
      ),
  };
}

test("a resolved and SHA-approved document-only case with genuine post-merge CI is remediated", async () => {
  const { run, writes } = verify();
  assert.deepEqual(await run(), [mergeSha]);
  assert.equal(writes.length, 1);
  assert.deepEqual(
    { sha: writes[0]?.sha, context: writes[0]?.context, state: writes[0]?.state },
    { sha: mergeSha, context: "Main Write Guard", state: "success" }
  );
  assert.match(writes[0]!.description, /Post-merge CI remediation/);
});

test("an existing signed historical success is not rewritten", async () => {
  const restored = status(
    mergeSha,
    "Main Write Guard",
    auditUrl,
    "Post-merge CI remediation PR #7 (incident #8)",
    "2026-11-19T00:31:50Z"
  );
  const { run, writes } = verify(
    fakeReader({
      [`repos/${repository}/commits/${mergeSha}/status`]: {
        statuses: [restored, mergedCi],
      },
    })
  );
  assert.deepEqual(await run(), []);
  assert.deepEqual(writes, []);
});

test("missing or forged evidence cannot produce a remediation status", async () => {
  const invalidCases: Array<[string, Record<string, unknown>]> = [
    [
      "approval missing",
      {
        [`repos/${repository}/issues/8/comments?per_page=100`]: [
          { body: "/resolve", author_association: "MEMBER" },
        ],
      },
    ],
    [
      "untrusted approval",
      {
        [`repos/${repository}/issues/8/comments?per_page=100`]: [
          { body: "/resolve", author_association: "MEMBER" },
          {
            body: `/accept-post-merge-ci-remediation ${mergeSha}`,
            author_association: "NONE",
          },
        ],
      },
    ],
    [
      "unsigned failure",
      {
        [`repos/${repository}/commits/${mergeSha}/status`]: {
          statuses: [{ ...failedGuard, description: "Untrusted main write" }, mergedCi],
        },
      },
    ],
    [
      "missing original skip",
      {
        [`repos/${repository}/commits/${headSha}/status`]: {
          statuses: headStatuses.map((s) =>
            s.context === "CI Evidence"
              ? status(headSha, "CI Evidence", govUrl, "Central CI passed", "2026-11-19T00:29:50Z")
              : s
          ),
        },
      },
    ],
    [
      "central CI failure",
      {
        [`repos/${controlRepository}/actions/runs/12`]: {
          id: 12,
          repository: { full_name: controlRepository },
          path: ".github/workflows/central-ci-dispatch.yml",
          head_branch: "main",
          event: "repository_dispatch",
          status: "completed",
          conclusion: "failure",
          run_started_at: "2026-11-19T00:30:20Z",
          updated_at: "2026-11-19T00:31:30Z",
        },
      },
    ],
    [
      "extra source changes",
      {
        [`repos/${repository}/commits/${mergeSha}`]: {
          sha: mergeSha,
          parents: [{ sha: "d".repeat(40) }],
          files: [
            ...files.map((filename) => ({ filename, status: "modified" })),
            { filename: "src/unsafe.ts", status: "modified" },
          ],
        },
      },
    ],
    [
      "different PR merge",
      {
        [`repos/${repository}/pulls/7`]: {
          number: 7,
          state: "closed",
          merged: true,
          merged_at: mergeTime,
          title,
          merge_commit_sha: "e".repeat(40),
          head: { sha: headSha },
          base: { ref: "main" },
          changed_files: files.length,
        },
      },
    ],
    [
      "CI completed before merge",
      {
        [`repos/${repository}/commits/${mergeSha}/status`]: {
          statuses: [
            failedGuard,
            status(mergeSha, "CI Evidence", ciUrl, "Central CI passed", "2026-11-19T00:29:50Z"),
          ],
        },
      },
    ],
    [
      "wrong CI publisher",
      {
        [`repos/${repository}/commits/${mergeSha}/status`]: {
          statuses: [
            failedGuard,
            status(mergeSha, "CI Evidence", govUrl, "Central CI passed", "2026-11-19T00:31:00Z"),
          ],
        },
      },
    ],
  ];

  for (const [name, overrides] of invalidCases) {
    const { run, writes } = verify(fakeReader(overrides));
    await assert.rejects(
      run(),
      /Post-merge CI remediation denied|Historical main review denied/,
      name
    );
    assert.deepEqual(writes, [], name);
  }
  const { run, writes } = verify(fakeReader(), caseRecord, mergeSha);
  await assert.rejects(run(), /strictly older/);
  assert.deepEqual(writes, []);
});

test("the entire batch is checked before publishing any statuses", async () => {
  const written: unknown[] = [];
  const other: PostMergeMainRemediation = {
    ...caseRecord,
    merge_sha: "e".repeat(40),
    root_incident_sha: "e".repeat(40),
  };
  await assert.rejects(
    reconcilePostMergeMainRemediations(
      fakeReader(),
      repository,
      currentMain,
      controlRepository,
      "token",
      auditUrl,
      [caseRecord, other],
      async (value) => {
        written.push(value);
      }
    ),
    /Unexpected API read|Post-merge CI remediation denied/
  );
  assert.deepEqual(written, []);
});

after(() => {
  if (oldKeyring === undefined) delete process.env.AW_STATUS_KEYRING;
  else process.env.AW_STATUS_KEYRING = oldKeyring;
});
