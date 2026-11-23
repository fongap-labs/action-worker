import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseOwnershipPolicy } from "../scripts/central-engineering-gate.ts";
import {
  deltaCleanRootSha,
  deltaCleanRootTreeSha,
  isDeltaCleanRootTarget,
  verifyDeltaCleanRootCheckout,
  verifyDeltaCleanRootCommit,
} from "../scripts/delta-clean-root.ts";
import { checkGithubEngineeringOwnership } from "../scripts/engineering-gate-api.ts";
import type { GithubReader } from "../scripts/github-api.ts";
import { validateMainWriteProvenance } from "../scripts/main-write-guard.ts";

const repository = "fongap-labs/delta";
const root = { sha: deltaCleanRootSha, parents: [], tree: { sha: deltaCleanRootTreeSha } };
const restRoot = {
  sha: deltaCleanRootSha,
  parents: [],
  commit: { tree: { sha: deltaCleanRootTreeSha } },
};

test("the clean Delta root is pinned to its exact repository, SHA, tree and zero parents", () => {
  assert.equal(isDeltaCleanRootTarget(repository, deltaCleanRootSha), true);
  assert.doesNotThrow(() => verifyDeltaCleanRootCommit(repository, deltaCleanRootSha, root));
  assert.doesNotThrow(() => verifyDeltaCleanRootCommit(repository, deltaCleanRootSha, restRoot));

  for (const invalid of [
    { ...root, sha: "a".repeat(40) },
    { ...root, parents: [{ sha: "a".repeat(40) }] },
    { ...root, tree: { sha: "b".repeat(40) } },
    { ...restRoot, commit: { tree: { sha: "c".repeat(40) } } },
  ]) {
    assert.throws(() => verifyDeltaCleanRootCommit(repository, deltaCleanRootSha, invalid));
  }
  assert.throws(() => verifyDeltaCleanRootCommit("fongap-labs/mcp-hub", deltaCleanRootSha, root));
  assert.throws(() => verifyDeltaCleanRootCommit(repository, "a".repeat(40), root));
});

test("central engineering gate accepts only the exact public initial root", async () => {
  const policy = parseOwnershipPolicy(
    JSON.parse(readFileSync("policies/engineering-ownership.json", "utf8")) as unknown
  );
  const requests: string[] = [];
  await checkGithubEngineeringOwnership(
    repository,
    deltaCleanRootSha,
    deltaCleanRootSha,
    policy,
    async (path) => {
      requests.push(path);
      return root;
    },
    (path) => readFileSync(path, "utf8"),
    async () => {
      throw new Error("No unbounded diff is needed for the exact root");
    },
    true
  );
  assert.deepEqual(requests, ["repos/" + repository + "/git/commits/" + deltaCleanRootSha]);

  await assert.rejects(
    checkGithubEngineeringOwnership(
      repository,
      deltaCleanRootSha,
      deltaCleanRootSha,
      policy,
      async () => root,
      (path) => readFileSync(path, "utf8"),
      async () => [],
      false
    ),
    /no approved verified-root baseline/
  );
});

test("root provenance is recorded as bootstrap, not a fictitious merged PR", async () => {
  const requests: string[] = [];
  const reader = {
    async get(path: string): Promise<unknown> {
      requests.push(path);
      if (path === "repos/" + repository) return { default_branch: "main" };
      if (path === "repos/" + repository + "/commits/" + deltaCleanRootSha) {
        return restRoot;
      }
      throw new Error("Unexpected PR or status evidence read: " + path);
    },
  } as GithubReader;
  const provenance = await validateMainWriteProvenance(reader, repository, deltaCleanRootSha, true);
  assert.deepEqual(provenance, {
    repository,
    main_sha: deltaCleanRootSha,
    pr_number: 0,
    pr_head_sha: deltaCleanRootSha,
    source: "delta-clean-root",
  });
  assert.equal(requests.length, 2);

  await assert.rejects(
    validateMainWriteProvenance(reader, repository, deltaCleanRootSha, true, {
      repositoryValue: { default_branch: "main" },
      mainCommit: { ...restRoot, parents: [{ sha: "a".repeat(40) }] },
    }),
    /identity, parents or tree/
  );
});

test("the bootstrap runner never silently treats an ordinary checkout as the root", async () => {
  await assert.rejects(
    verifyDeltaCleanRootCheckout(repository, deltaCleanRootSha, ""),
    /not an approved target/
  );
  const workflow = readFileSync(".github/workflows/central-ci-sandbox.yml", "utf8");
  assert.match(workflow, /scripts\/delta-clean-root\.ts/);
  assert.match(workflow, /CENTRAL_CI_BASE_SHA.*96d36e875dcd24a28926b9993843ddac9ed11a8f/);
});
