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

test("external authors cannot gain central CI execution through a second-person review", () => {
  for (const association of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE"]) {
    assert.equal(evaluatePrTrust(pull(association), [], headSha).trusted, false);
    assert.deepEqual(
      evaluatePrTrust(pull(association), [review("maintainer", "APPROVED")], headSha),
      { trusted: false, basis: "none", association }
    );
    assert.equal(
      evaluatePrTrust(
        pull(association),
        [review("maintainer", "APPROVED", { commit: olderSha })],
        headSha
      ).trusted,
      false
    );
  }
});

test("reviews never turn an untrusted PR into a CI-capable author", () => {
  for (const states of [
    [review("maintainer", "APPROVED")],
    [review("maintainer", "APPROVED"), review("maintainer", "COMMENTED")],
    [review("maintainer", "CHANGES_REQUESTED")],
  ]) {
    assert.equal(evaluatePrTrust(pull("NONE"), states, headSha).trusted, false);
  }
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

function managedAppPull(
  options: { headRepository?: string; baseRepository?: string; type?: string; login?: string } = {}
) {
  return {
    author_association: "CONTRIBUTOR",
    user: { login: options.login ?? "fongap-bot[bot]", type: options.type ?? "Bot" },
    head: {
      sha: headSha,
      repo: { full_name: options.headRepository ?? "fongap-labs/external-vault" },
    },
    base: {
      repo: { full_name: options.baseRepository ?? "fongap-labs/external-vault", private: false },
    },
  };
}

test("the official same-repository fongap-bot app passes deterministic CI without review", () => {
  assert.deepEqual(evaluatePrTrust(managedAppPull(), [], headSha), {
    trusted: true,
    basis: "managed-app",
    association: "CONTRIBUTOR",
  });
  assert.equal(
    evaluatePrTrust(
      managedAppPull({
        baseRepository: "fongap-labs/internal-vault",
        headRepository: "fongap-labs/internal-vault",
      }),
      [],
      headSha
    ).trusted,
    true
  );
});

test("foreign bots, user impersonators and App forks remain untrusted", () => {
  for (const pr of [
    managedAppPull({ login: "other-bot[bot]" }),
    managedAppPull({ type: "User" }),
    managedAppPull({ headRepository: "someone/external-vault" }),
    managedAppPull({
      baseRepository: "someone/external-vault",
      headRepository: "someone/external-vault",
    }),
  ]) {
    assert.equal(evaluatePrTrust(pr, [], headSha).trusted, false);
  }
});

test("a Dependabot pull request from the same public repository needs no approval", () => {
  assert.deepEqual(evaluatePrTrust(dependabotPull(), [], headSha), {
    trusted: true,
    basis: "dependency-bot",
    association: "NONE",
  });
});

test("private and external Dependabot PRs remain blocked even after a review", () => {
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
    false
  );
});
