import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCurrentBaseSha } from "../scripts/resolve-pr-facts.ts";

const repository = "fongap-labs/app-source";

test("PR facts use the live base branch HEAD instead of a stale PR base SHA", () => {
  const pullBase = {
    ref: "main",
    sha: "5a6e1ff12a0f96116ba5927217e5b499afc9020d",
    repo: { full_name: repository },
  };
  const branch = {
    name: "main",
    commit: { sha: "e29a0d094efb50192e831b1815a806641b4e339d" },
  };

  assert.equal(
    resolveCurrentBaseSha(pullBase, branch, repository),
    "e29a0d094efb50192e831b1815a806641b4e339d"
  );
});

test("PR base resolution rejects a base repository outside the requested repository", () => {
  assert.throws(
    () =>
      resolveCurrentBaseSha(
        { ref: "main", repo: { full_name: "other/project" } },
        { commit: { sha: "e29a0d094efb50192e831b1815a806641b4e339d" } },
        repository
      ),
    /base repository does not match/
  );
});

test("PR base resolution rejects a missing or invalid live branch SHA", () => {
  assert.throws(
    () => resolveCurrentBaseSha({ ref: "main", repo: { full_name: repository } }, {}, repository),
    /base branch HEAD SHA is invalid/
  );
});
