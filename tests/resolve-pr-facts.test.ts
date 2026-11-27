import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasManagedPullHead,
  isGovernedPullDirection,
  isManagedTransferDirection,
  legacyDevIntakeWake,
  resolvePullDiffBaseSha,
} from "../scripts/resolve-pr-facts.ts";

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

test("legacy bridge notifications can only wake intake for open public same-repository dev PRs", () => {
  const pull = {
    state: "open",
    base: { ref: "dev", repo: { private: false, full_name: repository } },
    head: { ref: "fix/issue", sha: "a".repeat(40), repo: { full_name: repository } },
  };
  assert.equal(legacyDevIntakeWake(pull, repository), true);
  assert.equal(legacyDevIntakeWake({ ...pull, state: "closed" }, repository), false);
  assert.equal(
    legacyDevIntakeWake({ ...pull, base: { ...pull.base, ref: "main" } }, repository),
    false
  );
  assert.equal(
    legacyDevIntakeWake(
      { ...pull, base: { ...pull.base, repo: { ...pull.base.repo, private: true } } },
      repository
    ),
    false
  );
  for (const ref of ["main", "dev", ""]) {
    assert.equal(legacyDevIntakeWake({ ...pull, head: { ...pull.head, ref } }, repository), false);
  }
  assert.equal(
    legacyDevIntakeWake(
      { ...pull, head: { ...pull.head, repo: { full_name: "other/fork" } } },
      repository
    ),
    false
  );
  assert.equal(
    legacyDevIntakeWake({ ...pull, head: { ...pull.head, sha: "invalid" } }, repository),
    false
  );
});

test("managed transfers never enter ordinary governance", () => {
  const repo = { full_name: repository };
  for (const [source, target] of [
    ["dev", "main"],
    ["main", "dev"],
  ]) {
    const pull = {
      head: { ref: source, repo },
      base: { ref: target, repo },
    };
    assert.equal(hasManagedPullHead(pull), true);
    assert.equal(isManagedTransferDirection(pull, repository), true);
    assert.equal(isGovernedPullDirection(pull, target), false);
    assert.equal(
      isManagedTransferDirection(
        { ...pull, head: { ...pull.head, repo: { full_name: "other/fork" } } },
        repository
      ),
      false
    );
  }
  assert.equal(hasManagedPullHead({ head: { ref: "fix/example" } }), false);
});
