import assert from "node:assert/strict";
import { test } from "node:test";
import { isGovernedPullDirection, resolvePullDiffBaseSha } from "../scripts/resolve-pr-facts.ts";

const repository = "fongap-labs/app-source";

test("PR governance only attests feature branches targeting main", () => {
  const valid = { base: { ref: "main" }, head: { ref: "fix/issue" } };
  assert.equal(isGovernedPullDirection(valid), true);
  assert.equal(isGovernedPullDirection({ base: { ref: "main" }, head: { ref: "main" } }), false);
  assert.equal(isGovernedPullDirection({ base: { ref: "main" }, head: { ref: "dev" } }), false);
  assert.equal(isGovernedPullDirection({ base: { ref: "dev" }, head: { ref: "main" } }), false);
  assert.equal(
    isGovernedPullDirection({ base: { ref: "dev" }, head: { ref: "feat/example" } }),
    false
  );
  assert.equal(
    isGovernedPullDirection({ base: { ref: "fix/issue" }, head: { ref: "main" } }),
    false
  );
  assert.equal(
    isGovernedPullDirection({ base: { ref: "release" }, head: { ref: "fix/issue" } }),
    false
  );
  assert.equal(isGovernedPullDirection({ base: { ref: "main" }, head: {} }), false);
  assert.equal(isGovernedPullDirection(null), false);
});

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

test("dev CI direction is explicit and cannot authorize branch transfers", () => {
  const dev = { base: { ref: "dev" }, head: { ref: "feat/example" } };
  assert.equal(isGovernedPullDirection(dev), false);
  assert.equal(isGovernedPullDirection(dev, "dev"), true);
  for (const ref of ["main", "dev", ""]) {
    assert.equal(isGovernedPullDirection({ ...dev, head: { ref } }, "dev"), false);
  }
});
