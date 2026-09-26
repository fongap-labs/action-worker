import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCiControlDecision } from "../scripts/resolve-ci-control-ref.ts";

const headSha = "a".repeat(40);

function pull(options: {
  association?: string;
  baseRef?: string;
  headRepo?: string;
  headSha?: string;
  state?: string;
} = {}): Record<string, unknown> {
  return {
    state: options.state ?? "open",
    author_association: options.association ?? "MEMBER",
    base: {
      ref: options.baseRef ?? "main",
      sha: "b".repeat(40),
      repo: { full_name: "fongap-labs/example" },
    },
    head: {
      sha: options.headSha ?? headSha,
      repo: { full_name: options.headRepo ?? "fongap-labs/example" },
    },
  };
}

test("normal PRs keep the base branch CI control", () => {
  assert.deepEqual(
    resolveCiControlDecision(
      "fongap-labs/example",
      headSha,
      pull(),
      ["src/index.ts"],
    ),
    {
      candidate_control: false,
      control_changed: false,
      control_ref: "main",
    },
  );
});

test("trusted same-repository CI control changes self-validate at the immutable head", () => {
  for (const path of [
    ".github/execution-manifest.json",
    ".github/scripts/central-ci.sh",
    ".github/scripts/central-ci.ps1",
  ]) {
    assert.deepEqual(
      resolveCiControlDecision(
        "fongap-labs/example",
        headSha,
        pull({ association: "COLLABORATOR" }),
        [path],
      ),
      {
        candidate_control: true,
        control_changed: true,
        control_ref: headSha,
      },
    );
  }
});

test("fork PRs cannot replace trusted CI control", () => {
  assert.throws(
    () => resolveCiControlDecision(
      "fongap-labs/example",
      headSha,
      pull({ headRepo: "outside/fork" }),
      [".github/scripts/central-ci.sh"],
    ),
    /trusted same-repository maintainer PR/,
  );
});

test("untrusted same-repository authors cannot replace CI control", () => {
  assert.throws(
    () => resolveCiControlDecision(
      "fongap-labs/example",
      headSha,
      pull({ association: "CONTRIBUTOR" }),
      [".github/execution-manifest.json"],
    ),
    /trusted same-repository maintainer PR/,
  );
});

test("candidate CI control resolution fails closed on stale head SHA", () => {
  assert.throws(
    () => resolveCiControlDecision(
      "fongap-labs/example",
      headSha,
      pull({ headSha: "c".repeat(40) }),
      [".github/scripts/central-ci.sh"],
    ),
    /head changed/,
  );
});
