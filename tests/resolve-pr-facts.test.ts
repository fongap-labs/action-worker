import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isGovernedPullDirection,
  resolveGovernanceRoute,
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

test("legacy bridge events resolve and pin the live dev target without granting transfers", () => {
  const headSha = "a".repeat(40);
  const repo = { full_name: repository, private: false };
  const pull = {
    state: "open",
    base: { ref: "dev", sha: "b".repeat(40), repo },
    head: { ref: "feat/example", sha: headSha, repo },
  };
  assert.deepEqual(resolveGovernanceRoute(pull, repository, "", ""), {
    targetBranch: "dev",
    headSha,
  });
  assert.deepEqual(resolveGovernanceRoute(pull, repository, "dev", headSha), {
    targetBranch: "dev",
    headSha,
  });
  assert.throws(() => resolveGovernanceRoute(pull, repository, "main", headSha), /not authorized/);
  assert.throws(() => resolveGovernanceRoute(pull, repository, "dev", ""), /current public/);
  assert.throws(
    () => resolveGovernanceRoute(pull, repository, "", "c".repeat(40)),
    /current public/
  );
  for (const ref of ["main", "dev"]) {
    assert.throws(
      () => resolveGovernanceRoute({ ...pull, head: { ...pull.head, ref } }, repository, "", ""),
      /not authorized/
    );
  }
  assert.throws(
    () =>
      resolveGovernanceRoute(
        { ...pull, head: { ...pull.head, repo: { full_name: "outside/fork" } } },
        repository,
        "",
        ""
      ),
    /current public/
  );
  assert.throws(
    () =>
      resolveGovernanceRoute(
        { ...pull, base: { ...pull.base, repo: { ...repo, private: true } } },
        repository,
        "",
        ""
      ),
    /current public/
  );
  assert.deepEqual(
    resolveGovernanceRoute({ ...pull, base: { ...pull.base, ref: "main" } }, repository, "", ""),
    { targetBranch: "main", headSha }
  );
});
