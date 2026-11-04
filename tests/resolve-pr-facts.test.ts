import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePullDiffBaseSha } from "../scripts/resolve-pr-facts.ts";

const repository = "fongap-labs/app-source";

test("PR scope keeps the reviewed base when main moves before CI dispatch", () => {
  const pullBase = {
    ref: "main",
    sha: "5a6e1ff12a0f96116ba5927217e5b499afc9020d",
    repo: { full_name: repository },
  };
  assert.equal(
    resolvePullDiffBaseSha(pullBase, repository),
    "5a6e1ff12a0f96116ba5927217e5b499afc9020d"
  );
});

test("PR diff base rejects a different repository", () => {
  assert.throws(
    () =>
      resolvePullDiffBaseSha(
        { ref: "main", sha: "a".repeat(40), repo: { full_name: "other/project" } },
        repository
      ),
    /base repository does not match/
  );
});

test("PR diff base rejects an invalid SHA", () => {
  assert.throws(
    () => resolvePullDiffBaseSha({ ref: "main", repo: { full_name: repository } }, repository),
    /diff base SHA is invalid/
  );
});
