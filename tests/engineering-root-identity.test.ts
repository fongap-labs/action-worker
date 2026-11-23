import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseOwnershipPolicy } from "../scripts/central-engineering-gate.ts";
import {
  checkGithubEngineeringOwnership,
  verifyPinnedIdenticalRoot,
} from "../scripts/engineering-gate-api.ts";

const repository = "fongap-labs/delta";
const root = "a199379ac6cdf3ad3bddc8c1f2874cbd1b818f25";
const previouslyVerified = "2561c645d713b425eda6926767661339ed505acf";
const tree = "eddd162bde302b75fb7956ed2681d0e50b4df128";
const prefix = ["repos", repository, "git", "commits"].join("/") + "/";
const rootCommit = { sha: root, parents: [], tree: { sha: tree } };
const priorCommit = {
  sha: previouslyVerified,
  parents: [{ sha: "c".repeat(40) }],
  tree: { sha: tree },
};
const policy = parseOwnershipPolicy(
  JSON.parse(readFileSync("policies/engineering-ownership.json", "utf8")) as unknown
);

function reader(
  current: unknown = rootCommit,
  prior: unknown = priorCommit,
  requested: string[] = []
) {
  return async (path: string): Promise<unknown> => {
    requested.push(path);
    if (path === prefix + root) return current;
    if (path === prefix + previouslyVerified) return prior;
    throw new Error("Unexpected unverified revision read");
  };
}

test("an exact verified public root can reenter the full central CI pipeline", async () => {
  const requested: string[] = [];
  await checkGithubEngineeringOwnership(
    repository,
    root,
    root,
    policy,
    reader(rootCommit, priorCommit, requested),
    (path) => readFileSync(path, "utf8"),
    async () => {
      throw new Error("An identical tree must not fetch an unbounded diff");
    },
    true
  );
  assert.deepEqual(requested.sort(), [prefix + root, prefix + previouslyVerified].sort());
});

test("changed root, forged parent, changed baseline and malformed identity fail closed", async () => {
  for (const [current, prior] of [
    [{ ...rootCommit, tree: { sha: "b".repeat(40) } }, priorCommit],
    [{ ...rootCommit, sha: "b".repeat(40) }, priorCommit],
    [{ ...rootCommit, parents: [{ sha: "b".repeat(40) }] }, priorCommit],
    [rootCommit, { ...priorCommit, tree: { sha: "b".repeat(40) } }],
    [rootCommit, { ...priorCommit, parents: [] }],
  ] as const) {
    await assert.rejects(
      verifyPinnedIdenticalRoot(repository, root, root, reader(current, prior), true),
      /not verified/
    );
  }
});

test("unapproved roots and private sources never inherit a previous verdict", async () => {
  for (const [target, revision, isPublic] of [
    [repository, "b".repeat(40), true],
    ["fongap-labs/mcp-hub", root, true],
    [repository, root, false],
  ] as const) {
    await assert.rejects(
      checkGithubEngineeringOwnership(
        target,
        revision,
        revision,
        policy,
        async () => {
          throw new Error("Rejected roots must not fetch source");
        },
        (path) => readFileSync(path, "utf8"),
        async () => [],
        isPublic
      ),
      /no approved verified-root baseline/
    );
  }
});
