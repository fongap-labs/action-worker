import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertBranchDeployEnvironment,
  assertBranchReleaseTag,
  assertBranchReleaseVersion,
  assertMainPublicationBranch,
  branchReleaseArtifactName,
  resolveOrdinaryDevelopmentBranch,
} from "../scripts/branch-publication-policy.ts";
import { GithubHttpError } from "../scripts/github-api.ts";

test("ordinary development selects the live dev branch and never falls back on errors", async () => {
  const repository = "fongap-labs/example";
  const policy = { dev_merge_mode: "automatic", dev_disabled_repositories: [] };
  const snapshot = (name: string) => ({
    name,
    commit: { sha: "a".repeat(40), commit: { tree: { sha: "b".repeat(40) } } },
  });
  const reader = (dev: unknown) => async (path: string) => {
    if (path.endsWith("/main")) return snapshot("main");
    assert.equal(path, "repos/" + repository + "/branches/dev");
    if (dev instanceof Error) throw dev;
    return dev;
  };
  assert.equal(
    (await resolveOrdinaryDevelopmentBranch(reader(snapshot("dev")), repository, policy)).branch,
    "dev"
  );
  assert.equal(
    (await resolveOrdinaryDevelopmentBranch(reader(new GithubHttpError(404)), repository, policy))
      .branch,
    "main"
  );
  for (const value of [
    new GithubHttpError(403),
    new GithubHttpError(429),
    snapshot("wrong"),
    null,
  ]) {
    await assert.rejects(resolveOrdinaryDevelopmentBranch(reader(value), repository, policy));
  }
  await assert.rejects(
    resolveOrdinaryDevelopmentBranch(reader(snapshot("dev")), repository, {
      ...policy,
      dev_disabled_repositories: [repository],
    }),
    /Existing dev is disabled/
  );
});

test("release version and prerelease identity must match the managed branch", () => {
  assert.doesNotThrow(() => assertBranchReleaseVersion("main", "v1.2.3", false));
  assert.doesNotThrow(() => assertBranchReleaseVersion("main", "1.2.3.4", false));
  assert.doesNotThrow(() => assertBranchReleaseVersion("dev", "1.2.3-beta.1", true));
  for (const [branch, version, prerelease] of [
    ["main", "1.2.3-beta.1", true],
    ["main", "1.2.3-beta.1", false],
    ["main", "1.2.3", true],
    ["dev", "1.2.3", false],
    ["dev", "1.2.3-beta.1", false],
    ["dev", "1.2.3-beta.0", true],
    ["dev", "1.2.3-rc.1", true],
    ["other", "1.2.3", false],
  ] as const) {
    assert.throws(() => assertBranchReleaseVersion(branch, version, prerelease));
  }
});

test("production and beta destinations are disjoint; existing execution remains main-only", () => {
  assert.doesNotThrow(() => assertBranchDeployEnvironment("main", "production"));
  assert.doesNotThrow(() => assertBranchDeployEnvironment("dev", "beta"));
  for (const [branch, environment] of [
    ["main", "beta"],
    ["dev", "production"],
    ["main", "staging"],
    ["other", "production"],
    ["dev", ""],
  ] as const) {
    assert.throws(() => assertBranchDeployEnvironment(branch, environment));
  }
  assert.doesNotThrow(() => assertMainPublicationBranch("main"));
  for (const branch of ["dev", "master", ""]) {
    assert.throws(() => assertMainPublicationBranch(branch));
  }
});

test("Beta build artifacts cannot use the formal artifact namespace", () => {
  assert.equal(branchReleaseArtifactName("main", "example"), "example");
  assert.equal(branchReleaseArtifactName("dev", "example"), "dev-beta-example");
  assert.throws(() => branchReleaseArtifactName("main", "dev-beta-example"));
  assert.throws(() => branchReleaseArtifactName("dev", "x".repeat(128)));
});

test("actual tag and version must match the verified branch before publication", () => {
  const key = "delta";
  assert.doesNotThrow(() => assertBranchReleaseTag("main", key, "1.2.3", false, "delta-v1.2.3"));
  assert.doesNotThrow(() =>
    assertBranchReleaseTag("dev", key, "1.2.3-beta.1", true, "delta-v1.2.3-beta.1")
  );
  for (const [branch, version, prerelease, tag] of [
    ["main", "1.2.3", false, "delta-v1.2.3-beta.1"],
    ["dev", "1.2.3-beta.1", true, "delta-v1.2.3"],
    ["dev", "1.2.3-beta.1", true, "delta-v1.2.3-beta.2"],
    ["main", "1.2.3", false, "other-v1.2.3"],
    ["main", "1.2.3-beta.1", true, "delta-v1.2.3-beta.1"],
    ["dev", "1.2.3", false, "delta-v1.2.3"],
  ] as const) {
    assert.throws(() => assertBranchReleaseTag(branch, key, version, prerelease, tag));
  }
});
