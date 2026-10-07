import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluatePrTrust } from "../scripts/pr-trust.ts";

const headSha = "a".repeat(40);
const olderSha = "c".repeat(40);

function pull(association: string, author = "contributor"): Record<string, unknown> {
  return {
    author_association: association,
    user: { login: author },
    head: { sha: headSha, repo: { full_name: `${author}/example` } },
  };
}

function review(
  reviewer: string,
  state: string,
  options: { association?: string; commit?: string } = {}
): Record<string, unknown> {
  return {
    user: { login: reviewer },
    state,
    author_association: options.association ?? "MEMBER",
    commit_id: options.commit ?? headSha,
  };
}

test("an author with write access is trusted without review", () => {
  for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    assert.deepEqual(evaluatePrTrust(pull(association), [], headSha), {
      trusted: true,
      basis: "author",
      association,
    });
  }
});

test("an outside author is untrusted until a maintainer approves the current head", () => {
  for (const association of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE"]) {
    assert.equal(evaluatePrTrust(pull(association), [], headSha).trusted, false);
  }
  assert.deepEqual(
    evaluatePrTrust(pull("CONTRIBUTOR"), [review("maintainer", "APPROVED")], headSha),
    { trusted: true, basis: "approval", association: "CONTRIBUTOR" }
  );
});

test("approval of an earlier commit does not carry over to a new push", () => {
  const decision = evaluatePrTrust(
    pull("CONTRIBUTOR"),
    [review("maintainer", "APPROVED", { commit: olderSha })],
    headSha
  );
  assert.equal(decision.trusted, false);
});

test("only a trusted reviewer other than the author can approve", () => {
  assert.equal(
    evaluatePrTrust(
      pull("CONTRIBUTOR"),
      [review("someone", "APPROVED", { association: "CONTRIBUTOR" })],
      headSha
    ).trusted,
    false
  );
  assert.equal(
    evaluatePrTrust(
      pull("CONTRIBUTOR", "Contributor"),
      [review("contributor", "APPROVED", { association: "COLLABORATOR" })],
      headSha
    ).trusted,
    false
  );
});

test("a reviewer's later decisive review replaces their approval; comments do not", () => {
  assert.equal(
    evaluatePrTrust(
      pull("NONE"),
      [review("maintainer", "APPROVED"), review("maintainer", "CHANGES_REQUESTED")],
      headSha
    ).trusted,
    false
  );
  assert.equal(
    evaluatePrTrust(
      pull("NONE"),
      [review("maintainer", "APPROVED"), review("maintainer", "DISMISSED")],
      headSha
    ).trusted,
    false
  );
  assert.equal(
    evaluatePrTrust(
      pull("NONE"),
      [review("maintainer", "APPROVED"), review("maintainer", "COMMENTED")],
      headSha
    ).trusted,
    true
  );
});

test("trust evaluation refuses a head that moved after dispatch", () => {
  assert.throws(() => evaluatePrTrust(pull("OWNER"), [], olderSha), /PR head changed/);
  assert.throws(() => evaluatePrTrust(pull("OWNER"), [], "main"), /full commit SHA/);
});

function dependabotPull(
  options: { private?: boolean; headRepository?: string; type?: string } = {}
): Record<string, unknown> {
  return {
    author_association: "NONE",
    user: { login: "dependabot[bot]", type: options.type ?? "Bot" },
    head: { sha: headSha, repo: { full_name: options.headRepository ?? "fongap-labs/example" } },
    base: { repo: { full_name: "fongap-labs/example", private: options.private ?? false } },
  };
}

test("a Dependabot pull request from the same public repository needs no approval", () => {
  assert.deepEqual(evaluatePrTrust(dependabotPull(), [], headSha), {
    trusted: true,
    basis: "dependency-bot",
    association: "NONE",
  });
});

test("a Dependabot pull request still waits for approval in a private or foreign repository", () => {
  for (const pull of [
    dependabotPull({ private: true }),
    dependabotPull({ headRepository: "someone/example" }),
    dependabotPull({ type: "User" }),
  ]) {
    assert.equal(evaluatePrTrust(pull, [], headSha).trusted, false);
  }
  assert.equal(
    evaluatePrTrust(dependabotPull({ private: true }), [review("maintainer", "APPROVED")], headSha)
      .trusted,
    true
  );
});
