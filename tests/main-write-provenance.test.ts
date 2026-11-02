import assert from "node:assert/strict";
import { test } from "node:test";
import type { GithubReader } from "../scripts/github-api.ts";
import { validateMainWriteProvenance } from "../scripts/main-write-guard.ts";

const repository = "fongap-labs/dsh-plugin";
const mainSha = "a".repeat(40);
const headSha = "b".repeat(40);
const goodPr = {
  number: 44,
  merged_at: "2026-11-02T16:00:21Z",
  merge_commit_sha: mainSha,
  base: { ref: "main" },
  head: { sha: headSha },
};

function fixture(
  subject: string,
  associated: unknown[],
  hintedPr: unknown = goodPr
): { reader: GithubReader; requests: string[] } {
  const requests: string[] = [];
  const reader = {
    async get(path: string): Promise<unknown> {
      requests.push(path);
      if (path === `repos/${repository}`) return { default_branch: "main" };
      if (path === `repos/${repository}/commits/${mainSha}`) {
        return { sha: mainSha, commit: { message: subject } };
      }
      if (path === `repos/${repository}/commits/${mainSha}/pulls?per_page=100`) {
        return associated;
      }
      if (path === `repos/${repository}/pulls/44`) return hintedPr;
      if (path === `repos/${repository}/commits/${headSha}/check-runs?filter=latest&per_page=100`) {
        return {
          check_runs: [
            {
              name: "validate-merge",
              status: "completed",
              conclusion: "success",
              app: { slug: "github-actions" },
            },
          ],
        };
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  } as GithubReader;
  return { reader, requests };
}

test("squash release commit verifies the exact merged PR when reverse association is empty", async () => {
  const { reader, requests } = fixture("chore(release): dsh-ui-delta-v0.1.0-beta.6 (#44)", []);
  const result = await validateMainWriteProvenance(reader, repository, mainSha, false);
  assert.equal(result.pr_number, 44);
  assert.equal(result.pr_head_sha, headSha);
  assert.equal(requests.filter((path) => path.endsWith("/pulls/44")).length, 1);
});

test("a forged PR number cannot substitute for an exact merge SHA", async () => {
  const { reader } = fixture("fix: direct write pretending to be PR (#44)", [], {
    ...goodPr,
    merge_commit_sha: "c".repeat(40),
  });
  await assert.rejects(
    validateMainWriteProvenance(reader, repository, mainSha, false),
    /not uniquely attributable/
  );
});

test("an unmerged PR cannot satisfy the fallback", async () => {
  const { reader } = fixture("fix: fake merged reference (#44)", [], {
    ...goodPr,
    merged_at: null,
  });
  await assert.rejects(
    validateMainWriteProvenance(reader, repository, mainSha, false),
    /not uniquely attributable/
  );
});

test("direct writes without a verifiable PR reference remain rejected", async () => {
  const { reader, requests } = fixture("fix: direct main write", []);
  await assert.rejects(
    validateMainWriteProvenance(reader, repository, mainSha, false),
    /not uniquely attributable/
  );
  assert.ok(!requests.some((path) => path.endsWith("/pulls/44")));
});

test("existing verified commit associations still work without a fallback", async () => {
  const { reader, requests } = fixture("fix: normal merge", [goodPr]);
  const result = await validateMainWriteProvenance(reader, repository, mainSha, false);
  assert.equal(result.pr_number, 44);
  assert.equal(requests.filter((path) => path.endsWith("/pulls/44")).length, 1);
});

test("ambiguous associations are rejected even if the commit subject includes a PR number", async () => {
  const { reader } = fixture("fix: ambiguous (#44)", [goodPr, goodPr]);
  await assert.rejects(
    validateMainWriteProvenance(reader, repository, mainSha, false),
    /not uniquely attributable/
  );
});
